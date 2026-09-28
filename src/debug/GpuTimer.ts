/**
 * GPU frame time via EXT_disjoint_timer_query_webgl2. Results arrive 1–3 frames late.
 * Availability: Chrome desktop usually yes (may be disabled on some drivers/OS),
 * Firefox behind privacy settings, Safari no. Falls back to NaN. See skills/profiling.
 */
interface TimerExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

export class GpuTimer {
  private readonly ext: TimerExt | null
  private readonly free: WebGLQuery[] = []
  private readonly pending: WebGLQuery[] = []
  private active: WebGLQuery | null = null
  lastMs = Number.NaN

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null
  }

  get supported(): boolean {
    return this.ext !== null
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return
    const q = this.free.pop() ?? this.gl.createQuery()
    if (!q) return
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this.active = q
  }

  end(): void {
    if (!this.ext || !this.active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.pending.push(this.active)
    this.active = null
  }

  /** Collect finished queries (call once per frame). */
  poll(): void {
    if (!this.ext) return
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT)
    while (this.pending.length) {
      const q = this.pending[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      this.pending.shift()
      if (!disjoint) this.lastMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
      this.free.push(q)
    }
  }

  dispose(): void {
    for (const q of [...this.free, ...this.pending]) this.gl.deleteQuery(q)
    this.free.length = this.pending.length = 0
  }
}
