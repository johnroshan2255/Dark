import type { CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'

/**
 * Quick actions (desktop: clickable while the pointer is free; keys work any time).
 * Phones use the same actions from TouchControls.
 */
export function Toolbar({ game }: { game: Game }) {
  const phase = useStore(game.store, (s) => s.phase)
  const cam = useStore(game.store, (s) => s.settings.camera)
  const nightmare = useStore(game.store, (s) => s.nightmare)
  const driving = useStore(game.store, (s) => s.driving)
  const night = phase === 'NIGHT' || phase === 'DUSK'
  return (
    <div style={bar}>
      {driving && <button style={btn} onClick={() => game.respawnHere()} title="Respawn the car here (R)" data-testid="tb-respawn">⟲ Respawn</button>}
      <button style={btn} onClick={() => game.toggleDayNight()} title="Day ⇄ night (T)" data-testid="tb-daynight">{night ? '☀ Day' : '☾ Night'}</button>
      <button style={btn} onClick={() => game.toggleCamera()} title="Camera (V)" data-testid="tb-cam">{cam === 'tpp' ? '👁 First person' : '🧍 Third person'}</button>
      <button style={{ ...btn, ...(nightmare ? { borderColor: 'rgba(255,80,60,0.8)', color: '#ffb3a8' } : {}) }} onClick={() => game.toggleNightmare()} title="Nightmare realm (N)">⛧ Nightmare</button>
      <button style={btn} onClick={() => game.openSettings(true)} title="Settings (O)" data-testid="tb-settings">⚙</button>
    </div>
  )
}

const bar: CSSProperties = { position: 'fixed', bottom: 36, right: 8, display: 'flex', gap: 6, zIndex: 11 }
// (the front end's dusk glass — ui/theme.ts — small)
const btn: CSSProperties = {
  padding: '7px 12px', borderRadius: 999, border: '1px solid rgba(255,214,170,0.24)', background: 'rgba(28,24,52,0.62)',
  color: '#fff4e3', font: '700 11px system-ui, -apple-system, "Segoe UI", sans-serif', letterSpacing: 0.6, cursor: 'pointer',
  backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', boxShadow: '0 4px 14px rgba(10,6,24,0.3)',
}
