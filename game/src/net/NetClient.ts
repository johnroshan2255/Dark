import { VEHICLES } from '../gameplay/vehicle/catalogue'
import {
  Action, Flags, Kick, NO_PLAYER, isBot, NO_SPAWN, PROTOCOL_VERSION, RoomFlags, decodeServer, encodeClient, mToCm, mpsToCms, pitchToI16, yawToU16, cmToM, u16ToYaw,
  type ServerMsg,
} from './protocol'
import { BIKE_MODEL } from './RemotePlayers'
import type { Game } from '../game/Game'

/**
 * NET CLIENT — rooms on the DARK server (`server/`, `server/docs/PROTOCOL.md`).
 *
 * Every game you start (endless world or a map) opens a ROOM you own, public unless you made it private; the landing
 * page lists the public rooms and joins any of them (or a private one by its code). Joining a room in another world
 * reloads into it (`?seed=` / `?map=` + `?room=CODE&play=1`). Offline (no server) the game plays on, single-player.
 *
 * Identity: a guest session per browser (token cached in localStorage), with the player's chosen name.
 * In a room: the local pose goes out at SEND_HZ (the car's when driving), snapshots come in for RemotePlayers, a
 * `Correction` puts the player back where the server says; roster, room settings and owner go to the UI store.
 */
const SEND_HZ = 30
const PING_EVERY = 2000
const TIMEOUT_MS = 6000

/** Server base URL: VITE_DARK_SERVER, else this host on port 7350 (dev / LAN). */
export const SERVER_URL: string = (import.meta.env.VITE_DARK_SERVER as string | undefined)?.replace(/\/$/, '') ?? `${location.protocol}//${location.hostname}:7350`

/** A room as the server lists it. */
export interface RoomInfo {
  code: string
  name: string
  kind: 'world' | 'map'
  seed?: number
  map?: string
  players: number
  max_players: number
  private: boolean
  roadkill: boolean
  flying: boolean
  /** Server-run bots. */
  bots: number
  region: string
  age_s: number
}

/** The owner's choices for the room their next game opens (persisted per browser). */
export interface RoomSetup {
  /** Room name ('' = "<you>'s room"). */
  name: string
  private: boolean
  maxPlayers: number
  roadkill: boolean
  flying: boolean
  /** Bots (server-run players, 0–100). */
  bots: number
}

export interface NetPlayer {
  id: number
  name: string
}

export interface NetState {
  /** off: never tried · connecting · online (in a room) · offline (server unreachable / left) */
  status: 'off' | 'connecting' | 'online' | 'offline'
  /** Last problem for the UI (kick reason, server unreachable, room full…). */
  message: string | null
  room: RoomInfo | null
  /** My player id and the room owner's (NO_PLAYER until known). */
  me: number
  owner: number
  players: NetPlayer[]
}

export const DEFAULT_SETUP: RoomSetup = { name: '', private: false, maxPlayers: 100, roadkill: false, flying: true, bots: 12 }
const SETUP_KEY = 'dark.room.setup'
const NAME_KEY = 'dark.player.name'
const SESSION_KEY = 'dark.net.session'

export function loadSetup(): RoomSetup {
  try {
    return { ...DEFAULT_SETUP, ...(JSON.parse(localStorage.getItem(SETUP_KEY) ?? '{}') as Partial<RoomSetup>) }
  } catch {
    return { ...DEFAULT_SETUP }
  }
}

export function loadPlayerName(): string {
  try {
    const n = localStorage.getItem(NAME_KEY)
    if (n) return n
  } catch {
    /* blocked storage */
  }
  return `Player${Math.floor(1000 + Math.random() * 9000)}`
}

class NetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const KICK_TEXT: Record<number, string> = {
  [Kick.BadTicket]: 'Could not join the room (bad ticket)',
  [Kick.VersionMismatch]: 'The game is out of date — reload the page',
  [Kick.MatchFull]: 'The room is full',
  [Kick.MatchOver]: 'The room has closed',
  [Kick.Cheating]: 'Disconnected: impossible movement',
  [Kick.Flooding]: 'Disconnected: too many messages',
  [Kick.Malformed]: 'Disconnected: bad data',
  [Kick.Timeout]: 'Disconnected: connection timed out',
  [Kick.ServerShutdown]: 'The server is restarting',
  [Kick.Duplicate]: 'You are already in this room in another tab',
  [Kick.Kicked]: 'The room owner removed you',
}

export class NetClient {
  private ws: WebSocket | null = null
  private seq = 0
  private epoch = 0
  private sendAcc = 0
  private lastPing = 0
  /** Server clock − performance.now() (smoothed). */
  private clock: number | null = null
  private names = new Map<number, string>()
  private joining = false

  constructor(private readonly game: Game) {}

  private get state(): NetState {
    return this.game.store.get().net
  }
  private set(patch: Partial<NetState>): void {
    this.game.store.set({ net: { ...this.state, ...patch } })
  }

  get online(): boolean {
    return this.state.status === 'online'
  }
  /** Is flying allowed here (not in a room, or the room allows it)? */
  get flyingAllowed(): boolean {
    const r = this.state.room
    return !this.online || !r || r.flying
  }
  get isOwner(): boolean {
    return this.online && this.state.me !== NO_PLAYER && this.state.me === this.state.owner
  }

  // ------------------------------------------------------------ HTTP

  private async api<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (init.auth) headers.authorization = `Bearer ${await this.token()}`
      const r = await fetch(SERVER_URL + path, { ...init, headers, signal: ctl.signal })
      if (r.status === 204) return undefined as T
      const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!r.ok) throw new NetError(body.error ?? String(r.status), body.message ?? r.statusText)
      return body as T
    } catch (e) {
      if (e instanceof NetError) throw e
      throw new NetError('unreachable', 'Multiplayer server unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  /** The guest session (cached; renewed near expiry or when the player renames). */
  private async token(): Promise<string> {
    const name = this.game.store.get().playerName
    try {
      const c = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as { token: string; exp: number; name: string } | null
      if (c && c.name === name && c.exp > Date.now() / 1000 + 120) return c.token
    } catch {
      /* none */
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const r = await fetch(`${SERVER_URL}/v1/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal: ctl.signal })
      if (!r.ok) throw new NetError('auth', 'Could not sign in')
      const s = (await r.json()) as { token: string; expires_in: number; name: string }
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ token: s.token, exp: Date.now() / 1000 + s.expires_in, name }))
      } catch {
        /* private mode */
      }
      return s.token
    } catch (e) {
      throw e instanceof NetError ? e : new NetError('unreachable', 'Multiplayer server unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  async listRooms(): Promise<RoomInfo[]> {
    const r = await this.api<{ rooms: RoomInfo[] }>('/v1/rooms')
    return r.rooms
  }

  /** A room by its code (to decide whether joining needs another world). */
  async peek(code: string): Promise<RoomInfo> {
    return this.api<RoomInfo>(`/v1/rooms/${encodeURIComponent(code.trim().toUpperCase())}`)
  }

  // ------------------------------------------------------------ rooms

  /** Starting to play: open a room for this world with the saved setup (no-op when already in / joining one). */
  async ensureRoom(): Promise<void> {
    if (this.joining || this.ws || this.state.status === 'connecting') return
    // ?net=0: offline (benchmarks / screenshot runs teleport around — the server would correct that as cheating)
    if (new URLSearchParams(location.search).get('net') === '0') return
    const setup = this.game.store.get().roomSetup
    const map = this.game.map
    this.joining = true
    this.set({ status: 'connecting', message: null })
    try {
      const seat = await this.api<SeatRes>('/v1/rooms', {
        method: 'POST',
        auth: true,
        body: JSON.stringify({
          kind: map ? 'map' : 'world',
          seed: map ? undefined : this.game.store.get().seed >>> 0,
          map: map?.id,
          name: setup.name.trim() || undefined,
          private: setup.private,
          max_players: setup.maxPlayers,
          roadkill: setup.roadkill,
          bots: setup.bots,
          flying: setup.flying,
        }),
      })
      this.connect(seat)
      this.game.notify(`Room ${seat.room.code} open · ${seat.room.private ? 'private — share the code' : 'public'}`, 4500)
    } catch (e) {
      this.joining = false
      this.set({ status: 'offline', message: (e as Error).message })
    }
  }

  /** Join the room with this code (the caller made sure this game runs its world). */
  async join(code: string): Promise<boolean> {
    this.leave()
    this.joining = true
    this.set({ status: 'connecting', message: null })
    try {
      const seat = await this.api<SeatRes>(`/v1/rooms/${encodeURIComponent(code.trim().toUpperCase())}/join`, { method: 'POST', auth: true, body: '{}' })
      this.connect(seat)
      return true
    } catch (e) {
      this.joining = false
      const err = e as NetError
      const msg = err.code === 'room_full' ? 'That room is full' : err.code === 'no_room' ? 'No room with that code' : err.code === 'banned' ? 'You were removed from that room' : err.message
      this.set({ status: 'offline', message: msg })
      return false
    }
  }

  /** Owner: change the room's settings. */
  async configure(patch: { name?: string; private?: boolean; max_players?: number; roadkill?: boolean; flying?: boolean; bots?: number }): Promise<void> {
    const room = this.state.room
    if (!room) return
    const r = await this.api<RoomInfo>(`/v1/rooms/${room.code}`, { method: 'PATCH', auth: true, body: JSON.stringify(patch) })
    this.set({ room: r })
  }

  /** Owner: remove a player from the room. */
  async kick(id: number): Promise<void> {
    const room = this.state.room
    if (!room) return
    await this.api(`/v1/rooms/${room.code}/kick`, { method: 'POST', auth: true, body: JSON.stringify({ player_id: id }) })
  }

  /** Leave the room (the game plays on offline). */
  leave(): void {
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeClient({ t: 'leave' }))
        ws.close()
      } catch {
        /* already closed */
      }
    }
    this.game.remotes.clear()
    this.names.clear()
    this.set({ status: this.state.status === 'off' ? 'off' : 'offline', room: null, players: [], me: NO_PLAYER, owner: NO_PLAYER })
  }

  // ------------------------------------------------------------ the session

  private connect(seat: SeatRes): void {
    const ws = new WebSocket(seat.ws_url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.seq = 0
    this.epoch = 0
    this.clock = null
    this.names.clear()
    this.set({ room: seat.room, me: seat.player_id, owner: NO_PLAYER, players: [] })
    ws.onopen = () => ws.send(encodeClient({ t: 'hello', protocol: PROTOCOL_VERSION, ticket: seat.ticket }))
    ws.onmessage = (ev) => {
      if (this.ws !== ws || !(ev.data instanceof ArrayBuffer)) return
      let m: ServerMsg
      try {
        m = decodeServer(new Uint8Array(ev.data))
      } catch {
        return
      }
      this.onMessage(m)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.joining = false
      this.game.remotes.clear()
      this.set({ status: 'offline', room: null, players: [], me: NO_PLAYER, owner: NO_PLAYER, message: this.state.message ?? 'Disconnected from the room' })
    }
  }

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        this.joining = false
        this.set({ status: 'online', me: m.playerId, message: null })
        this.syncClock(m.serverTime)
        if (m.spawn[1] !== NO_SPAWN) this.game.netRelocate(cmToM(m.spawn[0]), cmToM(m.spawn[1]), cmToM(m.spawn[2]), u16ToYaw(m.yaw))
        break
      }
      case 'room': {
        const r = m.room
        const room = this.state.room
        if (room) {
          this.set({
            owner: r.owner,
            room: { ...room, name: r.name, max_players: r.maxPlayers, private: (r.flags & RoomFlags.PRIVATE) !== 0, roadkill: (r.flags & RoomFlags.ROADKILL) !== 0, flying: (r.flags & RoomFlags.FLYING) !== 0, bots: r.bots },
          })
        }
        break
      }
      case 'playerJoined': {
        this.names.set(m.id, m.name)
        this.game.remotes.setName(m.id, m.name)
        this.set({ players: [...this.state.players.filter((p) => p.id !== m.id), { id: m.id, name: m.name }] })
        if (m.id !== this.state.me && this.state.status === 'online' && !isBot(m.id)) this.game.notify(`${m.name} joined`, 2500)
        break
      }
      case 'playerLeft': {
        const name = this.names.get(m.id)
        this.game.remotes.remove(m.id)
        this.set({ players: this.state.players.filter((p) => p.id !== m.id) })
        if (name && !isBot(m.id)) this.game.notify(`${name} left`, 2500)
        break
      }
      case 'snapshot': {
        this.syncClock(m.serverTime)
        this.game.remotes.apply(m.serverTime, m.entities, m.removed)
        break
      }
      case 'correction': {
        this.epoch = m.epoch
        this.game.netCorrect(cmToM(m.pos[0]), cmToM(m.pos[1]), cmToM(m.pos[2]), u16ToYaw(m.yaw))
        break
      }
      case 'eliminated': {
        const who = (id: number) => (id === this.state.me ? 'You' : this.names.get(id) ?? 'Someone')
        // (bots knocking bots over isn't news)
        if (m.killer !== NO_PLAYER && !(isBot(m.killer) && isBot(m.victim))) this.game.notify(`${who(m.killer)} ran over ${who(m.victim) === 'You' ? 'you' : who(m.victim)}`, 3000)
        break
      }
      case 'pong': {
        this.syncClock(m.serverTime + (performance.now() - m.clientTime) / 2)
        break
      }
      case 'kick': {
        this.set({ message: KICK_TEXT[m.reason] ?? m.message })
        this.game.notify(KICK_TEXT[m.reason] ?? m.message, 4000)
        break
      }
      default:
        break
    }
  }

  /** Server clock estimate: offset = serverTime − now, nudged toward each sample (the lag is part of the delay). */
  private syncClock(serverTime: number): void {
    const off = serverTime - performance.now()
    this.clock = this.clock === null || Math.abs(off - this.clock) > 1000 ? off : this.clock + (off - this.clock) * 0.05
  }

  /** The server's clock now (ms), or null before the first packet. */
  serverNow(): number | null {
    return this.clock === null ? null : performance.now() + this.clock
  }

  /** Tell the server the car was respawned (R): the next pose may jump a few metres. */
  respawned(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient({ t: 'action', kind: Action.RespawnVehicle, target: 0 }))
  }

  /** Per frame (GameLoop 'net'): send the pose at SEND_HZ, ping, nothing when offline. */
  update(dt: number): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state.status !== 'online') return
    const now = performance.now()
    if (now - this.lastPing > PING_EVERY) {
      this.lastPing = now
      ws.send(encodeClient({ t: 'ping', clientTime: Math.floor(now) >>> 0 }))
    }
    this.sendAcc += dt
    if (this.sendAcc < 1 / SEND_HZ) return
    this.sendAcc = Math.min(this.sendAcc - 1 / SEND_HZ, 1 / SEND_HZ)
    const p = this.game.localPose()
    this.seq = (this.seq + 1) >>> 0
    ws.send(
      encodeClient({
        t: 'state',
        state: {
          seq: this.seq,
          clientTime: Math.floor(now) >>> 0,
          epoch: this.epoch,
          flags: p.flags,
          model: p.model,
          pos: [mToCm(p.x), mToCm(p.y), mToCm(p.z)],
          yaw: yawToU16(p.yaw),
          pitch: pitchToI16(p.pitch),
          vel: [mpsToCms(p.vx), mpsToCms(p.vy), mpsToCms(p.vz)],
        },
      }),
    )
  }
}

interface SeatRes {
  room: RoomInfo
  player_id: number
  ticket: string
  ws_url: string
  expires_in: number
}

/** The local player's pose as the net client sends it (metres / radians). */
export interface LocalPose {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  vx: number
  vy: number
  vz: number
  flags: number
  model: number
}

/** Catalogue model id on the wire: index + 1 (0 = on foot; BIKE_MODEL = the bike). */
export function wireModel(vehicleId: string | null, bike: boolean): number {
  if (bike) return BIKE_MODEL
  if (!vehicleId) return 0
  const i = VEHICLES.findIndex((v) => v.id === vehicleId)
  return i < 0 ? 1 : i + 1
}

export { Flags }
