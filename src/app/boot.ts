/**
 * Drives the static loading screen in index.html (#boot): it is on screen from the first byte, before any JS
 * (the physics wasm alone is ~4 MB), so there is never a blank page. Stages report progress here; `finish()`
 * fades it out once the world around the player is built and the first frames have rendered.
 * Plain DOM, no React: it must work before and during React's first render.
 */
const el = (id: string) => document.getElementById(id)

const TIPS = [
  'Tip: the truck climbs almost any hill — the bike doesn’t.',
  'Tip: lean into turns on the bike — hit a tree at speed and you’re off.',
  'Tip: Space is the handbrake in the truck. Slide it.',
  'Tip: every game is a new world. Share ?seed= to play the same one.',
  'Tip: F toggles the flashlight — the dark is not empty.',
  'Tip: press V for first person — look at your hands on the wheel.',
  'Tip: T skips to night. Monsters come with it.',
]

let shown = 0
let tipTimer = 0

export function bootProgress(fraction: number, status?: string): void {
  // Never goes backwards (stages overlap); leaves room for the final fade.
  shown = Math.max(shown, Math.min(0.99, fraction))
  el('boot')?.classList.add('live')
  const fill = el('boot-fill'), pct = el('boot-pct'), st = el('boot-status')
  if (fill) fill.style.width = `${Math.max(4, shown * 100).toFixed(1)}%`
  if (pct) pct.textContent = `${Math.round(shown * 100)}%`
  if (status && st) st.textContent = status
  if (!tipTimer) {
    let i = 0
    tipTimer = window.setInterval(() => {
      const tip = el('boot-tip')
      if (!tip) return
      i = (i + 1) % TIPS.length
      tip.style.opacity = '0'
      window.setTimeout(() => ((tip.textContent = TIPS[i]), (tip.style.opacity = '0.7')), 400)
    }, 4200)
  }
}

export function bootError(message: string): void {
  const st = el('boot-status'), tip = el('boot-tip')
  if (st) st.textContent = 'Failed to start'
  if (tip) (tip.textContent = message), tip.classList.add('err')
  window.clearInterval(tipTimer)
}

/** Fade out and remove the loading screen. */
export function bootFinish(): void {
  const boot = el('boot')
  if (!boot || boot.classList.contains('done')) return
  const fill = el('boot-fill'), pct = el('boot-pct'), st = el('boot-status')
  if (fill) fill.style.width = '100%'
  if (pct) pct.textContent = '100%'
  if (st) st.textContent = 'Ready'
  window.clearInterval(tipTimer)
  window.setTimeout(() => boot.classList.add('done'), 150)
  window.setTimeout(() => boot.remove(), 1000)
}
