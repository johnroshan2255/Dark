import type { CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { vehicleClass, vehicleDef, vehicleRating, vehicleStats } from '../gameplay/vehicle/catalogue'
import { KeyArt } from './KeyArt'
import { playMap } from './MapSelect'
import { ACCENT, FONT, fullscreen, glass, label, LIME, statFill, statRow, statTrack, vignette } from './theme'

/**
 * MAIN MENU — the first screen after loading, over the still KEY ART (the world streams in behind it, not drawn):
 * the title top-left, PLAY / GARAGE / SETTINGS stacked bottom-left over the dusk scrim, the current car's card beside
 * them (no picture: the key art's truck, bottom-right, stays clear). Responsive (ui/frontend.css): phone landscape
 * shrinks everything and drops the stats, phone portrait stacks the buttons full-width with a slim card above them.
 */
export function MainMenu({ game }: { game: Game }) {
  const landing = useStore(game.store, (s) => s.landing)
  const screen = useStore(game.store, (s) => s.screen)
  const current = useStore(game.store, (s) => s.vehicle)
  const settings = useStore(game.store, (s) => s.settings)
  const touch = useStore(game.store, (s) => s.touch)
  const seed = useStore(game.store, (s) => s.seed)
  if (!landing || screen !== 'menu') return null
  const def = vehicleDef(current)
  const tune = game.tuning(current)
  void settings
  return (
    <div style={fullscreen} data-testid="menu">
      <KeyArt />
      <div style={vignette} />
      <div className="fe-brand">
        <h1 className="fe-title">DARK</h1>
        <div className="fe-tag">{game.map ? <>Map · <b>{game.map.name}</b></> : <>A new world every night · <b>world #{String(seed).slice(0, 8)}</b></>}</div>
      </div>
      <div className="fe-actions">
        {/* Two ways in: the endless procedural world, or a hand-made map (MapSelect). */}
        <button className={game.map ? 'fe-btn' : 'fe-btn fe-btn--primary'} onClick={() => playMap(game, null)} data-testid="play">
          <span>Explore endless world</span><span className="fe-chev">▶</span>
        </button>
        <button className={game.map ? 'fe-btn fe-btn--primary' : 'fe-btn'} onClick={() => game.showScreen('maps')} data-testid="menu-maps">
          <span>Select map</span><span className="fe-chev">›</span>
        </button>
        <button className="fe-btn" onClick={() => game.showScreen('garage')} data-testid="menu-garage">
          <span>Garage</span><span className="fe-chev">›</span>
        </button>
        <button className="fe-btn" onClick={() => game.openSettings(true)} data-testid="menu-settings">
          <span>Settings</span><span className="fe-chev">›</span>
        </button>
      </div>
      {/* Current car card */}
      <button className="fe-card" style={glass} onClick={() => game.showScreen('garage')} data-testid="menu-car">
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ font: `800 16px ${FONT}`, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.name}</div>
              <div style={{ ...label, marginTop: 2 }}>{def.maker} · {def.year} · {vehicleClass(tune)}</div>
            </div>
            <div style={rating}>{vehicleRating(tune)}</div>
          </div>
          <div className="fe-stats">
            {vehicleStats(tune).map((st) => (
              <div key={st.label} style={statRow}>
                <span>{st.label}</span>
                <span style={statTrack}><span style={statFill(st.value)} /></span>
                <span style={{ textAlign: 'right', color: ACCENT }}>{Math.round(st.value * 100)}</span>
              </div>
            ))}
          </div>
          <div className="fe-change" style={{ ...label, marginTop: 8, color: ACCENT }}>Change car ›</div>
        </div>
      </button>
      <div className="fe-hint">{touch ? 'Touch controls' : 'WASD · Space brake · Shift boost · E enter · F lights'}</div>
    </div>
  )
}

const rating: CSSProperties = { font: `900 30px ${FONT}`, color: LIME, letterSpacing: -1, textShadow: '0 0 18px rgba(205,232,74,0.35)' }
