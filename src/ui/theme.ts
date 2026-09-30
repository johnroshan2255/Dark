import type { CSSProperties } from 'react'

/**
 * Front-end design tokens (main menu, garage, settings): a dark glass UI with one warm accent, big uppercase
 * headings and large touch targets — the look of a modern racing-game front end.
 */
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
export const ACCENT = '#f0a03a'
export const ACCENT_GRAD = 'linear-gradient(135deg, #f7c15a 0%, #ec7a2c 100%)'

export const glass: CSSProperties = {
  background: 'rgba(8,10,14,0.72)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14,
  backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
}

export const heading = (size = 34): CSSProperties => ({
  font: `900 ${size}px/1 ${FONT}`, letterSpacing: size * 0.12, color: '#fff', textTransform: 'uppercase', textShadow: '0 2px 18px rgba(0,0,0,0.5)',
})

export const label: CSSProperties = { font: `700 11px ${FONT}`, letterSpacing: 2, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }

export const bigButton = (primary = false, wide = 280): CSSProperties => ({
  width: wide, height: 56, padding: '0 22px', borderRadius: 10, border: primary ? 'none' : '1px solid rgba(255,255,255,0.18)',
  background: primary ? ACCENT_GRAD : 'rgba(10,12,16,0.66)', color: primary ? '#1a0f04' : '#fff',
  font: `900 17px ${FONT}`, letterSpacing: 4, textTransform: 'uppercase', textAlign: 'left',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  boxShadow: primary ? '0 10px 30px rgba(236,122,44,0.4)' : '0 6px 20px rgba(0,0,0,0.3)', backdropFilter: 'blur(10px)',
})

export const smallButton = (active = false): CSSProperties => ({
  padding: '9px 16px', borderRadius: 8, border: `1px solid ${active ? ACCENT : 'rgba(255,255,255,0.18)'}`,
  background: active ? 'rgba(240,160,58,0.18)' : 'rgba(255,255,255,0.05)', color: active ? '#ffd9a0' : '#fff',
  font: `800 12px ${FONT}`, letterSpacing: 2, textTransform: 'uppercase', whiteSpace: 'nowrap',
})

export const tabButton = (active: boolean): CSSProperties => ({
  padding: '12px 18px', borderRadius: 10, border: 'none', textAlign: 'left', width: '100%',
  background: active ? 'rgba(240,160,58,0.16)' : 'transparent', color: active ? '#ffd9a0' : 'rgba(255,255,255,0.75)',
  font: `800 13px ${FONT}`, letterSpacing: 2.5, textTransform: 'uppercase',
  borderLeft: `3px solid ${active ? ACCENT : 'transparent'}`,
})

/** Horizontal stat bar with a label and a value. */
export const statRow: CSSProperties = { display: 'grid', gridTemplateColumns: '78px 1fr 34px', alignItems: 'center', gap: 10, font: `800 11px ${FONT}`, letterSpacing: 1.5, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase' }
export const statTrack: CSSProperties = { height: 6, background: 'rgba(255,255,255,0.12)', borderRadius: 3, overflow: 'hidden' }
export const statFill = (v: number, active = true): CSSProperties => ({ width: `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`, height: '100%', background: active ? ACCENT_GRAD : 'rgba(255,255,255,0.45)', borderRadius: 3, transition: 'width .25s ease' })

export const fullscreen: CSSProperties = { position: 'fixed', inset: 0, zIndex: 40, fontFamily: FONT, pointerEvents: 'auto', color: '#fff' }
export const vignette: CSSProperties = { position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.75) 100%)', pointerEvents: 'none' }
