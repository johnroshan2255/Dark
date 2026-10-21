/**
 * DARK wire protocol — the browser side of `server/crates/protocol` (Rust). One packet per binary WebSocket frame:
 * `[kind: u8][payload]`, little-endian. Positions are int32 centimetres, velocities int16 cm/s, yaw uint16 over one
 * turn, pitch int16 over ±π/2. Both implementations are tested against the same golden vectors
 * (`server/crates/protocol/golden.json`, `tests/protocol.test.ts`): change a layout in both and bump PROTOCOL_VERSION.
 * Full table: `server/docs/PROTOCOL.md`.
 */

export const PROTOCOL_VERSION = 1
export const MAX_PACKET = 16 * 1024
export const MAX_SNAPSHOT_ENTITIES = 96
/** "Nobody" (e.g. the zone as a killer). */
export const NO_PLAYER = 0xffff

export const Flags = { DRIVING: 1, BOAT: 2, AIRBORNE: 4, DEAD: 8, BOOST: 16, LIGHTS: 32, BRAKING: 64, FLYING: 128 } as const
export const Action = { RespawnVehicle: 1, Ready: 2, Spectate: 3 } as const
export const Phase = { Lobby: 0, Countdown: 1, Running: 2, Ended: 3 } as const
export const Cause = { Zone: 1, Roadkill: 2, Disconnect: 3 } as const
export const Kick = {
  BadTicket: 1, VersionMismatch: 2, MatchFull: 3, MatchOver: 4, Cheating: 5, Flooding: 6, Malformed: 7, Timeout: 8, ServerShutdown: 9, Duplicate: 10,
} as const

export type V3 = [number, number, number]

/** The client's pose (wire units). */
export interface State {
  seq: number
  clientTime: number
  /** The last Correction epoch applied (states from before a correction are ignored by the server). */
  epoch: number
  flags: number
  /** 0 on foot, else vehicle catalogue index + 1. */
  model: number
  pos: V3
  yaw: number
  pitch: number
  vel: V3
}

export interface EntityState {
  id: number
  flags: number
  model: number
  pos: V3
  yaw: number
  pitch: number
  vel: V3
}

export interface Zone {
  x: number
  z: number
  radius: number
  targetX: number
  targetZ: number
  targetRadius: number
  shrinkStartMs: number
  shrinkEndMs: number
  dps: number
}

export type ClientMsg =
  | { t: 'hello'; protocol: number; ticket: string }
  | { t: 'state'; state: State }
  | { t: 'ping'; clientTime: number }
  | { t: 'action'; kind: number; target: number }
  | { t: 'leave' }

export type ServerMsg =
  | { t: 'welcome'; protocol: number; playerId: number; matchId: bigint; tickRate: number; map: string; seed: number; spawn: V3; yaw: number; serverTime: number }
  | { t: 'snapshot'; tick: number; serverTime: number; ackSeq: number; hp: number; alive: number; entities: EntityState[]; removed: number[] }
  | { t: 'playerJoined'; id: number; name: string }
  | { t: 'playerLeft'; id: number }
  | { t: 'phase'; phase: number; endsInMs: number }
  | { t: 'zone'; zone: Zone }
  | { t: 'eliminated'; victim: number; killer: number; cause: number; placement: number }
  | { t: 'matchEnd'; winner: number; placement: number }
  | { t: 'correction'; seq: number; epoch: number; pos: V3; yaw: number }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'kick'; reason: number; message: string }

const C = { HELLO: 0x01, STATE: 0x02, PING: 0x03, ACTION: 0x04, LEAVE: 0x05 } as const
const S = {
  WELCOME: 0x81, SNAPSHOT: 0x82, PLAYER_JOINED: 0x83, PLAYER_LEFT: 0x84, PHASE: 0x85, ZONE: 0x86, ELIMINATED: 0x87, MATCH_END: 0x88,
  CORRECTION: 0x89, PONG: 0x8a, KICK: 0x8b,
} as const

export class ProtocolError extends Error {}

// ---------------------------------------------------------------- quantisation (as the Rust helpers)
const TAU = Math.PI * 2
const clampInt = (v: number, lo: number, hi: number) => (Number.isNaN(v) ? 0 : Math.max(lo, Math.min(hi, Math.round(v))))
export const mToCm = (m: number) => clampInt(m * 100, -2147483648, 2147483647)
export const cmToM = (cm: number) => cm * 0.01
export const mpsToCms = (v: number) => clampInt(v * 100, -32768, 32767)
export const cmsToMps = (v: number) => v * 0.01
export const yawToU16 = (yaw: number) => {
  const t = (((yaw % TAU) + TAU) % TAU) / TAU
  return Number.isNaN(t) ? 0 : Math.round(t * 65536) & 0xffff
}
export const u16ToYaw = (v: number) => (v / 65536) * TAU
export const pitchToI16 = (p: number) => clampInt((Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p)) / (Math.PI / 2)) * 32767, -32767, 32767)
export const i16ToPitch = (v: number) => (v / 32767) * (Math.PI / 2)

// ---------------------------------------------------------------- writer / reader
const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

class Writer {
  private buf = new Uint8Array(256)
  private view = new DataView(this.buf.buffer)
  n = 0
  private room(k: number) {
    if (this.n + k <= this.buf.length) return
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k))
    b.set(this.buf)
    this.buf = b
    this.view = new DataView(b.buffer)
  }
  u8(v: number) { this.room(1); this.view.setUint8(this.n, v); this.n += 1 }
  u16(v: number) { this.room(2); this.view.setUint16(this.n, v, true); this.n += 2 }
  i16(v: number) { this.room(2); this.view.setInt16(this.n, v, true); this.n += 2 }
  u32(v: number) { this.room(4); this.view.setUint32(this.n, v >>> 0, true); this.n += 4 }
  i32(v: number) { this.room(4); this.view.setInt32(this.n, v | 0, true); this.n += 4 }
  u64(v: bigint) { this.room(8); this.view.setBigUint64(this.n, v, true); this.n += 8 }
  bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length }
  /** u8 length + UTF-8, cut at 255 bytes on a character boundary. */
  str(s: string) {
    let b = enc.encode(s)
    if (b.length > 255) {
      let k = 255
      while (k > 0 && (b[k] & 0xc0) === 0x80) k--
      b = b.subarray(0, k)
    }
    this.u8(b.length)
    this.bytes(b)
  }
  longStr(s: string) {
    const b = enc.encode(s).subarray(0, 0xffff)
    this.u16(b.length)
    this.bytes(b)
  }
  done(): Uint8Array { return this.buf.slice(0, this.n) }
}

class Reader {
  private at = 0
  private view: DataView
  constructor(private buf: Uint8Array) { this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength) }
  private need(k: number) { if (this.at + k > this.buf.length) throw new ProtocolError(`truncated at ${this.at}`) }
  u8() { this.need(1); return this.view.getUint8(this.at++) }
  u16() { this.need(2); const v = this.view.getUint16(this.at, true); this.at += 2; return v }
  i16() { this.need(2); const v = this.view.getInt16(this.at, true); this.at += 2; return v }
  u32() { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v }
  i32() { this.need(4); const v = this.view.getInt32(this.at, true); this.at += 4; return v }
  u64() { this.need(8); const v = this.view.getBigUint64(this.at, true); this.at += 8; return v }
  private text(n: number) {
    this.need(n)
    const s = this.buf.subarray(this.at, this.at + n)
    this.at += n
    try { return dec.decode(s) } catch { throw new ProtocolError('bad utf-8') }
  }
  str() { return this.text(this.u8()) }
  longStr() { return this.text(this.u16()) }
  v3i32(): V3 { return [this.i32(), this.i32(), this.i32()] }
  v3i16(): V3 { return [this.i16(), this.i16(), this.i16()] }
  finish() { if (this.at !== this.buf.length) throw new ProtocolError(`${this.buf.length - this.at} trailing byte(s)`) }
}

// ---------------------------------------------------------------- client → server
export function encodeClient(m: ClientMsg): Uint8Array {
  const w = new Writer()
  switch (m.t) {
    case 'hello': w.u8(C.HELLO); w.u16(m.protocol); w.longStr(m.ticket); break
    case 'state': {
      const s = m.state
      w.u8(C.STATE); w.u32(s.seq); w.u32(s.clientTime); w.u8(s.epoch); w.u8(s.flags); w.u8(s.model)
      for (const v of s.pos) w.i32(v)
      w.u16(s.yaw); w.i16(s.pitch)
      for (const v of s.vel) w.i16(v)
      break
    }
    case 'ping': w.u8(C.PING); w.u32(m.clientTime); break
    case 'action': w.u8(C.ACTION); w.u8(m.kind); w.u16(m.target); break
    case 'leave': w.u8(C.LEAVE); break
  }
  return w.done()
}

export function decodeClient(buf: Uint8Array): ClientMsg {
  if (buf.length > MAX_PACKET) throw new ProtocolError('packet too large')
  if (!buf.length) throw new ProtocolError('empty packet')
  const r = new Reader(buf)
  const k = r.u8()
  let m: ClientMsg
  switch (k) {
    case C.HELLO: m = { t: 'hello', protocol: r.u16(), ticket: r.longStr() }; break
    case C.STATE: m = { t: 'state', state: { seq: r.u32(), clientTime: r.u32(), epoch: r.u8(), flags: r.u8(), model: r.u8(), pos: r.v3i32(), yaw: r.u16(), pitch: r.i16(), vel: r.v3i16() } }; break
    case C.PING: m = { t: 'ping', clientTime: r.u32() }; break
    case C.ACTION: m = { t: 'action', kind: r.u8(), target: r.u16() }; break
    case C.LEAVE: m = { t: 'leave' }; break
    default: throw new ProtocolError(`unknown client kind 0x${k.toString(16)}`)
  }
  r.finish()
  return m
}

// ---------------------------------------------------------------- server → client
export function encodeServer(m: ServerMsg): Uint8Array {
  const w = new Writer()
  switch (m.t) {
    case 'welcome':
      w.u8(S.WELCOME); w.u16(m.protocol); w.u16(m.playerId); w.u64(m.matchId); w.u8(m.tickRate); w.str(m.map); w.u32(m.seed)
      for (const v of m.spawn) w.i32(v)
      w.u16(m.yaw); w.u32(m.serverTime)
      break
    case 'snapshot': {
      w.u8(S.SNAPSHOT); w.u32(m.tick); w.u32(m.serverTime); w.u32(m.ackSeq); w.u8(m.hp); w.u8(m.alive)
      const es = m.entities.slice(0, MAX_SNAPSHOT_ENTITIES)
      w.u8(es.length)
      for (const e of es) {
        w.u16(e.id); w.u8(e.flags); w.u8(e.model)
        for (const v of e.pos) w.i32(v)
        w.u16(e.yaw); w.i16(e.pitch)
        for (const v of e.vel) w.i16(v)
      }
      const rm = m.removed.slice(0, 255)
      w.u8(rm.length)
      for (const id of rm) w.u16(id)
      break
    }
    case 'playerJoined': w.u8(S.PLAYER_JOINED); w.u16(m.id); w.str(m.name); break
    case 'playerLeft': w.u8(S.PLAYER_LEFT); w.u16(m.id); break
    case 'phase': w.u8(S.PHASE); w.u8(m.phase); w.u32(m.endsInMs); break
    case 'zone': {
      const z = m.zone
      w.u8(S.ZONE); w.i32(z.x); w.i32(z.z); w.u32(z.radius); w.i32(z.targetX); w.i32(z.targetZ); w.u32(z.targetRadius)
      w.u32(z.shrinkStartMs); w.u32(z.shrinkEndMs); w.u8(z.dps)
      break
    }
    case 'eliminated': w.u8(S.ELIMINATED); w.u16(m.victim); w.u16(m.killer); w.u8(m.cause); w.u8(m.placement); break
    case 'matchEnd': w.u8(S.MATCH_END); w.u16(m.winner); w.u8(m.placement); break
    case 'correction':
      w.u8(S.CORRECTION); w.u32(m.seq); w.u8(m.epoch)
      for (const v of m.pos) w.i32(v)
      w.u16(m.yaw)
      break
    case 'pong': w.u8(S.PONG); w.u32(m.clientTime); w.u32(m.serverTime); break
    case 'kick': w.u8(S.KICK); w.u8(m.reason); w.str(m.message); break
  }
  return w.done()
}

export function decodeServer(buf: Uint8Array): ServerMsg {
  if (buf.length > MAX_PACKET) throw new ProtocolError('packet too large')
  if (!buf.length) throw new ProtocolError('empty packet')
  const r = new Reader(buf)
  const k = r.u8()
  let m: ServerMsg
  switch (k) {
    case S.WELCOME:
      m = { t: 'welcome', protocol: r.u16(), playerId: r.u16(), matchId: r.u64(), tickRate: r.u8(), map: r.str(), seed: r.u32(), spawn: r.v3i32(), yaw: r.u16(), serverTime: r.u32() }
      break
    case S.SNAPSHOT: {
      const tick = r.u32(), serverTime = r.u32(), ackSeq = r.u32(), hp = r.u8(), alive = r.u8()
      const n = r.u8()
      if (n > MAX_SNAPSHOT_ENTITIES) throw new ProtocolError('too many entities')
      const entities: EntityState[] = []
      for (let i = 0; i < n; i++) entities.push({ id: r.u16(), flags: r.u8(), model: r.u8(), pos: r.v3i32(), yaw: r.u16(), pitch: r.i16(), vel: r.v3i16() })
      const removed: number[] = []
      for (let i = r.u8(); i > 0; i--) removed.push(r.u16())
      m = { t: 'snapshot', tick, serverTime, ackSeq, hp, alive, entities, removed }
      break
    }
    case S.PLAYER_JOINED: m = { t: 'playerJoined', id: r.u16(), name: r.str() }; break
    case S.PLAYER_LEFT: m = { t: 'playerLeft', id: r.u16() }; break
    case S.PHASE: m = { t: 'phase', phase: r.u8(), endsInMs: r.u32() }; break
    case S.ZONE:
      m = { t: 'zone', zone: { x: r.i32(), z: r.i32(), radius: r.u32(), targetX: r.i32(), targetZ: r.i32(), targetRadius: r.u32(), shrinkStartMs: r.u32(), shrinkEndMs: r.u32(), dps: r.u8() } }
      break
    case S.ELIMINATED: m = { t: 'eliminated', victim: r.u16(), killer: r.u16(), cause: r.u8(), placement: r.u8() }; break
    case S.MATCH_END: m = { t: 'matchEnd', winner: r.u16(), placement: r.u8() }; break
    case S.CORRECTION: m = { t: 'correction', seq: r.u32(), epoch: r.u8(), pos: r.v3i32(), yaw: r.u16() }; break
    case S.PONG: m = { t: 'pong', clientTime: r.u32(), serverTime: r.u32() }; break
    case S.KICK: m = { t: 'kick', reason: r.u8(), message: r.str() }; break
    default: throw new ProtocolError(`unknown server kind 0x${k.toString(16)}`)
  }
  r.finish()
  return m
}
