import { useEffect, useRef } from 'react'
import type { Game } from '../game/Game'
import { useStore } from '../game/GameState'

const clock = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`
const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a')

/**
 * DOM overlay. Reads PerformanceMonitor stats at 4 Hz and writes textContent directly —
 * zero React renders for per-frame data.
 */
export function DebugHud({ game }: { game: Game }) {
  const pre = useRef<HTMLPreElement>(null)
  const visible = useStore(game.store, (s) => s.hud)
  // Phones get a 3-line HUD; the full one would cover half the screen.
  const compact = useStore(game.store, (s) => s.touch)

  useEffect(() => {
    if (!visible) return
    const id = setInterval(() => {
      const s = game.perf?.stats
      if (!s || !pre.current) return
      const st = game.store.get()
      const t = game.loop.timings
      const p = game.player.renderPosition
      const a = game.adaptive
      const worst = s.worstFrameMs
      s.worstFrameMs = 0
      if (compact) {
        pre.current.textContent = [
          `FPS ${f(s.fps, 0)}  ${f(s.frameMs, 1)} ms (worst ${f(worst, 1)})  gpu ${f(s.gpuMs, 1)}`,
          `${game.quality.name}  scale ${f(s.renderScale, 2)}  dpr ${f(s.pixelRatio, 2)}  auto ${a.enabled ? a.state : 'off'}`,
          `draws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k  chunks ${s.chunksVisible}/${s.chunksLoaded}  seed ${st.seed}`,
        ].join('\n')
        return
      }
      pre.current.textContent = [
        `FPS ${f(s.fps, 0)}  frame ${f(s.frameMs, 2)} ms (worst ${f(worst, 1)})  cpu ${f(s.cpuMs, 2)} ms  gpu ${f(s.gpuMs, 2)} ms`,
        `tier ${game.quality.name}  auto ${a.enabled ? a.state : 'off'}  last: ${game.lastQualityChange}`,
        `device ${game.device?.mobile ? 'mobile' : 'desktop'} ${game.device?.touch ? 'touch' : ''}  ${game.device?.gpu.slice(0, 60) ?? ''}`,
        `draws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(1)}k  lines ${s.lines}`,
        `geom ${s.geometries}  tex ${s.textures}  programs ${s.programs}  heap ${f(s.heapMB, 0)} MB`,
        `dpr ${f(s.pixelRatio, 2)}  scale ${f(s.renderScale, 2)}  rt ${s.renderTarget}  canvas ${s.canvas}`,
        `chunks ${s.chunksLoaded} vis ${s.chunksVisible} culled ${s.chunksCulled} pending ${s.chunksPending}`,
        `instances ${s.instancesDrawn}/${s.instancesTotal} (culled ${s.instancesCulled})`,
        `physics bodies ${s.physicsBodies} colliders ${s.physicsColliders} chunks ${s.physicsChunks} step ${f(s.physicsMs, 2)} ms`,
        `monsters ${s.monstersActive}   gen ${f(s.genMs, 2)} ms/chunk (worker)  build ${f(s.buildMs, 2)} ms`,
        `sys ${[...t].map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ')}`,
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  seed ${st.seed}  time ${clock(game.tod.hours)} ${st.phase}${st.nightmare ? ' NIGHTMARE' : ''}  day ${game.tod.dayLengthMinutes || '∞'} min  cam ${game.cameraCtl.mode}`,
        `aa ${game.post.aa}  sharpen ${f(game.post.material.uniforms.uSharpen.value, 2)}  rays ${game.post.raysSamples}@1/${game.post.raysDivisor}`,
        `flashlight ${st.flashlight ? 'on' : 'off'}  chunks(F4) ${st.debugChunks ? 'on' : 'off'}  freeze(F5) ${st.cullingFrozen ? 'on' : 'off'}  physics(F6) ${st.debugPhysics ? 'on' : 'off'}`,
      ].join('\n')
    }, 250)
    return () => clearInterval(id)
  }, [game, visible, compact])

  if (!visible) return null
  return <pre ref={pre} style={compact ? { ...hudStyle, font: '9px/1.35 ui-monospace, Menlo, monospace', padding: '4px 6px' } : hudStyle} />
}

const hudStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 8,
  left: 8,
  margin: 0,
  padding: '8px 10px',
  font: '11px/1.45 ui-monospace, Menlo, monospace',
  maxWidth: 'calc(100vw - 180px)',
  overflow: 'hidden',
  color: '#cfe3d0',
  background: 'rgba(0,0,0,0.55)',
  pointerEvents: 'none',
  whiteSpace: 'pre',
  zIndex: 10,
}
