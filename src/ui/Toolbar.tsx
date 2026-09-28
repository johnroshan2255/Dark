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
  const night = phase === 'NIGHT' || phase === 'DUSK'
  return (
    <div style={bar}>
      <button style={btn} onClick={() => game.toggleDayNight()} title="Day ⇄ night (T)" data-testid="tb-daynight">{night ? '☀ Day' : '☾ Night'}</button>
      <button style={btn} onClick={() => game.toggleCamera()} title="Camera (V)" data-testid="tb-cam">{cam === 'tpp' ? '👁 First person' : '🧍 Third person'}</button>
      <button style={{ ...btn, ...(nightmare ? { borderColor: 'rgba(255,80,60,0.8)', color: '#ffb3a8' } : {}) }} onClick={() => game.toggleNightmare()} title="Nightmare realm (N)">⛧ Nightmare</button>
      <button style={btn} onClick={() => game.openSettings(true)} title="Settings (O)" data-testid="tb-settings">⚙</button>
    </div>
  )
}

const bar: CSSProperties = { position: 'fixed', bottom: 36, right: 8, display: 'flex', gap: 6, zIndex: 11 }
const btn: CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(0,0,0,0.45)',
  color: '#dfe3e6', font: '600 11px ui-monospace, Menlo, monospace', cursor: 'pointer',
}
