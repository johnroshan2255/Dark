import type { Game } from '../game/Game'

/**
 * DEV-ONLY REMOTE HUD: every 2 s the game POSTs what the F3 HUD shows (GPU, preset, Hold-60 reductions, fps, worst
 * frame, CPU / GPU ms, resolution chain, draws) to the dev server (vite.config `devTelemetry` →
 * node_modules/.cache/telemetry.jsonl). Lets a phone on the LAN (`npm run dev:lan`) be measured from the desktop
 * without remote debugging. Never bundled in production (App imports it behind `import.meta.env.DEV`).
 */
export function startDevTelemetry(g: Game): () => void {
  const id = Math.random().toString(36).slice(2, 8) // (dev tooling, not world generation)
  let worst = 0
  let frames = 0
  let last = performance.now()
  let raf = 0
  const tick = () => {
    const s = g.perf?.stats
    if (s) worst = Math.max(worst, s.rawFrameMs)
    frames++
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  const timer = setInterval(() => {
    const now = performance.now()
    const s = g.perf?.stats
    const st = g.store.get()
    const body = {
      id,
      t: new Date().toISOString(),
      ua: navigator.userAgent,
      gpu: g.device?.gpu,
      detected: g.device ? `${g.device.tier} (${g.device.reason})` : null,
      setting: g.settings.quality,
      hold60: g.settings.hold60,
      tier: g.quality.name,
      held: st.held,
      last: g.lastQualityChange,
      adaptive: g.adaptive.state,
      fps: +((frames * 1000) / (now - last)).toFixed(1),
      worstMs: +worst.toFixed(1),
      cpuMs: s ? +s.cpuMs.toFixed(2) : null,
      gpuMs: s && Number.isFinite(s.gpuMs) ? +s.gpuMs.toFixed(2) : null,
      draws: s?.drawCalls,
      tris: s?.triangles,
      css: `${innerWidth}×${innerHeight}`,
      deviceDpr: devicePixelRatio,
      dpr: s?.pixelRatio,
      canvas: s?.canvas,
      scale: s?.renderScale,
      rt: s?.renderTarget,
      landing: st.landing,
      pos: [Math.round(g.player.renderPosition.x), Math.round(g.player.renderPosition.z)],
    }
    frames = 0
    worst = 0
    last = now
    fetch('/__telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {})
  }, 2000)
  return () => {
    clearInterval(timer)
    cancelAnimationFrame(raf)
  }
}
