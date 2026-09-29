import type { CSSProperties, ReactNode } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'
import type { Settings } from '../game/Settings'

type Opt<T> = { label: string; value: T }

/**
 * Settings overlay (O key, ⚙ button). Changes apply immediately and persist (Game.updateSettings).
 * Low-frequency UI → plain React state from the store is fine here.
 */
export function SettingsPanel({ game }: { game: Game }) {
  const open = useStore(game.store, (s) => s.settingsOpen)
  const st = useStore(game.store, (s) => s.settings)
  const tier = useStore(game.store, (s) => s.tier)
  const phase = useStore(game.store, (s) => s.phase)
  const nightmare = useStore(game.store, (s) => s.nightmare)
  if (!open) return null
  const set = (patch: Partial<Settings>) => game.updateSettings(patch)

  return (
    <div style={backdrop} onPointerDown={(e) => e.target === e.currentTarget && game.openSettings(false)} data-testid="settings">
      <div style={panel} onPointerDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <span>SETTINGS</span>
          <button style={closeBtn} onClick={() => game.openSettings(false)} data-testid="settings-close">✕</button>
        </div>

        <Section title="Graphics">
          <Row label={`Quality (now: ${tier})`}>
            <Seg value={st.quality} onChange={(v) => set({ quality: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }]} />
          </Row>
          <Row label="Anti-aliasing">
            <Seg testid="aa" value={st.aa} onChange={(v) => set({ aa: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: 'Off', value: 'off' }, { label: 'FXAA', value: 'fxaa' }, { label: 'MSAA 2×', value: 'msaa2' }, { label: 'MSAA 4×', value: 'msaa4' }]} />
          </Row>
          <Row label="Sharpness">
            <Seg value={st.sharpness} onChange={(v) => set({ sharpness: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: 'Off', value: 0 }, { label: 'Low', value: 0.25 }, { label: 'Med', value: 0.5 }, { label: 'High', value: 0.8 }]} />
          </Row>
          <Row label="Resolution">
            <Seg value={st.resolution} onChange={(v) => set({ resolution: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: '50%', value: 0.5 }, { label: '67%', value: 0.67 }, { label: '85%', value: 0.85 }, { label: '100%', value: 1 }]} />
          </Row>
          <Row label="Art style (reloads)">
            <Seg value={st.artStyle} onChange={(v) => set({ artStyle: v })} opts={[{ label: 'Bright', value: 'bright' }, { label: 'Storybook', value: 'storybook' }]} />
          </Row>
          <Row label="Painterly art filter">
            <Seg value={st.painterly && (tier !== 'low' || st.painterlyForce)} onChange={(v) => set({ painterly: v, painterlyForce: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
          </Row>
          <Row label="Film grain">
            <Seg value={st.filmGrain} onChange={(v) => set({ filmGrain: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
          </Row>
          <Row label="Pixel ratio">
            <Seg value={st.pixelRatio} onChange={(v) => set({ pixelRatio: v })} opts={[{ label: 'Auto', value: 'auto' }, { label: '1×', value: 1 }, { label: '1.5×', value: 1.5 }, { label: '2×', value: 2 }, { label: 'Native', value: 'native' }]} />
          </Row>
        </Section>

        <Section title="Camera & controls">
          <Row label="View">
            <Seg testid="cam" value={st.camera} onChange={(v) => set({ camera: v })} opts={[{ label: 'First person', value: 'fpp' }, { label: 'Third person', value: 'tpp' }]} />
          </Row>
          <Row label="Look sensitivity">
            <Seg value={st.lookSensitivity} onChange={(v) => set({ lookSensitivity: v })} opts={[0.5, 0.75, 1, 1.5, 2].map((v) => ({ label: `${v}×`, value: v }))} />
          </Row>
          <Row label="FPS overlay">
            <Seg value={st.showFps} onChange={(v) => set({ showFps: v })} opts={[{ label: 'On', value: true }, { label: 'Off', value: false }]} />
          </Row>
        </Section>

        <Section title={`World (now: ${phase}${nightmare ? ' · NIGHTMARE' : ''})`}>
          <Row label="Monsters & storms">
            <Seg value={st.monsters} onChange={(v) => set({ monsters: v })} opts={[{ label: 'On', value: true }, { label: 'Off (explore)', value: false }]} />
          </Row>
          <Row label="Day length">
            <Seg value={st.dayLength} onChange={(v) => set({ dayLength: v })} opts={[{ label: 'Paused', value: 0 }, { label: '6 min', value: 6 }, { label: '24 min', value: 24 }, { label: '60 min', value: 60 }]} />
          </Row>
          <Row label="Time">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button style={segBtn(false)} onClick={() => game.toggleDayNight()} data-testid="daynight">☀ / ☾ Day ⇄ Night</button>
              <button style={segBtn(false)} onClick={() => game.tod.nextPreset()}>Next: dawn / day / evening / night</button>
              <button style={segBtn(nightmare)} onClick={() => game.toggleNightmare()}>Nightmare realm</button>
            </div>
          </Row>
        </Section>
        <div style={foot}>Keys: T day/night · G next time · N nightmare · V camera · F flashlight · O settings · F3 FPS</div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={row}>
      <div style={rowLabel}>{label}</div>
      {children}
    </div>
  )
}

function Seg<T extends string | number | boolean>({ value, opts, onChange, testid }: { value: T; opts: Opt<T>[]; onChange: (v: T) => void; testid?: string }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} data-testid={testid}>
      {opts.map((o) => (
        <button key={String(o.value)} style={segBtn(o.value === value)} onClick={() => onChange(o.value)} data-value={String(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center',
  touchAction: 'auto',
}
const panel: CSSProperties = {
  width: 'min(620px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', background: 'rgba(14,16,20,0.94)',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '14px 16px', color: '#dfe3e6',
  font: '12px/1.4 ui-monospace, Menlo, monospace', boxSizing: 'border-box',
}
const header: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, letterSpacing: 2, fontWeight: 700 }
const closeBtn: CSSProperties = { background: 'none', border: 'none', color: '#dfe3e6', fontSize: 16, cursor: 'pointer' }
const sectionTitle: CSSProperties = { opacity: 0.55, marginBottom: 6, letterSpacing: 1, textTransform: 'uppercase', fontSize: 10 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }
const rowLabel: CSSProperties = { width: 150, flexShrink: 0, opacity: 0.85 }
const foot: CSSProperties = { opacity: 0.45, fontSize: 10, marginTop: 4 }
const segBtn = (active: boolean): CSSProperties => ({
  padding: '5px 9px', borderRadius: 5, border: `1px solid ${active ? 'rgba(255,214,150,0.8)' : 'rgba(255,255,255,0.15)'}`,
  background: active ? 'rgba(255,190,110,0.18)' : 'rgba(255,255,255,0.04)', color: active ? '#ffe2b8' : '#cfd3d6',
  font: 'inherit', cursor: 'pointer',
})
