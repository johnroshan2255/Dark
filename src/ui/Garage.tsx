import { useState, type CSSProperties } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import { PAINTS, TUNE_RANGES, VEHICLES, vehicleClass, vehicleRating, vehicleStats } from '../gameplay/vehicle/catalogue'
import { CAR_IMAGES } from './carImages'
import { ACCENT, ACCENT_GRAD, bigButton, FONT, fullscreen, glass, heading, label, smallButton, statFill, statRow, statTrack, vignette } from './theme'

/**
 * THE GARAGE — a racing-game car screen: a strip of car cards along the top (tap one → it is swapped into the
 * world live, on the turntable behind), the chosen car's name / class / rating, and a tabbed panel:
 * PERFORMANCE (sliders with live stat bars) · PAINT (named swatches + custom colour). Every change applies at once
 * and is saved per car. `embedded` = inside Settings (no back / select buttons, tighter layout).
 */
export function Garage({ game, embedded = false }: { game: Game; embedded?: boolean }) {
  const landing = useStore(game.store, (s) => s.landing)
  const screen = useStore(game.store, (s) => s.screen)
  const current = useStore(game.store, (s) => s.vehicle)
  const loading = useStore(game.store, (s) => s.vehicleLoading)
  const settings = useStore(game.store, (s) => s.settings)
  const touch = useStore(game.store, (s) => s.touch)
  const [tab, setTab] = useState<'performance' | 'paint'>('performance')
  if (!embedded && (!landing || screen !== 'garage')) return null
  const def = VEHICLES.find((v) => v.id === current) ?? VEHICLES[0]
  const tune = game.tuning(current)
  const modified = Object.keys(settings.garage.tuning[current] ?? {}).length > 0
  const compact = touch || embedded

  const strip = (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '2px 2px 6px', scrollbarWidth: 'thin' }} data-testid="car-strip">
      {VEHICLES.map((v) => {
        const active = v.id === current
        const t = game.tuning(v.id)
        return (
          <button key={v.id} style={{ ...carCard, ...(active ? carCardActive : {}), ...(compact ? { width: touch && !embedded ? 118 : 150, padding: 6 } : {}) }} onClick={() => void game.selectVehicle(v.id)} disabled={loading !== null} data-testid={`car-${v.id}`}>
            {!(touch && !embedded) && <img src={CAR_IMAGES[v.id]} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 8, display: 'block', filter: active ? 'none' : 'saturate(0.7) brightness(0.85)' }} />}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 7 }}>
              <div>
                <div style={{ font: `800 ${compact ? 13 : 15}px ${FONT}`, color: '#fff' }}>{v.name}</div>
                <div style={{ ...label, fontSize: 10, marginTop: 2 }}>{vehicleClass(t)}</div>
              </div>
              <div style={{ font: `900 ${compact ? 20 : 24}px ${FONT}`, color: active ? ACCENT : 'rgba(255,255,255,0.6)' }}>{vehicleRating(t)}</div>
            </div>
            {active && loading !== null && <div style={loadBar}><div style={{ width: `${Math.round(loading * 100)}%`, height: '100%', background: ACCENT_GRAD }} /></div>}
            {active && !(touch && !embedded) && <div style={selectedTag}>{loading !== null ? `Loading ${Math.round(loading * 100)}%` : 'Selected'}</div>}
          </button>
        )
      })}
    </div>
  )

  const performance = (
    <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1.35fr 1fr', gap: compact ? 12 : 26 }}>
      <div style={{ display: 'grid', gap: compact ? 6 : 9 }}>
        {TUNE_RANGES.map((r) => {
          const v = tune[r.key] as number
          const pct = (v - r.min) / (r.max - r.min)
          return (
            <label key={r.key} style={{ display: 'grid', gridTemplateColumns: compact ? '86px 1fr 62px' : '120px 1fr 74px', alignItems: 'center', gap: 10 }}>
              <span style={{ ...label, color: 'rgba(255,255,255,0.85)' }}>{r.label}</span>
              <span style={{ position: 'relative', height: 26, display: 'flex', alignItems: 'center' }}>
                <span style={{ ...statTrack, position: 'absolute', left: 0, right: 0 }}><span style={statFill(pct)} /></span>
                <input type="range" min={r.min} max={r.max} step={r.step} value={v} onChange={(e) => game.setTuning(current, { [r.key]: Number(e.target.value) })} style={slider} data-testid={`tune-${r.key}`} />
              </span>
              <span style={{ textAlign: 'right', color: ACCENT, font: `800 13px ${FONT}`, fontVariantNumeric: 'tabular-nums' }}>
                {r.step < 1 ? v.toFixed(r.step < 0.1 ? 2 : 1) : Math.round(v)} <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>{r.unit}</span>
              </span>
            </label>
          )
        })}
      </div>
      <div style={{ ...(compact ? {} : { borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: 26 }) }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
          <span style={{ font: `900 ${compact ? 34 : 46}px ${FONT}`, color: ACCENT, letterSpacing: -1 }}>{vehicleRating(tune)}</span>
          <span style={label}>{vehicleClass(tune)} · overall</span>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {vehicleStats(tune).map((st) => (
            <div key={st.label} style={statRow}>
              <span>{st.label}</span>
              <span style={statTrack}><span style={statFill(st.value)} /></span>
              <span style={{ textAlign: 'right', color: ACCENT }}>{Math.round(st.value * 100)}</span>
            </div>
          ))}
        </div>
        <div style={{ ...label, marginTop: 14, lineHeight: 1.5, textTransform: 'none', letterSpacing: 0.3, fontSize: 12 }}>{def.blurb}</div>
      </div>
    </div>
  )

  const paint = (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${compact ? 64 : 84}px, 1fr))`, gap: compact ? 8 : 12 }}>
        {PAINTS.map((c) => {
          const active = tune.paint.toLowerCase() === c.hex
          return (
            <button key={c.hex} onClick={() => game.setTuning(current, { paint: c.hex })} style={swatch(active)} title={c.name} data-testid={`paint-${c.hex.slice(1)}`}>
              <span style={{ width: compact ? 34 : 44, height: compact ? 34 : 44, borderRadius: '50%', background: c.hex, border: '2px solid rgba(255,255,255,0.35)', boxShadow: active ? `0 0 0 3px ${ACCENT}` : 'inset 0 -6px 12px rgba(0,0,0,0.35)', display: 'block' }} />
              <span style={{ ...label, fontSize: 9, marginTop: 6, color: active ? '#ffd9a0' : 'rgba(255,255,255,0.65)', textAlign: 'center', letterSpacing: 1 }}>{c.name}</span>
            </button>
          )
        })}
        <label style={swatch(!PAINTS.some((c) => c.hex === tune.paint.toLowerCase()))} title="Custom colour">
          <span style={{ width: compact ? 34 : 44, height: compact ? 34 : 44, borderRadius: '50%', background: 'conic-gradient(#f33, #ff3, #3f3, #3ff, #33f, #f3f, #f33)', border: '2px solid rgba(255,255,255,0.35)', display: 'block', position: 'relative', overflow: 'hidden' }}>
            <input type="color" value={tune.paint} onChange={(e) => game.setTuning(current, { paint: e.target.value })} style={{ position: 'absolute', inset: -10, width: '200%', height: '200%', opacity: 0, cursor: 'pointer' }} />
          </span>
          <span style={{ ...label, fontSize: 9, marginTop: 6, textAlign: 'center', letterSpacing: 1 }}>Custom</span>
        </label>
      </div>
      <div style={{ ...label, marginTop: 12, textTransform: 'none', letterSpacing: 0.3, fontSize: 12 }}>Stock keeps the car's own colours. Paint recolours the body panels and keeps their shading.</div>
    </div>
  )

  const panel = (
    <div style={{ ...(embedded ? {} : glass), padding: embedded ? 0 : compact ? 12 : 18, ...(embedded ? {} : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={smallButton(tab === 'performance')} onClick={() => setTab('performance')} data-testid="tab-performance">Performance</button>
          <button style={smallButton(tab === 'paint')} onClick={() => setTab('paint')} data-testid="tab-paint">Paint</button>
        </div>
        <button style={{ ...smallButton(false), opacity: modified ? 1 : 0.4 }} onClick={() => game.resetTuning(current)} disabled={!modified} data-testid="garage-reset">Reset to stock</button>
      </div>
      {tab === 'performance' ? performance : paint}
    </div>
  )

  if (embedded) {
    return (
      <div data-testid="garage">
        {strip}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '8px 0 10px' }}>
          <span style={heading(18)}>{def.name}</span>
          <span style={label}>{def.maker} · {def.year}</span>
        </div>
        {panel}
      </div>
    )
  }

  return (
    <div style={fullscreen} data-testid="garage">
      <div style={vignette} />
      <div style={{ position: 'absolute', left: compact ? 14 : 40, right: compact ? 14 : 40, top: compact ? 10 : 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={heading(compact ? 22 : 40)}>Garage</div>
          <div style={{ ...label, marginTop: 6 }}>{def.maker} · {def.year} · {def.name}</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button style={{ ...bigButton(false, compact ? 110 : 170), height: compact ? 40 : 52, fontSize: compact ? 13 : 17, letterSpacing: compact ? 2 : 4, justifyContent: 'center' }} onClick={() => game.showScreen('menu')} data-testid="garage-back"><span>‹ Back</span></button>
          <button style={{ ...bigButton(true, compact ? 130 : 200), height: compact ? 40 : 52, fontSize: compact ? 13 : 17, letterSpacing: compact ? 2 : 4, opacity: loading !== null ? 0.5 : 1 }} onClick={() => game.play()} disabled={loading !== null} data-testid="garage-drive"><span>Drive</span><span>▶</span></button>
        </div>
      </div>
      <div style={{ position: 'absolute', left: compact ? 14 : 40, right: compact ? 14 : 40, bottom: compact ? 8 : 34, display: 'grid', gap: compact ? 6 : 12, maxHeight: compact ? '74vh' : '62vh', gridTemplateRows: 'auto 1fr' }}>
        {strip}
        <div style={{ overflowY: 'auto', minHeight: 0 }}>{panel}</div>
      </div>
    </div>
  )
}

const carCard: CSSProperties = { ...glass, flex: '0 0 auto', width: 230, padding: 8, textAlign: 'left', cursor: 'pointer', color: '#fff', position: 'relative', borderRadius: 12 }
const carCardActive: CSSProperties = { border: `2px solid ${ACCENT}`, boxShadow: `0 0 0 3px rgba(240,160,58,0.2), 0 12px 40px rgba(0,0,0,0.35)` }
const selectedTag: CSSProperties = { position: 'absolute', top: 14, left: 14, padding: '3px 8px', borderRadius: 6, background: ACCENT_GRAD, color: '#1a0f04', font: `900 10px ${FONT}`, letterSpacing: 1.5, textTransform: 'uppercase' }
const loadBar: CSSProperties = { position: 'absolute', left: 8, right: 8, bottom: 6, height: 3, background: 'rgba(255,255,255,0.15)', borderRadius: 2, overflow: 'hidden' }
const slider: CSSProperties = { position: 'relative', width: '100%', margin: 0, accentColor: ACCENT, background: 'transparent', height: 26, opacity: 0.9 }
const swatch = (active: boolean): CSSProperties => ({ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 6, borderRadius: 10, border: `1px solid ${active ? ACCENT : 'transparent'}`, background: active ? 'rgba(240,160,58,0.12)' : 'transparent', cursor: 'pointer' })
