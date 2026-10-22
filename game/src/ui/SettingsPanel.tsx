import { useState, type CSSProperties, type ReactNode } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import type { Settings } from '../game/Settings'
import { Garage } from './Garage'
import { FEATURE_LABELS, FEATURE_LEVELS, FEATURES, PRESETS, type Level } from '../rendering/quality/QualityTiers'
import { FONT, fullscreen, glass, heading, label, tabButton } from './theme'
import { KeyArt } from './KeyArt'

type Opt<T> = { label: string; value: T }
const LEVEL_LABEL: Record<Level, string> = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' }

/**
 * Settings overlay (O key, ⚙ button). Changes apply immediately and persist (Game.updateSettings).
 * Low-frequency UI → plain React state from the store is fine here.
 */
type Tab = 'garage' | 'graphics' | 'audio' | 'controls' | 'world'
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'garage', label: 'Garage', icon: '🚙' },
  { id: 'graphics', label: 'Graphics', icon: '◧' },
  { id: 'audio', label: 'Audio', icon: '♪' },
  { id: 'controls', label: 'Controls', icon: '⌨' },
  { id: 'world', label: 'World', icon: '☾' },
]

/**
 * SETTINGS — a full-page tabbed screen (racing-game style): tabs down the left (Garage / Graphics / Controls /
 * World), the page on the right. Opens from the main menu, the ⚙ button and O. Changes apply immediately and
 * persist (Game.updateSettings). Low-frequency UI → plain React state from the store is fine here.
 */
export function SettingsPanel({ game }: { game: Game }) {
  const open = useStore(game.store, (s) => s.settingsOpen)
  const st = useStore(game.store, (s) => s.settings)
  const tier = useStore(game.store, (s) => s.tier)
  const held = useStore(game.store, (s) => s.held)
  const fpsCap = useStore(game.store, (s) => s.fpsCap)
  const phase = useStore(game.store, (s) => s.phase)
  const nightmare = useStore(game.store, (s) => s.nightmare)
  const touch = useStore(game.store, (s) => s.touch)
  const landing = useStore(game.store, (s) => s.landing)
  const [tab, setTab] = useState<Tab>('garage')
  if (!open) return null
  const set = (patch: Partial<Settings>) => game.updateSettings(patch)
  const custom = FEATURES.some((f) => st.gfx[f] !== undefined && st.gfx[f] !== 'auto')

  const page =
    tab === 'garage' ? (
      <Garage game={game} embedded />
    ) : tab === 'graphics' ? (
      <>
        <Row label={`Preset (now: ${tier}${custom ? ', custom' : ''})`}>
          <Seg testid="preset" value={st.quality} onChange={(v) => set({ quality: v, gfx: {} })} opts={[{ label: 'Auto', value: 'auto' }, { label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }, { label: 'Ultra', value: 'ultra' }]} />
        </Row>
        <div className="fe-help">
          A preset sets every feature below; change any of them to make it your own. Auto picks Low–High for this device and adapts to keep 60 fps — Ultra is only used when you choose it.
          {custom && <button className="fe-seg" style={{ marginLeft: 8, padding: '3px 10px' }} onClick={() => set({ gfx: {} })} data-testid="gfx-reset">Reset to preset</button>}
        </div>
        <Row label="Hold 60 fps">
          <Seg testid="hold60" value={st.hold60} onChange={(v) => set({ hold60: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
        <div className="fe-help" style={{ color: held || fpsCap ? '#ffd9a0' : undefined }}>
          {fpsCap
            ? 'Your browser is limiting the game to 30 fps (iPhone Low Power Mode or Android battery saver). Turn that off for 60 fps — lowering graphics will not help.'
            : held
              ? `Holding 60 fps — lowered for now: ${held}. They come back when the device has headroom.`
              : 'On: if frames run long, the resolution drops a little first, then the costliest features step down one level (reflections, ambient occlusion, shadows…) and return when there is headroom. Your preset is the ceiling.'}
        </div>
        {FEATURES.map((f) => (
          <Row key={f} label={FEATURE_LABELS[f]}>
            <Seg testid={`gfx-${f}`} value={st.gfx[f] ?? 'auto'} onChange={(v) => set({ gfx: { ...st.gfx, [f]: v } })}
              opts={[{ label: `Auto · ${LEVEL_LABEL[PRESETS[tier].features[f]]}`, value: 'auto' as Level | 'auto' }, ...FEATURE_LEVELS[f].map((l) => ({ label: LEVEL_LABEL[l], value: l as Level | 'auto' }))]} />
          </Row>
        ))}
        <div style={{ height: 8 }} />
        <Row label="Anti-aliasing">
          <Seg testid="aa" value={st.aa} onChange={(v) => set({ aa: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: 'Off', value: 'off' }, { label: 'FXAA', value: 'fxaa' }, { label: 'MSAA 2×', value: 'msaa2' }, { label: 'MSAA 4×', value: 'msaa4' }]} />
        </Row>
        <Row label="Sharpness">
          <Seg value={st.sharpness} onChange={(v) => set({ sharpness: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: 'Off', value: 0 }, { label: 'Low', value: 0.25 }, { label: 'Med', value: 0.5 }, { label: 'High', value: 0.8 }]} />
        </Row>
        <Row label="Resolution">
          <Seg value={st.resolution} onChange={(v) => set({ resolution: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: '50%', value: 0.5 }, { label: '67%', value: 0.67 }, { label: '85%', value: 0.85 }, { label: '100%', value: 1 }]} />
        </Row>
        <Row label="Pixel ratio">
          <Seg value={st.pixelRatio} onChange={(v) => set({ pixelRatio: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: '1×', value: 1 }, { label: '1.5×', value: 1.5 }, { label: '2×', value: 2 }, { label: 'Native', value: 'native' }]} />
        </Row>
        <Row label="Painterly filter">
          <Seg value={st.painterly && (tier !== 'low' || st.painterlyForce)} onChange={(v) => set({ painterly: v, painterlyForce: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
        <Row label="Film grain">
          <Seg value={st.filmGrain} onChange={(v) => set({ filmGrain: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
        <Row label="FPS overlay">
          <Seg value={st.showFps} onChange={(v) => set({ showFps: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
      </>
    ) : tab === 'audio' ? (
      <>
        <Row label="Sound">
          <Seg testid="sound" value={st.sound} onChange={(v) => set({ sound: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
        <Row label="Theme music">
          <Seg testid="music" value={st.music} onChange={(v) => set({ music: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
        <div style={{ ...label, marginTop: 16, textTransform: 'none', letterSpacing: 0.3, fontSize: 12, lineHeight: 1.6, maxWidth: 560 }}>
          Sound switches everything off at once. Theme music is the warm banjo piece that plays by day and fades out as night falls.
        </div>
      </>
    ) : tab === 'controls' ? (
      <>
        <Row label="View">
          <Seg testid="cam" value={st.camera} onChange={(v) => set({ camera: v })} opts={[{ label: 'First person', value: 'fpp' }, { label: 'Third person', value: 'tpp' }]} />
        </Row>
        <Row label="Driving">
          <Seg testid="handling" value={st.handling} onChange={(v) => set({ handling: v })} opts={[{ label: 'Simulation', value: 'sim' }, { label: 'Arcade (Asphalt-style)', value: 'arcade' }]} />
        </Row>
        <Row label="Gearbox (simulation)">
          <Seg testid="gearbox" value={st.gearbox} onChange={(v) => set({ gearbox: v })} opts={[{ label: 'Automatic', value: 'auto' }, { label: 'Manual (X / Z)', value: 'manual' }]} />
        </Row>
        <Row label="Driving aids (simulation)">
          <Seg testid="aids" value={st.aids} onChange={(v) => set({ aids: v })} opts={[{ label: 'Auto (smooth)', value: 'auto' }, { label: 'Off', value: 'off' }, { label: 'Standard', value: 'std' }, { label: 'Full', value: 'full' }]} />
        </Row>
        <Row label="Off-road assist (simulation)">
          <Seg testid="offroad" value={st.offroadAssist} onChange={(v) => set({ offroadAssist: v })} opts={[{ label: 'On — more torque, 80° walls', value: true }, { label: 'Off — the real machine', value: false }]} />
        </Row>
        <Row label="Auto accelerate (touch)">
          <Seg value={st.autoAccelerate} onChange={(v) => set({ autoAccelerate: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
        <Row label="Look sensitivity">
          <Seg value={st.lookSensitivity} onChange={(v) => set({ lookSensitivity: v })} opts={[0.5, 0.75, 1, 1.5, 2].map((v) => ({ label: `${v}×`, value: v }))} />
        </Row>
        <div style={{ ...label, marginTop: 18, marginBottom: 8 }}>Keys</div>
        <div style={keys}>
          {[['W A S D', 'Drive / walk (S = brake · reverse)'], ['Space', 'Handbrake: stop · steer + Space = slide turn · jump'], ['Shift', 'Nitro · sprint'], ['E', 'Get in / out'], ['X · Z', 'Gear up / down (manual)'], ['Q', 'Low range'], ['K', '4WD (4H) · lock differentials'], ['F', 'Headlights · torch'], ['V', 'Camera'], ['T · G', 'Day / night · next time'], ['N', 'Nightmare'], ['O', 'Settings'], ['R', 'Weather'], ['F3', 'FPS overlay']].map(([k, v]) => (
            <div key={k} style={keyRow}><span style={keyCap}>{k}</span><span>{v}</span></div>
          ))}
        </div>
      </>
    ) : (
      <>
        <Row label="Night ghosts">
          <Seg value={st.nightGhosts} onChange={(v) => set({ nightGhosts: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
        </Row>
        <Row label="Day length">
          <Seg value={st.dayLength} onChange={(v) => set({ dayLength: v })} opts={[{ label: 'Paused', value: 0 }, { label: '6 min', value: 6 }, { label: '24 min', value: 24 }, { label: '60 min', value: 60 }]} />
        </Row>
        <Row label={`Time (now: ${phase}${nightmare ? ' · NIGHTMARE' : ''})`}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="fe-seg" onClick={() => game.toggleDayNight()} data-testid="daynight">☀ / ☾ Day ⇄ Night</button>
            <button className="fe-seg" onClick={() => game.tod.nextPreset()}>Next: dawn / day / evening / night</button>
            <button className="fe-seg" aria-pressed={nightmare} onClick={() => game.toggleNightmare()}>Nightmare realm</button>
          </div>
        </Row>
        <Row label="Weather">
          <Seg value={game.weather.force ?? 'auto'} onChange={(v) => { game.weather.force = v === 'auto' ? null : (v as 'clear' | 'cloudy' | 'rain') }} opts={[{ label: 'Auto', value: 'auto' }, { label: 'Clear', value: 'clear' }, { label: 'Cloudy', value: 'cloudy' }, { label: 'Rain', value: 'rain' }]} />
        </Row>
      </>
    )

  // (over the menu: the key art behind a dusk blur; in game: the paused world behind it)
  return (
    <div style={fullscreen} data-testid="settings">
      {landing && <KeyArt />}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(120deg, rgba(20,14,40,0.86) 0%, rgba(26,18,46,0.74) 55%, rgba(40,20,30,0.62) 100%)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' }} onPointerDown={(e) => e.target === e.currentTarget && game.openSettings(false)} />
      <div className="fe-settings">
        <div className="fe-settings-nav">
          <div className="fe-settings-heading" style={{ ...heading(touch ? 22 : 36), marginBottom: touch ? 8 : 18 }}>Settings</div>
          <div className="fe-settings-tabs">
            {TABS.map((t) => (
              <button key={t.id} style={tabButton(tab === t.id)} onClick={() => setTab(t.id)} data-testid={`settings-tab-${t.id}`}>
                <span style={{ marginRight: 10, opacity: 0.8 }}>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>
          <div className="fe-spacer" style={{ flex: 1 }} />
          <button className="fe-btn fe-btn--primary fe-btn--compact" onClick={() => game.openSettings(false)} data-testid="settings-close"><span>Done</span><span className="fe-chev">✓</span></button>
        </div>
        <div className="fe-settings-page" style={{ ...glass, color: '#efe6dc', font: `13px/1.5 ${FONT}` }}>
          <div style={{ ...heading(touch ? 16 : 22), marginBottom: 14 }}>{TABS.find((t) => t.id === tab)!.label}</div>
          {page}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fe-row">
      <div className="fe-row-label">{label}</div>
      {children}
    </div>
  )
}

function Seg<T extends string | number | boolean>({ value, opts, onChange, testid }: { value: T; opts: Opt<T>[]; onChange: (v: T) => void; testid?: string }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} data-testid={testid}>
      {opts.map((o) => (
        <button key={String(o.value)} className="fe-seg" aria-pressed={o.value === value} onClick={() => onChange(o.value)} data-value={String(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const keys: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }
const keyRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, font: `12px ${FONT}`, color: 'rgba(255,255,255,0.8)' }
const keyCap: CSSProperties = { minWidth: 64, padding: '4px 8px', borderRadius: 8, border: '1px solid rgba(255,214,170,0.28)', background: 'rgba(255,236,214,0.06)', font: `800 11px ${FONT}`, letterSpacing: 1, textAlign: 'center', color: '#ffd9a0' }

