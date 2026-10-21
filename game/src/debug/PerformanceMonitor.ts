import type * as THREE from 'three'
import { GpuTimer } from './GpuTimer'

/**
 * Frame statistics. Written every frame into a plain object; the DOM HUD samples it at 4 Hz.
 * CPU ms = game update + render submission on the main thread (not driver/GPU time).
 */
export interface FrameStats {
  /** Raw interval of the last frame (unsmoothed; feeds AdaptiveQuality). */
  rawFrameMs: number
  /** Worst frame interval over the last HUD sample period. */
  worstFrameMs: number
  fps: number
  frameMs: number
  cpuMs: number
  gpuMs: number
  drawCalls: number
  triangles: number
  lines: number
  geometries: number
  textures: number
  programs: number
  pixelRatio: number
  renderScale: number
  renderTarget: string
  canvas: string
  chunksLoaded: number
  chunksVisible: number
  chunksCulled: number
  chunksPending: number
  physicsChunks: number
  instancesTotal: number
  instancesDrawn: number
  instancesCulled: number
  physicsBodies: number
  physicsColliders: number
  physicsMs: number
  monstersActive: number
  genMs: number
  buildMs: number
  heapMB: number
}

export class PerformanceMonitor {
  readonly stats: FrameStats = {
    rawFrameMs: 0, worstFrameMs: 0, fps: 0, frameMs: 0, cpuMs: 0, gpuMs: Number.NaN, drawCalls: 0, triangles: 0, lines: 0, geometries: 0,
    textures: 0, programs: 0, pixelRatio: 1, renderScale: 1, renderTarget: '', canvas: '', chunksLoaded: 0,
    chunksVisible: 0, chunksCulled: 0, chunksPending: 0, physicsChunks: 0, instancesTotal: 0, instancesDrawn: 0,
    instancesCulled: 0, physicsBodies: 0, physicsColliders: 0, physicsMs: 0, monstersActive: 0, genMs: 0,
    buildMs: 0, heapMB: Number.NaN,
  }
  readonly gpu: GpuTimer
  private frameStart = 0
  private lastFrame = 0

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.gpu = new GpuTimer(renderer.getContext() as WebGL2RenderingContext)
  }

  beginFrame(): void {
    const now = performance.now()
    if (this.lastFrame) {
      const ms = now - this.lastFrame
      const s = this.stats
      s.rawFrameMs = ms
      if (ms > s.worstFrameMs) s.worstFrameMs = ms
      s.frameMs = s.frameMs * 0.9 + ms * 0.1
      s.fps = 1000 / s.frameMs
    }
    this.lastFrame = now
    this.frameStart = now
    this.renderer.info.reset()
    this.gpu.poll()
  }

  endFrame(): void {
    const s = this.stats
    const info = this.renderer.info
    s.cpuMs = s.cpuMs * 0.9 + (performance.now() - this.frameStart) * 0.1
    s.gpuMs = this.gpu.lastMs
    s.drawCalls = info.render.calls
    s.triangles = info.render.triangles
    s.lines = info.render.lines
    s.geometries = info.memory.geometries
    s.textures = info.memory.textures
    s.programs = info.programs?.length ?? 0
    s.pixelRatio = this.renderer.getPixelRatio()
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    s.heapMB = mem ? mem.usedJSHeapSize / 1048576 : Number.NaN
  }

  dispose(): void {
    this.gpu.dispose()
  }
}
