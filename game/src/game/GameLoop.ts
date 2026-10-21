/**
 * Ordered system scheduler, driven by ONE R3F useFrame (priority -100, before render).
 * Systems are plain objects — no React, no allocation per frame.
 */
export interface System {
  readonly name: string
  update(dt: number, time: number): void
}

export class GameLoop {
  private readonly systems: System[] = []
  /** Last update time per system (ms), for the profiler HUD. */
  readonly timings = new Map<string, number>()
  time = 0

  add(system: System): this {
    this.systems.push(system)
    return this
  }

  tick(rawDt: number): void {
    // Clamp: tab switches produce huge deltas; physics also clamps its accumulator.
    const dt = Math.min(rawDt, 0.1)
    this.time += dt
    for (const s of this.systems) {
      const t0 = performance.now()
      s.update(dt, this.time)
      this.timings.set(s.name, performance.now() - t0)
    }
  }
}
