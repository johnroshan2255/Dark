import type { CSSProperties } from 'react'

/**
 * Front-end design tokens (main menu, garage, settings), taken from the KEY ART (src/assets/ui/key-art.jpg): a
 * sunset — amber / tangerine for the one primary action, dusk-violet glass for panels, cream text, and the truck's
 * lime for highlights (ratings, selection). Big uppercase headings, large touch targets. Sizes that must shrink on a
 * phone use clamp(); layouts that change shape live in ui/frontend.css (media queries).
 */
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
export const ACCENT = '#ffb45c' // sunset amber
export const ACCENT_GRAD = 'linear-gradient(135deg, #ffd27a 0%, #ff9a45 55%, #f26b3a 100%)'
export const LIME = '#cde84a' // the truck
export const CREAM = '#fff4e3'
const DUSK = 'rgba(28, 24, 52, 0.62)' // the sky above the sunset
const EDGE = 'rgba(255, 214, 170, 0.18)'

export const glass: CSSProperties = {
  background: `linear-gradient(160deg, rgba(44,36,74,0.66) 0%, ${DUSK} 60%, rgba(18,16,34,0.7) 100%)`, border: `1px solid ${EDGE}`, borderRadius: 16,
  backdropFilter: 'blur(18px) saturate(1.2)', WebkitBackdropFilter: 'blur(18px) saturate(1.2)', boxShadow: '0 18px 48px rgba(10,6,24,0.45), inset 0 1px 0 rgba(255,236,210,0.08)',
}

export const heading = (size = 34): CSSProperties => ({
  font: `900 ${size}px/1 ${FONT}`, letterSpacing: size * 0.12, color: CREAM, textTransform: 'uppercase', textShadow: '0 2px 18px rgba(40,10,0,0.45)',
})

export const label: CSSProperties = { font: `700 11px ${FONT}`, letterSpacing: 2, color: 'rgba(255,236,214,0.66)', textTransform: 'uppercase' }

export const bigButton = (primary = false, wide = 280): CSSProperties => ({
  width: wide, maxWidth: '100%', height: 56, padding: '0 22px', borderRadius: 14, border: primary ? '1px solid rgba(255,230,190,0.55)' : `1px solid ${EDGE}`,
  background: primary ? ACCENT_GRAD : DUSK, color: primary ? '#2a1405' : CREAM,
  font: `900 17px ${FONT}`, letterSpacing: 4, textTransform: 'uppercase', textAlign: 'left',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  boxShadow: primary ? '0 12px 32px rgba(242,107,58,0.42), inset 0 1px 0 rgba(255,255,255,0.45)' : '0 8px 24px rgba(10,6,24,0.35)',
  backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
})

export const smallButton = (active = false): CSSProperties => ({
  padding: '9px 16px', borderRadius: 999, border: `1px solid ${active ? ACCENT : EDGE}`,
  background: active ? 'rgba(255,170,90,0.2)' : 'rgba(255,236,214,0.05)', color: active ? '#ffe0b8' : CREAM,
  font: `800 12px ${FONT}`, letterSpacing: 2, textTransform: 'uppercase', whiteSpace: 'nowrap',
})

export const tabButton = (active: boolean): CSSProperties => ({
  padding: '12px 18px', borderRadius: 12, border: `1px solid ${active ? 'rgba(255,180,92,0.45)' : 'transparent'}`, textAlign: 'left', width: '100%',
  background: active ? 'linear-gradient(90deg, rgba(255,154,69,0.26), rgba(255,154,69,0.06))' : 'transparent', color: active ? '#ffe0b8' : 'rgba(255,236,214,0.72)',
  font: `800 13px ${FONT}`, letterSpacing: 2.5, textTransform: 'uppercase', whiteSpace: 'nowrap',
})

/** Horizontal stat bar with a label and a value. */
export const statRow: CSSProperties = { display: 'grid', gridTemplateColumns: '78px 1fr 34px', alignItems: 'center', gap: 10, font: `800 11px ${FONT}`, letterSpacing: 1.5, color: 'rgba(255,236,214,0.82)', textTransform: 'uppercase' }
export const statTrack: CSSProperties = { height: 6, background: 'rgba(255,236,214,0.12)', borderRadius: 3, overflow: 'hidden' }
export const statFill = (v: number, active = true): CSSProperties => ({ width: `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`, height: '100%', background: active ? ACCENT_GRAD : 'rgba(255,236,214,0.45)', borderRadius: 3, transition: 'width .25s ease' })

export const fullscreen: CSSProperties = { position: 'fixed', inset: 0, zIndex: 40, fontFamily: FONT, pointerEvents: 'auto', color: CREAM }
/** Over the key art: the bright sunset on the left needs a dusk scrim behind the title and the buttons. */
export const vignette: CSSProperties = {
  position: 'absolute', inset: 0, pointerEvents: 'none',
  background: 'linear-gradient(90deg, rgba(20,14,40,0.72) 0%, rgba(20,14,40,0.35) 30%, rgba(20,14,40,0) 55%), linear-gradient(180deg, rgba(14,10,30,0.45) 0%, rgba(14,10,30,0) 25%, rgba(14,10,30,0) 60%, rgba(10,8,22,0.7) 100%)',
}
