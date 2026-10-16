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
  /** How many steps at once (down only): 1 normally; 2–3 when the frame is FAR over budget (see `sample`). */
  steps?: number
}

export interface AdaptiveInput {
  /** Render scale can still go down/up within the tier. */
  canScaleDown: boolean
  canScaleUp: boolean
  canTierDown: boolean
  canTierUp: boolean
  /** Allow a blind (no GPU timer) probe of tierUp once the render scale is at its max (Hold 60 restoring features). */
  canProbeTierUp?: boolean
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
  /** Consecutive frames over 250 ms. */
  private longRun = 0
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
    if (!this.enabled || frameMs <= 0) return null
    // One frame > 250 ms is a hidden tab / a debugger pause: ignored. SUSTAINED ones are a device that slow (a weak
    // phone on HIGH at 2–4 fps): counted (clamped) so it steps down — before, it was ignored forever and never adapted.
    if (frameMs > 250) {
      if (++this.longRun < 3) return null
      frameMs = 250
    } else this.longRun = 0
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
      // FAR over budget (a phone on HIGH: 40–100 ms frames) → act on one bad window, settle briefly, 2–3 steps at
      // once. Stepping one feature per ~4 s took 50–85 s of stutter to reach 60 on a Snapdragon 6xx model; Hold 60's
      // probed restores bring back what turns out affordable. Mild overruns keep the careful single steps.
      const severe = this.mean > BUDGET_MS * 1.8
      const steps = this.mean > BUDGET_MS * 3.5 ? 3 : severe ? 2 : 1
      if (this.badStreak < (severe ? 1 : 2) || this.cooldownS > 0) return null
      this.badStreak = 0
      if (can.canScaleDown) {
        this.cooldownS = severe ? 0.5 : 1
        return { kind: 'scaleDown', reason: this.state, steps }
      }
      if (can.canTierDown) {
        this.settle(severe ? 1.2 : 3)
        return { kind: 'tierDown', reason: this.state, steps }
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
    // Blind probe (no GPU timer, 60 Hz display): one render-scale step at a time; a tier (feature) step only when
    // the caller allows it — every probe is watched for 3 s and reverted if it costs frames.
    if (!Number.isFinite(gpuMs) && this.goodSeconds >= 10 && this.probeBlockedS <= 0 && (can.canScaleUp || (can.canProbeTierUp && can.canTierUp))) {
      this.goodSeconds = 0
      this.cooldownS = 2
      this.lastProbe = can.canScaleUp ? 'scaleUp' : 'tierUp'
      this.probeWatchS = 3
      if (this.lastProbe === 'tierUp') this.settle(1)
      return { kind: this.lastProbe, reason: 'probe' }
    }
    return null
  }
}
