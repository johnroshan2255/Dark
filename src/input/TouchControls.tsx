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
  const base = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLDivElement>(null)
  const moveId = useRef<number | null>(null)
  const origin = useRef({ x: 0, y: 0 })
  const lookId = useRef<number | null>(null)
  const last = useRef({ x: 0, y: 0 })

  useEffect(() => () => void (input.touchMove.x = input.touchMove.y = 0), [input])

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

  const onLookDown = (e: RPointerEvent) => {
    if (lookId.current !== null) return
    lookId.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = { x: e.clientX, y: e.clientY }
  }
  const onLookMove = (e: RPointerEvent) => {
    if (e.pointerId !== lookId.current) return
    input.addLook(e.clientX - last.current.x, e.clientY - last.current.y)
    last.current = { x: e.clientX, y: e.clientY }
  }
  const onLookUp = (e: RPointerEvent) => {
    if (e.pointerId === lookId.current) lookId.current = null
  }

  const tap = (code: string) => (e: RPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    input.trigger(code)
  }

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
          {flashlight ? 'LIGHT ●' : 'LIGHT ○'}
        </button>
        <button style={btn} data-testid="btn-bike" onPointerDown={tap('KeyE')}>
          RIDE
        </button>
        <button style={{ ...btn, width: 76, height: 76 }} data-testid="btn-jump" onPointerDown={tap('Space')}>
          JUMP
        </button>
      </div>
      <div style={topRight}>
        <button style={small} onPointerDown={tap('F3')}>FPS</button>
        <button style={small} onPointerDown={tap('KeyT')} data-testid="btn-daynight">{phase === 'NIGHT' || phase === 'DUSK' ? '☀' : '☾'}</button>
        <button style={small} onPointerDown={tap('KeyV')} data-testid="btn-cam">{cam === 'tpp' ? 'FPP' : 'TPP'}</button>
        <button style={small} onPointerDown={tap('KeyO')} data-testid="btn-settings">⚙</button>
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
  border: '2px solid rgba(255,255,255,0.25)',
  background: 'rgba(0,0,0,0.18)',
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
  background: 'rgba(255,255,255,0.35)',
}
const buttons: CSSProperties = {
  position: 'absolute',
  right: 'max(16px, env(safe-area-inset-right))',
  bottom: 'max(18px, env(safe-area-inset-bottom))',
  display: 'flex',
  gap: 14,
  alignItems: 'flex-end',
}
const btn: CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: '50%',
  border: '2px solid rgba(255,255,255,0.3)',
  background: 'rgba(0,0,0,0.35)',
  color: '#e8e8e8',
  font: '600 11px ui-monospace, Menlo, monospace',
  touchAction: 'none',
}
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
