import { useEffect, useRef, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'

const STICK_RADIUS = 56

/**
 * Mobile controls (DOM overlay, pointer events, multi-touch):
 *  - left half: floating joystick → input.touchMove (full deflection = sprint)
 *  - right half: drag to look → input.addLook
 *  - buttons: jump, flashlight, HUD
 * No React state per move: knob and values are written through refs. Each zone owns one pointerId.
 */
export function TouchControls({ game }: { game: Game }) {
  const input = game.input
  const flashlight = useStore(game.store, (s) => s.flashlight)
  const phase = useStore(game.store, (s) => s.phase)
  const cam = useStore(game.store, (s) => s.settings.camera)
  const sim = useStore(game.store, (s) => s.settings.handling === 'sim')
  const driving = useStore(game.store, (s) => s.driving)
  const flying = useStore(game.store, (s) => s.flying)
  const boat = useStore(game.store, (s) => s.boat)
  const lights = useStore(game.store, (s) => s.lights)
  const wipers = useStore(game.store, (s) => s.wipers)
  const hook = useStore(game.store, (s) => s.hookAction ?? null)
  const base = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLDivElement>(null)
  const moveId = useRef<number | null>(null)
  const origin = useRef({ x: 0, y: 0 })
  const lookId = useRef<number | null>(null)
  const last = useRef({ x: 0, y: 0 })
  const pinchId = useRef<number | null>(null)
  const pinchAt = useRef({ x: 0, y: 0 })
  const pinchDist = useRef(0)

  useEffect(() => {
    input.touch = true // touch controls on screen: arcade driving auto-accelerates (Settings → Auto accelerate)
    return () => {
      input.touch = false
      input.touchMove.x = input.touchMove.y = 0
    }
  }, [input])

  const showStick = (x: number, y: number, visible: boolean) => {
    if (!base.current || !knob.current) return
    base.current.style.opacity = visible ? '1' : '0'
    base.current.style.transform = `translate(${x - STICK_RADIUS}px, ${y - STICK_RADIUS}px)`
    knob.current.style.transform = 'translate(0px, 0px)'
  }

  const onMoveDown = (e: RPointerEvent) => {
    if (moveId.current !== null) return
    moveId.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = { x: e.clientX, y: e.clientY }
    showStick(e.clientX, e.clientY, true)
  }
  const onMoveMove = (e: RPointerEvent) => {
    if (e.pointerId !== moveId.current) return
    let dx = e.clientX - origin.current.x
    let dy = e.clientY - origin.current.y
    const len = Math.hypot(dx, dy)
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS
      dy = (dy / len) * STICK_RADIUS
    }
    if (knob.current) knob.current.style.transform = `translate(${dx}px, ${dy}px)`
    const dead = 0.12
    const m = Math.min(1, len / STICK_RADIUS)
    const k = m < dead ? 0 : (m - dead) / (1 - dead) / Math.max(m, 1e-6)
    input.touchMove.x = (dx / STICK_RADIUS) * k
    input.touchMove.y = (-dy / STICK_RADIUS) * k
  }
  const onMoveUp = (e: RPointerEvent) => {
    if (e.pointerId !== moveId.current) return
    moveId.current = null
    input.touchMove.x = input.touchMove.y = 0
    showStick(origin.current.x, origin.current.y, false)
  }

  // A second finger in the look zone pinches: spread = zoom in, squeeze = zoom out (no look while pinching).
  const onLookDown = (e: RPointerEvent) => {
    if (lookId.current === null) {
      lookId.current = e.pointerId
      e.currentTarget.setPointerCapture(e.pointerId)
      last.current = { x: e.clientX, y: e.clientY }
    } else if (pinchId.current === null) {
      pinchId.current = e.pointerId
      e.currentTarget.setPointerCapture(e.pointerId)
      pinchAt.current = { x: e.clientX, y: e.clientY }
      pinchDist.current = Math.hypot(e.clientX - last.current.x, e.clientY - last.current.y)
    }
  }
  const onLookMove = (e: RPointerEvent) => {
    if (e.pointerId === pinchId.current) pinchAt.current = { x: e.clientX, y: e.clientY }
    else if (e.pointerId === lookId.current) {
      if (pinchId.current === null) input.addLook(e.clientX - last.current.x, e.clientY - last.current.y)
      last.current = { x: e.clientX, y: e.clientY }
    } else return
    if (pinchId.current !== null) {
      const d = Math.hypot(pinchAt.current.x - last.current.x, pinchAt.current.y - last.current.y)
      input.addZoom((pinchDist.current - d) / 60)
      pinchDist.current = d
    }
  }
  const onLookUp = (e: RPointerEvent) => {
    if (e.pointerId === pinchId.current) pinchId.current = null
    else if (e.pointerId === lookId.current) {
      // The pinching finger (if any) takes over the look.
      lookId.current = pinchId.current
      if (pinchId.current !== null) last.current = { ...pinchAt.current }
      pinchId.current = null
    }
  }

  const tap = (code: string) => (e: RPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    input.trigger(code)
  }
  /** Hold buttons (boost): key down while pressed, up on release / cancel / leave. */
  // Held while the finger is down — pointer CAPTURE keeps the events on the button when the thumb slides off it
  // (pointerleave used to release the boost as soon as the thumb moved a few pixels).
  const hold = (code: string) => ({
    onPointerDown: (e: RPointerEvent) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); input.hold(code, true) },
    onPointerUp: () => input.hold(code, false),
    onPointerCancel: () => input.hold(code, false),
    onLostPointerCapture: () => input.hold(code, false),
  })

  return (
    <div style={root} data-testid="touch-controls">
      <div
        style={{ ...zone, left: 0 }}
        data-testid="touch-move"
        onPointerDown={onMoveDown}
        onPointerMove={onMoveMove}
        onPointerUp={onMoveUp}
        onPointerCancel={onMoveUp}
      />
      <div
        style={{ ...zone, right: 0 }}
        data-testid="touch-look"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />
      <div ref={base} style={stickBase}>
        <div ref={knob} style={stickKnob} />
      </div>
      <div style={buttons}>
        <button style={btn} data-testid="btn-light" onPointerDown={tap('KeyF')}>
          {driving ? (lights ? 'LIGHTS ●' : 'LIGHTS ○') : flashlight ? 'TORCH ●' : 'TORCH ○'}
        </button>
        {driving && (
          <button style={btn} data-testid="btn-wipers" onPointerDown={tap('KeyJ')}>
            {wipers ? 'WIPE ●' : 'WIPE ○'}
          </button>
        )}
        <button style={btn} data-testid="btn-bike" onPointerDown={tap('KeyE')}>
          RIDE
        </button>
        {hook && (
          // Tow hook (H): a tap on foot (take / hang / let go / unhook); held in the car, the winch reels in.
          <button
            style={{ ...btn, background: 'rgba(196,40,28,0.55)' }}
            data-testid="btn-hook"
            {...(hook === 'winch' ? hold('KeyH') : { onPointerDown: tap('KeyH') })}
          >
            {hook === 'winch' ? 'WINCH' : 'HOOK'}
          </button>
        )}
        {driving && (
          // Air suspension / flight: ▲ ▼ lift the body on the ground, climb / sink in the air; FLY ⇄ LAND (L);
          // BOAT ⇄ CAR (O: the hull unfolds — refused in the air, the HUD says "Land first").
          <div style={liftCol}>
            <button
              style={{ ...btn, background: boat ? 'rgba(42,166,160,0.5)' : btn.background, opacity: flying ? 0.45 : 1 }}
              data-testid="btn-boat"
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                game.car.toggleBoat()
              }}
            >
              {boat ? 'CAR' : 'BOAT'}
            </button>
            <button style={{ ...btn, background: flying ? 'rgba(58,140,232,0.45)' : btn.background }} data-testid="btn-fly" onPointerDown={tap('KeyL')}>
              {flying ? 'LAND' : 'FLY'}
            </button>
            {(!boat || flying) && (
              <>
                <button style={liftBtn} data-testid="btn-up" {...hold('ArrowUp')}>▲</button>
                <button style={liftBtn} data-testid="btn-down" {...hold('ArrowDown')}>▼</button>
              </>
            )}
          </div>
        )}
        {driving && (
          <button style={{ ...btn, background: 'linear-gradient(135deg, rgba(255,210,122,0.55), rgba(242,107,58,0.5))', color: '#2a1405' }} data-testid="btn-boost" {...hold('ShiftLeft')}>
            NITRO
          </button>
        )}
        {driving ? (
          // Held like the handbrake (Space). Simulation (aids on): straight = a hard stop, steering = a handbrake turn;
          // arcade: steer + hold = drift (or pull the stick back while steering).
          <button style={{ ...btn, width: 76, height: 76 }} data-testid="btn-jump" {...hold('Space')}>
            {sim ? 'BRAKE' : 'DRIFT'}
          </button>
        ) : (
          <button style={{ ...btn, width: 76, height: 76 }} data-testid="btn-jump" onPointerDown={tap('Space')}>
            JUMP
          </button>
        )}
      </div>
      <div style={topRight}>
        <button style={small} onPointerDown={tap('F3')}>FPS</button>
        <button style={small} onPointerDown={tap('KeyT')} data-testid="btn-daynight">{phase === 'NIGHT' || phase === 'DUSK' ? '☀' : '☾'}</button>
        <button style={small} onPointerDown={tap('KeyV')} data-testid="btn-cam">{cam === 'tpp' ? 'FPP' : 'TPP'}</button>
        {driving && <button style={small} onPointerDown={tap('KeyR')} data-testid="btn-respawn">⟲</button>}
        <button
          style={small}
          onPointerDown={(e) => {
            e.stopPropagation()
            game.openSettings(!game.store.get().settingsOpen)
          }}
          data-testid="btn-settings"
        >
          ⚙
        </button>
        <button
          style={small}
          onPointerDown={(e) => {
            e.stopPropagation()
            if (document.fullscreenElement) void document.exitFullscreen()
            else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
          }}
        >
          ⛶
        </button>
      </div>
    </div>
  )
}

const root: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 5,
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}
const zone: CSSProperties = { position: 'absolute', top: 0, bottom: 0, width: '50%', touchAction: 'none' }
const stickBase: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: STICK_RADIUS * 2,
  height: STICK_RADIUS * 2,
  borderRadius: '50%',
  border: '2px solid rgba(255,214,170,0.28)',
  background: 'rgba(28,24,52,0.22)',
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms',
}
const stickKnob: CSSProperties = {
  position: 'absolute',
  left: STICK_RADIUS - 24,
  top: STICK_RADIUS - 24,
  width: 48,
  height: 48,
  borderRadius: '50%',
  background: 'rgba(255,214,170,0.45)',
}
const buttons: CSSProperties = {
  position: 'absolute',
  right: 'max(16px, env(safe-area-inset-right))',
  bottom: 'max(18px, env(safe-area-inset-bottom))',
  display: 'flex',
  gap: 14,
  alignItems: 'flex-end',
}
// (the front end's dusk glass — ui/theme.ts: violet glass, amber edge, cream label)
const btn: CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: '50%',
  border: '2px solid rgba(255,214,170,0.32)',
  background: 'rgba(28,24,52,0.5)',
  color: '#fff4e3',
  font: '800 11px system-ui, -apple-system, "Segoe UI", sans-serif',
  letterSpacing: 0.5,
  boxShadow: '0 4px 16px rgba(10,6,24,0.3)',
  touchAction: 'none',
}
const liftCol: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }
const liftBtn: CSSProperties = { ...btn, width: 56, height: 48, borderRadius: 14, font: '800 16px system-ui, sans-serif' }
const topRight: CSSProperties = {
  position: 'absolute',
  top: 'max(8px, env(safe-area-inset-top))',
  right: 'calc(max(8px, env(safe-area-inset-right)) + 130px)',
  display: 'flex',
  gap: 8,
}
const small: CSSProperties = {
  ...btn,
  width: 'auto',
  height: 32,
  padding: '0 10px',
  borderRadius: 16,
  font: '600 11px ui-monospace, Menlo, monospace',
}
