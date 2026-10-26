import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { MAPS } from '../world/map/FixedMap'
import { NO_PLAYER, isBot } from '../net/protocol'
import type { RoomInfo } from '../net/NetClient'
import { ACCENT, FONT, glass, label, LIME } from './theme'
import { playMap } from './MapSelect'

/**
 * ROOMS (multiplayer). Every game started is a room (net/NetClient). Here:
 *  * the LANDING page's room browser — public rooms + "Enter room" by code — as a glass panel top-right on desktop,
 *    a floating ROOMS button + modal on phones;
 *  * the menu's "Private room" toggle and ROOM SETTINGS (world, players, visibility, rules, your name);
 *  * in game, the ROOM card (code to share, who's in, the owner's settings and kicks), opened from the toolbar /
 *    a floating button on phones.
 * Styles: ui/theme.ts + ui/frontend.css (.fe-rooms*).
 */

const mapName = (id?: string) => MAPS.find((m) => m.id === id)?.name ?? id ?? 'Map'
const worldLabel = (r: RoomInfo) => (r.kind === 'map' ? mapName(r.map) : `Endless world · #${String(r.seed ?? 0).slice(0, 8)}`)

/** Join a room: here if this game already runs its world, else reload into it (`?seed=` / `?map=` + `room`). */
export async function joinRoom(game: Game, code: string): Promise<string | null> {
  let room: RoomInfo
  try {
    room = await game.net.peek(code)
  } catch (e) {
    return (e as Error).message === 'Multiplayer server unreachable' ? 'Multiplayer server unreachable' : 'No room with that code'
  }
  if (room.players >= room.max_players) return 'That room is full'
  const s = game.store.get()
  const same = room.kind === 'map' ? game.map?.id === room.map : !game.map && s.seed >>> 0 === room.seed
  if (same) {
    const ok = await game.net.join(room.code)
    if (!ok) return game.store.get().net.message ?? 'Could not join'
    game.play()
    return null
  }
  const p = new URLSearchParams(location.search)
  p.delete('seed')
  p.delete('map')
  if (room.kind === 'map' && room.map) p.set('map', room.map)
  else p.set('seed', String(room.seed))
  p.set('room', room.code)
  p.set('play', '1')
  location.search = p.toString()
  return null
}

// ---------------------------------------------------------------- landing: the room browser

export function RoomBrowser({ game, onJoined }: { game: Game; onJoined?: () => void }) {
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null)
  const [offline, setOffline] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    game.net
      .listRooms()
      .then((r) => {
        setRooms(r)
        setOffline(false)
      })
      .catch(() => setOffline(true))
  }, [game])
  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [refresh])
  const go = async (c: string) => {
    if (busy) return
    setBusy(c)
    setError(null)
    const err = await joinRoom(game, c)
    setBusy(null)
    if (err) setError(err)
    else onJoined?.()
  }
  const valid = /^[A-Z0-9]{6}$/.test(code)
  return (
    <div className="fe-rooms-body">
      <div className="fe-rooms-list" data-testid="rooms-list">
        {offline ? (
          <Empty title="Multiplayer offline" sub="The room server can't be reached. You can still play alone." action={<button style={chipBtn} onClick={refresh}>Retry</button>} />
        ) : rooms === null ? (
          <Empty title="Looking for rooms…" />
        ) : rooms.length === 0 ? (
          <Empty title="No public rooms yet" sub="Start playing — your game opens one others can join." />
        ) : (
          rooms.map((r) => {
            const full = r.players >= r.max_players
            return (
              <div key={r.code} className="fe-room" data-testid={`room-${r.code}`}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={roomName}>{r.name}</div>
                  <div style={{ ...label, letterSpacing: 1.4, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {worldLabel(r)}
                    {r.bots ? ` · ${r.bots} bots` : ''}
                    {r.roadkill ? ' · Roadkill' : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ font: `900 14px ${FONT}`, color: full ? 'rgba(255,236,214,0.5)' : LIME }}>
                    {r.players}<span style={{ opacity: 0.55, fontWeight: 700 }}>/{r.max_players}</span>
                  </div>
                </div>
                <button className="fe-room-join" disabled={full || busy !== null} onClick={() => void go(r.code)} data-testid={`join-${r.code}`}>
                  {busy === r.code ? '…' : full ? 'Full' : 'Join'}
                </button>
              </div>
            )
          })
        )}
      </div>
      <form
        className="fe-rooms-code"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) void go(code)
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          placeholder="ROOM CODE"
          aria-label="Room code"
          spellCheck={false}
          autoCapitalize="characters"
          autoComplete="off"
          data-testid="room-code"
        />
        <button className="fe-btn fe-btn--compact" type="submit" disabled={!valid || busy !== null} data-testid="room-enter">
          <span>{busy === code && busy ? 'Joining…' : 'Enter room'}</span>
          <span className="fe-chev">›</span>
        </button>
      </form>
      {error && <div style={errText}>{error}</div>}
    </div>
  )
}

function Empty({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div style={{ padding: '18px 8px', textAlign: 'center' }}>
      <div style={{ font: `800 13px ${FONT}`, color: 'rgba(255,244,227,0.82)' }}>{title}</div>
      {sub && <div style={{ font: `12px/1.45 ${FONT}`, color: 'rgba(255,236,214,0.6)', marginTop: 6 }}>{sub}</div>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  )
}

/** Landing page: the panel (desktop) or the floating button + modal (phones). */
export function LandingRooms({ game }: { game: Game }) {
  const touch = useStore(game.store, (s) => s.touch)
  const [open, setOpen] = useState(false)
  return (
    <div className={`fe-rooms${touch ? ' fe-rooms--touch' : ''}`}>
      <div className="fe-rooms-panel" style={glass} data-testid="rooms-panel">
        <RoomsHeader />
        <RoomBrowser game={game} />
      </div>
      <button className="fe-rooms-fab" onClick={() => setOpen(true)} data-testid="rooms-fab">
        <span aria-hidden>👥</span>
        <span>Rooms</span>
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)} title="Rooms" testid="rooms-modal">
          <RoomBrowser game={game} onJoined={() => setOpen(false)} />
        </Modal>
      )}
    </div>
  )
}

function RoomsHeader() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
      <div style={{ font: `900 15px ${FONT}`, letterSpacing: 4, textTransform: 'uppercase', color: '#fff4e3' }}>Rooms</div>
      <div style={{ ...label, letterSpacing: 1.4 }}>Join a game in progress</div>
    </div>
  )
}

// ---------------------------------------------------------------- modal shell

export function Modal({ title, onClose, children, testid, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; testid?: string; wide?: boolean }) {
  useEffect(() => {
    if (document.pointerLockElement) document.exitPointerLock()
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="fe-modal" onPointerDown={(e) => e.target === e.currentTarget && onClose()} data-testid={testid}>
      <div className={`fe-modal-card${wide ? ' fe-modal-card--wide' : ''}`} style={glass} onKeyDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div style={{ font: `900 17px ${FONT}`, letterSpacing: 4, textTransform: 'uppercase', color: '#fff4e3', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- menu: private toggle + room settings

/** The row above PLAY: Public / Private (the next room) and Room settings. */
export function RoomStartRow({ game }: { game: Game }) {
  const setup = useStore(game.store, (s) => s.roomSetup)
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="fe-room-row">
        <button
          className="fe-seg fe-toggle"
          aria-pressed={setup.private}
          onClick={() => game.setRoomSetup({ private: !setup.private })}
          title="Private rooms aren't listed — friends join with the code"
          data-testid="room-private"
        >
          <span className="fe-switch" aria-hidden />
          {setup.private ? 'Private room' : 'Public room'}
        </button>
        <button className="fe-seg" onClick={() => setOpen(true)} data-testid="room-settings">⚙ Room settings</button>
      </div>
      {open && <RoomSetupModal game={game} onClose={() => setOpen(false)} />}
    </>
  )
}

function RoomSetupModal({ game, onClose }: { game: Game; onClose: () => void }) {
  const setup = useStore(game.store, (s) => s.roomSetup)
  const playerName = useStore(game.store, (s) => s.playerName)
  const [name, setName] = useState(playerName)
  const [world, setWorld] = useState<string>(game.map?.id ?? 'world')
  const save = () => {
    game.setPlayerName(name)
  }
  return (
    <Modal title="Room settings" onClose={() => (save(), onClose())} testid="room-setup" wide>
      <div className="fe-form">
        <Field label="Your name">
          <input className="fe-input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} onBlur={save} data-testid="setup-player" />
        </Field>
        <Field label="Room name">
          <input className="fe-input" value={setup.name} maxLength={20} placeholder={`${name || 'Your'}'s room`} onChange={(e) => game.setRoomSetup({ name: e.target.value })} data-testid="setup-name" />
        </Field>
        <Field label="World">
          <div className="fe-segs">
            <Seg on={world === 'world'} onClick={() => setWorld('world')}>Endless world</Seg>
            {MAPS.filter((m) => !m.page).map((m) => (
              <Seg key={m.id} on={world === m.id} onClick={() => setWorld(m.id)}>{m.name}</Seg>
            ))}
          </div>
        </Field>
        <Field label={`Players · ${setup.maxPlayers}`}>
          <input className="fe-range" type="range" min={2} max={100} value={setup.maxPlayers} onChange={(e) => game.setRoomSetup({ maxPlayers: Number(e.target.value) })} data-testid="setup-max" />
        </Field>
        <Field label={`Bots · ${setup.bots}`} help="Computer players: they drive, race, sail, fly and wander like people do.">
          <input className="fe-range" type="range" min={0} max={100} value={setup.bots} onChange={(e) => game.setRoomSetup({ bots: Number(e.target.value) })} data-testid="setup-bots" />
        </Field>
        <Field label="Visibility" help={setup.private ? 'Only players with the code can join.' : 'Listed on everyone’s landing page.'}>
          <div className="fe-segs">
            <Seg on={!setup.private} onClick={() => game.setRoomSetup({ private: false })}>Public</Seg>
            <Seg on={setup.private} onClick={() => game.setRoomSetup({ private: true })}>Private</Seg>
          </div>
        </Field>
        <Field label="Roadkill" help="Cars hurt players on foot (they get back up).">
          <OnOff on={setup.roadkill} set={(v) => game.setRoomSetup({ roadkill: v })} />
        </Field>
        <Field label="Flying cars">
          <OnOff on={setup.flying} set={(v) => game.setRoomSetup({ flying: v })} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        <button
          className="fe-btn fe-btn--primary fe-btn--compact"
          style={{ flex: '1 1 220px' }}
          onClick={() => {
            save()
            onClose()
            playMap(game, world === 'world' ? null : world)
          }}
          data-testid="setup-start"
        >
          <span>Start room</span><span className="fe-chev">▶</span>
        </button>
        <button className="fe-btn fe-btn--compact" style={{ flex: '0 1 140px' }} onClick={() => (save(), onClose())}>
          <span>Done</span>
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- in game: the room card

/** Toolbar / floating button + the ROOM card. Shown only while in a room. */
export function InGameRoom({ game, variant }: { game: Game; variant: 'toolbar' | 'float' }) {
  const net = useStore(game.store, (s) => s.net)
  const [open, setOpen] = useState(false)
  if (net.status !== 'online' || !net.room) return null
  const n = net.players.length
  return (
    <>
      <button
        className={variant === 'float' ? 'fe-room-float' : undefined}
        style={variant === 'toolbar' ? tbBtn : undefined}
        onClick={() => setOpen(true)}
        title="Room — invite, players, settings"
        data-testid="room-button"
      >
        👥 {n} · {net.room.code}
      </button>
      {open && <RoomCard game={game} onClose={() => setOpen(false)} />}
    </>
  )
}

function RoomCard({ game, onClose }: { game: Game; onClose: () => void }) {
  const net = useStore(game.store, (s) => s.net)
  const room = net.room
  const owner = net.me !== NO_PLAYER && net.me === net.owner
  const [edit, setDraft] = useState(() => (room ? rules(room) : null))
  const [msg, setMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  if (!room || !edit) return null
  // the owner edits a draft; everyone else sees the live rules
  const draft = owner ? edit : rules(room)
  const humans = net.players.filter((p) => !isBot(p.id))
  const bots = net.players.filter((p) => isBot(p.id))
  const dirty = draft.name !== room.name || draft.private !== room.private || draft.max !== room.max_players || draft.roadkill !== room.roadkill || draft.flying !== room.flying || draft.bots !== (room.bots ?? 0)
  const apply = async () => {
    setMsg(null)
    try {
      await game.net.configure({ name: draft.name, private: draft.private, max_players: draft.max, roadkill: draft.roadkill, flying: draft.flying, bots: draft.bots })
      setMsg('Saved')
    } catch (e) {
      setMsg((e as Error).message)
    }
  }
  const copy = () => {
    void navigator.clipboard?.writeText(room.code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <Modal title={room.name} onClose={onClose} testid="room-card" wide>
      <div className="fe-room-code-box">
        <div>
          <div style={label}>Room code {room.private ? '· private' : '· public'}</div>
          <div style={codeText} data-testid="room-code-text">{room.code}</div>
        </div>
        <button style={chipBtn} onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <div style={{ ...label, margin: '16px 0 8px' }}>{worldLabel(room)} · {humans.length}/{room.max_players} players{bots.length ? ` · ${bots.length} bots` : ''}</div>
      <div className="fe-room-players" data-testid="room-players">
        {humans.map((p) => (
          <div key={p.id} className="fe-room-player">
            <span style={{ ...dot, background: p.id === net.me ? '#3aa6e8' : ACCENT }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
              {p.id === net.me && <span style={{ color: 'rgba(255,236,214,0.55)' }}> (you)</span>}
            </span>
            {p.id === net.owner && <span style={ownerChip}>Owner</span>}
            {owner && p.id !== net.me && (
              <button style={kickBtn} onClick={() => void game.net.kick(p.id).catch((e: Error) => setMsg(e.message))} data-testid={`kick-${p.id}`}>Remove</button>
            )}
          </div>
        ))}
        {bots.length > 0 && (
          <div className="fe-room-player" title={bots.map((b) => b.name).join(', ')} data-testid="room-bot-row">
            <span style={{ ...dot, background: LIME }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(255,244,227,0.8)' }}>
              {bots.slice(0, 8).map((b) => b.name).join(', ')}
              {bots.length > 8 ? ` +${bots.length - 8}` : ''}
            </span>
            <span style={{ ...ownerChip, color: LIME, borderColor: 'rgba(205,232,74,0.45)' }}>{bots.length} bots</span>
          </div>
        )}
      </div>
      <div style={{ ...label, margin: '18px 0 8px' }}>{owner ? 'Room settings' : 'Room rules'}</div>
      <div className="fe-form">
        <Field label="Name">
          <input className="fe-input" value={draft.name} disabled={!owner} maxLength={20} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="room-name" />
        </Field>
        <Field label={`Players · ${draft.max}`}>
          <input className="fe-range" type="range" min={Math.max(2, humans.length)} max={100} value={draft.max} disabled={!owner} onChange={(e) => setDraft({ ...draft, max: Number(e.target.value) })} />
        </Field>
        <Field label={`Bots · ${draft.bots}`}>
          <input className="fe-range" type="range" min={0} max={100} value={draft.bots} disabled={!owner} onChange={(e) => setDraft({ ...draft, bots: Number(e.target.value) })} data-testid="room-bots" />
        </Field>
        <Field label="Visibility">
          <div className="fe-segs">
            <Seg on={!draft.private} disabled={!owner} onClick={() => setDraft({ ...draft, private: false })}>Public</Seg>
            <Seg on={draft.private} disabled={!owner} onClick={() => setDraft({ ...draft, private: true })}>Private</Seg>
          </div>
        </Field>
        <Field label="Roadkill">
          <OnOff on={draft.roadkill} disabled={!owner} set={(v) => setDraft({ ...draft, roadkill: v })} />
        </Field>
        <Field label="Flying cars">
          <OnOff on={draft.flying} disabled={!owner} set={(v) => setDraft({ ...draft, flying: v })} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {owner && (
          <button className="fe-btn fe-btn--primary fe-btn--compact" style={{ flex: '1 1 200px' }} disabled={!dirty} onClick={() => void apply()} data-testid="room-save">
            <span>Save settings</span><span className="fe-chev">✓</span>
          </button>
        )}
        <button
          className="fe-btn fe-btn--compact"
          style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
          onClick={() => {
            game.net.leave()
            onClose()
          }}
          data-testid="room-leave"
        >
          <span>Leave room</span>
        </button>
        {msg && <span style={{ font: `700 12px ${FONT}`, color: msg === 'Saved' ? LIME : '#ff9b85' }}>{msg}</span>}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- small pieces

const rules = (r: RoomInfo) => ({ name: r.name, private: r.private, max: r.max_players, roadkill: r.roadkill, flying: r.flying, bots: r.bots ?? 0 })

function Field({ label: l, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="fe-field">
      <div className="fe-field-label">{l}</div>
      <div className="fe-field-body">
        {children}
        {help && <div className="fe-field-help">{help}</div>}
      </div>
    </div>
  )
}

function Seg({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button className="fe-seg" aria-pressed={on} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

function OnOff({ on, set, disabled }: { on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="fe-segs">
      <Seg on={on} disabled={disabled} onClick={() => set(true)}>On</Seg>
      <Seg on={!on} disabled={disabled} onClick={() => set(false)}>Off</Seg>
    </div>
  )
}

const roomName: CSSProperties = { font: `800 14px ${FONT}`, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const errText: CSSProperties = { font: `700 12px ${FONT}`, color: '#ff9b85', marginTop: 8 }
const chipBtn: CSSProperties = {
  padding: '7px 14px', borderRadius: 999, border: '1px solid rgba(255,180,92,0.5)', background: 'rgba(255,154,69,0.14)', color: '#ffe0b8',
  font: `800 11px ${FONT}`, letterSpacing: 1.6, textTransform: 'uppercase', cursor: 'pointer',
}
const closeBtn: CSSProperties = { width: 36, height: 36, borderRadius: 18, border: '1px solid rgba(255,214,170,0.24)', background: 'rgba(255,236,214,0.06)', color: '#fff4e3', font: `700 15px ${FONT}`, cursor: 'pointer', flexShrink: 0 }
const codeText: CSSProperties = { font: `900 30px ui-monospace, Menlo, monospace`, letterSpacing: 8, color: LIME, marginTop: 4, textShadow: '0 0 18px rgba(205,232,74,0.3)' }
const dot: CSSProperties = { width: 9, height: 9, borderRadius: 5, flexShrink: 0 }
const ownerChip: CSSProperties = { font: `800 9px ${FONT}`, letterSpacing: 1.4, textTransform: 'uppercase', color: ACCENT, padding: '2px 7px', borderRadius: 999, border: '1px solid rgba(255,180,92,0.4)' }
const kickBtn: CSSProperties = { padding: '4px 10px', borderRadius: 999, border: '1px solid rgba(255,120,100,0.45)', background: 'rgba(255,90,70,0.12)', color: '#ffc2b5', font: `800 10px ${FONT}`, letterSpacing: 1.2, textTransform: 'uppercase', cursor: 'pointer' }
// (the in-game toolbar's dusk pill — ui/Toolbar.tsx)
const tbBtn: CSSProperties = {
  padding: '7px 12px', borderRadius: 999, border: '1px solid rgba(255,180,92,0.45)', background: 'rgba(28,24,52,0.62)',
  color: '#fff4e3', font: '700 11px system-ui, -apple-system, "Segoe UI", sans-serif', letterSpacing: 0.6, cursor: 'pointer',
  backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', boxShadow: '0 4px 14px rgba(10,6,24,0.3)',
}
