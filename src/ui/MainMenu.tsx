import type { CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { vehicleClass, vehicleDef, vehicleRating, vehicleStats } from '../gameplay/vehicle/catalogue'
import { CAR_IMAGES } from './carImages'
import { ACCENT, bigButton, fullscreen, glass, heading, label, statFill, statRow, statTrack, vignette } from './theme'

/**
 * MAIN MENU — the first screen after loading (the world is live behind it, the camera circling your car):
 * PLAY, GARAGE, SETTINGS stacked on the left like a racing-game front end; the current car's card on the right.
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
  const w = touch ? 200 : 280
  return (
    <div style={fullscreen} data-testid="menu">
      <div style={vignette} />
      <div style={{ position: 'absolute', left: touch ? 18 : 40, top: touch ? 12 : 40 }}>
        <div style={heading(touch ? 34 : 64)}>DARK</div>
        <div style={{ ...label, marginTop: 8 }}>A new world every night · world #{String(seed).slice(0, 8)}</div>
      </div>
      <div style={{ position: 'absolute', left: touch ? 18 : 40, bottom: touch ? 14 : 44, display: 'flex', flexDirection: 'column', gap: touch ? 8 : 12 }}>
        <button style={{ ...bigButton(true, w), height: touch ? 44 : 60 }} onClick={() => game.play()} data-testid="play">
          <span>Play</span><span>▶</span>
        </button>
        <button style={{ ...bigButton(false, w), height: touch ? 40 : 52 }} onClick={() => game.showScreen('garage')} data-testid="menu-garage">
          <span>Garage</span><span style={{ color: ACCENT }}>›</span>
        </button>
        <button style={{ ...bigButton(false, w), height: touch ? 40 : 52 }} onClick={() => game.openSettings(true)} data-testid="menu-settings">
          <span>Settings</span><span style={{ color: ACCENT }}>›</span>
        </button>
      </div>
      {/* Current car card */}
      <button style={{ ...card, ...(touch ? { width: 230, right: 14, bottom: 14, padding: 8 } : {}) }} onClick={() => game.showScreen('garage')} data-testid="menu-car">
        <img src={CAR_IMAGES[def.id]} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 8, display: 'block' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8 }}>
          <div>
            <div style={{ font: '800 16px system-ui, sans-serif', color: '#fff' }}>{def.name}</div>
            <div style={{ ...label, marginTop: 2 }}>{def.maker} · {def.year} · {vehicleClass(tune)}</div>
          </div>
          <div style={rating}>{vehicleRating(tune)}</div>
        </div>
        {!touch && (
          <div style={{ display: 'grid', gap: 5, marginTop: 8 }}>
            {vehicleStats(tune).map((st) => (
              <div key={st.label} style={statRow}>
                <span>{st.label}</span>
                <span style={statTrack}><span style={statFill(st.value)} /></span>
                <span style={{ textAlign: 'right', color: ACCENT }}>{Math.round(st.value * 100)}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ ...label, marginTop: 8, color: ACCENT }}>Change car ›</div>
      </button>
      <div style={{ position: 'absolute', right: 20, top: 16, ...label, opacity: 0.6 }}>{touch ? 'Touch controls' : 'WASD · Shift boost · Space drift · E enter · F lights'}</div>
    </div>
  )
}

const card: CSSProperties = { ...glass, position: 'absolute', right: 40, bottom: 44, width: 300, padding: 10, textAlign: 'left', cursor: 'pointer', color: '#fff' }
const rating: CSSProperties = { font: '900 30px system-ui, sans-serif', color: ACCENT, letterSpacing: -1 }
