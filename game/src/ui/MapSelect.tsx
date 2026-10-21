import type { CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { MAPS, type MapInfo } from '../world/map/FixedMap'
import { KeyArt } from './KeyArt'
import { ACCENT, FONT, fullscreen, glass, heading, label, LIME, vignette } from './theme'

/**
 * SELECT MAP — the hand-made maps (world/map/FixedMap.ts MAPS) as cards over the dimmed key art: a top-down preview,
 * name, one line, area and regions, PLAY. Playing a map other than the loaded world reloads the game on it
 * (`?map=<id>&play=1`: the world, its workers and the physics are built for one map per session).
 */
export function MapSelect({ game }: { game: Game }) {
  const landing = useStore(game.store, (s) => s.landing)
  const screen = useStore(game.store, (s) => s.screen)
  const touch = useStore(game.store, (s) => s.touch)
  if (!landing || screen !== 'maps') return null
  return (
    <div style={fullscreen} data-testid="maps">
      <KeyArt />
      <div style={vignette} />
      <div style={{ position: 'absolute', inset: 'clamp(10px, 4vh, 40px) clamp(10px, 3vw, 40px)', display: 'flex', flexDirection: 'column', gap: 'clamp(10px, 2vh, 20px)', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={heading(touch ? 24 : 34)}>Select map</div>
            <div style={{ ...label, marginTop: 4 }}>Hand-made worlds · same truck, same night</div>
          </div>
          <button className="fe-btn fe-btn--compact" style={{ width: 'auto', padding: '0 18px' }} onClick={() => game.showScreen('menu')} data-testid="maps-back">
            <span>‹ Back</span>
          </button>
        </div>
        <div style={{ ...grid, gridTemplateColumns: touch ? 'repeat(auto-fill, minmax(320px, 1fr))' : 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {MAPS.map((m) => <MapCard key={m.id} map={m} game={game} compact={touch} />)}
          <div style={{ ...glass, ...card, ...soon, ...(touch ? { minHeight: 80 } : {}) }}>
            <div style={{ font: `800 15px ${FONT}`, color: 'rgba(255,244,227,0.7)' }}>More maps coming</div>
            <div style={{ ...label, marginTop: 6, textAlign: 'center' }}>New worlds are added here</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function MapCard({ map, game, compact }: { map: MapInfo; game: Game; compact: boolean }) {
  const current = game.map?.id === map.id
  return (
    // phones (landscape): preview beside the details, so PLAY stays on screen
    <div style={{ ...glass, ...card, ...(compact ? { flexDirection: 'row', gap: 12, alignItems: 'stretch' } : {}) }} data-testid={`map-${map.id}`}>
      <img src={map.preview} alt="" style={compact ? { width: 132, height: 132, objectFit: 'cover', borderRadius: 10, flexShrink: 0 } : { width: '100%', aspectRatio: '1 / 1', maxHeight: 260, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: compact ? 0 : 10, gap: 8 }}>
        <div style={{ font: `800 ${compact ? 16 : 19}px ${FONT}`, color: '#fff' }}>{map.name}</div>
        <div style={{ font: `800 12px ${FONT}`, color: LIME, whiteSpace: 'nowrap' }}>{map.areaKm2.toFixed(1)} km²</div>
      </div>
      {!compact && <div style={{ font: `13px/1.45 ${FONT}`, color: 'rgba(255,244,227,0.78)', marginTop: 6 }}>{map.blurb}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {(compact ? map.regions.slice(0, 3) : map.regions).map((r) => <span key={r} style={chip}>{r}</span>)}
      </div>
      <button className="fe-btn fe-btn--primary" style={{ marginTop: compact ? 'auto' : 12 }} onClick={() => playMap(game, map.id)} data-testid={`play-${map.id}`}>
        <span>{current ? 'Play' : 'Play map'}</span><span className="fe-chev">▶</span>
      </button>
      </div>
    </div>
  )
}

/** Start map `id` (null = the endless world): hand over control if it is the loaded world, else reload on it. */
export function playMap(game: Game, id: string | null): void {
  if ((game.map?.id ?? null) === id) {
    game.play()
    return
  }
  const p = new URLSearchParams(location.search)
  p.delete('seed')
  p.delete('room')
  if (id) p.set('map', id)
  else p.delete('map')
  p.set('play', '1')
  location.search = p.toString()
}

const grid: CSSProperties = { display: 'grid', gap: 'clamp(10px, 1.6vw, 18px)', overflowY: 'auto', minHeight: 0, paddingBottom: 8, alignContent: 'start' }
const card: CSSProperties = { padding: 'clamp(10px, 1.2vw, 14px)', display: 'flex', flexDirection: 'column' }
const soon: CSSProperties = { alignItems: 'center', justifyContent: 'center', minHeight: 160, borderStyle: 'dashed' }
const chip: CSSProperties = { font: `700 10px ${FONT}`, letterSpacing: 1.2, textTransform: 'uppercase', color: ACCENT, padding: '3px 8px', borderRadius: 999, border: '1px solid rgba(255,180,92,0.4)', background: 'rgba(255,154,69,0.1)' }
