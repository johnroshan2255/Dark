/**
 * Keeps frame time under the 60 fps floor by adjusting render scale first, then tier.
 * Pure logic (no DOM/three) → unit-tested in tests/adaptive.test.ts.
 *
 * - Samples raw frame intervals; evaluates every 0.5 s.
 * - "Bad": mean > 17.4 ms or > 8% of frames over 20 ms. Two bad windows in a row → step down
 *   (render scale −0.1 until the tier minimum, then tier −1).
 * - Stepping up needs evidence of headroom: GPU timer + CPU both < 60% of budget, or a
 *   display faster than 60 Hz running with slack. Without evidence it probes one step after 10 s
 *   stable and reverts (blocking further probes 60 s, doubling each time) if the probe causes bad windows.
 * - Ignores the first seconds after start/tier change (shader compile + streaming burst).
 */
export interface AdaptiveDecision {
  kind: 'scaleDown' | 'scaleUp' | 'tierDown' | 'tierUp'
  reason: string
}

export interface AdaptiveInput {
  /** Render scale can still go down/up within the tier. */
  canScaleDown: boolean
  canScaleUp: boolean
  canTierDown: boolean
  canTierUp: boolean
}

const BUDGET_MS = 1000 / 60
const WINDOW_S = 0.5

export class AdaptiveQuality {
  enabled = true
  private sum = 0
  private count = 0
  private slow = 0
  private elapsed = 0
  private badStreak = 0
  private goodSeconds = 0
  private headroomSeconds = 0
  private graceS = 3
  private cooldownS = 0
  private probeBlockedS = 0
  private probeWatchS = 0
  private lastProbe: AdaptiveDecision['kind'] | null = null
  /** Doubles after every reverted probe (60 s → 120 s → … ≤ 10 min). */
  private probeBackoffS = 60
  /** Last window stats (for HUD). */
  mean = 0
  slowFraction = 0
  state = 'warmup'

  /** After any external quality change (tier switch) give the new settings time to settle. */
  settle(seconds = 3): void {
    this.graceS = seconds
    this.resetWindow()
    this.badStreak = 0
    this.goodSeconds = 0
    this.headroomSeconds = 0
  }

  private resetWindow(): void {
    this.sum = this.count = this.slow = this.elapsed = 0
  }

  /**
   * @param frameMs raw interval since previous frame
   * @param gpuMs GPU time (NaN when unavailable)
   * @param cpuMs main-thread frame work
   */
  sample(frameMs: number, gpuMs: number, cpuMs: number, can: AdaptiveInput): AdaptiveDecision | null {
    if (!this.enabled || frameMs <= 0 || frameMs > 250) return null // tab hidden / debugger pause
    const dt = frameMs / 1000
    if (this.graceS > 0) {
      this.graceS -= dt
      this.state = 'warmup'
      return null
    }
    this.cooldownS = Math.max(0, this.cooldownS - dt)
    this.probeBlockedS = Math.max(0, this.probeBlockedS - dt)
    this.sum += frameMs
    this.count++
    if (frameMs > 20) this.slow++
    this.elapsed += dt
    if (this.elapsed < WINDOW_S) return null

    this.mean = this.sum / this.count
    this.slowFraction = this.slow / this.count
    const windowS = this.elapsed
    this.resetWindow()
    const bad = this.mean > BUDGET_MS + 0.7 || this.slowFraction > 0.08

    if (this.probeWatchS > 0) {
      this.probeWatchS -= windowS
      if (bad && this.lastProbe) {
        // The probe made things worse: undo it and don't probe again for a while.
        const undo: AdaptiveDecision['kind'] = this.lastProbe === 'scaleUp' ? 'scaleDown' : 'tierDown'
        this.lastProbe = null
        this.probeWatchS = 0
        this.probeBlockedS = this.probeBackoffS
        this.probeBackoffS = Math.min(600, this.probeBackoffS * 2)
        this.cooldownS = 1
        this.state = 'probe reverted'
        return { kind: undo, reason: 'probe reverted' }
      }
    }

    if (bad) {
      this.goodSeconds = 0
      this.headroomSeconds = 0
      this.badStreak++
      this.state = `over budget (${this.mean.toFixed(1)} ms)`
      if (this.badStreak < 2 || this.cooldownS > 0) return null
      this.badStreak = 0
      if (can.canScaleDown) {
        this.cooldownS = 1
        return { kind: 'scaleDown', reason: this.state }
      }
      if (can.canTierDown) {
        this.settle(3)
        return { kind: 'tierDown', reason: this.state }
      }
      this.state = 'at minimum quality'
      return null
    }

    this.badStreak = 0
    this.goodSeconds += windowS
    const measuredHeadroom =
      (Number.isFinite(gpuMs) && gpuMs < BUDGET_MS * 0.6 && cpuMs < BUDGET_MS * 0.6) || this.mean < BUDGET_MS * 0.8
    this.headroomSeconds = measuredHeadroom ? this.headroomSeconds + windowS : 0
    this.state = measuredHeadroom ? 'headroom' : 'stable'
    if (this.cooldownS > 0) return null

    if (this.headroomSeconds >= 4) {
      this.headroomSeconds = 0
      this.cooldownS = 2
      if (can.canScaleUp) return { kind: 'scaleUp', reason: 'measured headroom' }
      if (can.canTierUp && this.goodSeconds >= 10) {
        this.settle(3)
        return { kind: 'tierUp', reason: 'measured headroom' }
      }
    }
    // Blind probe (no GPU timer, 60 Hz display): one render-scale step at a time, never a tier.
    if (!Number.isFinite(gpuMs) && this.goodSeconds >= 10 && this.probeBlockedS <= 0 && can.canScaleUp) {
      this.goodSeconds = 0
      this.cooldownS = 2
      this.lastProbe = 'scaleUp'
      this.probeWatchS = 3
      return { kind: 'scaleUp', reason: 'probe' }
    }
    return null
  }
}
