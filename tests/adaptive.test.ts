/** AdaptiveQuality decision logic (run: npm test). Simulates frame streams; no browser needed. */
import { AdaptiveQuality, type AdaptiveDecision } from '../src/rendering/quality/AdaptiveQuality'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

/** Simulated device: frame ms depends on render scale & tier. */
function run(opts: { seconds: number; frameMs: (scale: number, tier: number) => number; gpu?: (scale: number, tier: number) => number }) {
  const a = new AdaptiveQuality()
  let scale = 1, tier = 2, t = 0
  const log: AdaptiveDecision['kind'][] = []
  while (t < opts.seconds * 1000) {
    const ms = opts.frameMs(scale, tier)
    t += ms
    const d = a.sample(ms, opts.gpu ? opts.gpu(scale, tier) : NaN, 4, {
      canScaleDown: scale > 0.5 + 1e-6, canScaleUp: scale < 1 - 1e-6, canTierDown: tier > 0, canTierUp: tier < 2,
    })
    if (!d) continue
    log.push(d.kind)
    if (d.kind === 'scaleDown') scale = Math.round((scale - 0.1) * 10) / 10
    if (d.kind === 'scaleUp') scale = Math.round((scale + 0.1) * 10) / 10
    if (d.kind === 'tierDown') (tier--, (scale = 0.8))
    if (d.kind === 'tierUp') (tier++, (scale = 0.8))
  }
  return { scale, tier, log }
}

// 1. Healthy 60 Hz vsync device: never changes quality (no GPU timer → only rare probes, which revert if bad).
{
  const r = run({ seconds: 60, frameMs: () => 16.67 })
  check('healthy 60 Hz: tier & scale kept', r.tier === 2 && r.scale === 1, r.log.join(',') || 'no changes')
}
// 2. GPU-bound device (cost ∝ pixels): drops scale until it fits, keeps tier.
{
  const r = run({ seconds: 30, frameMs: (s) => Math.max(16.67, 26 * s * s) })
  const fits = Math.max(16.67, 26 * r.scale * r.scale) <= 17.4
  check('GPU-bound: render scale lowered until ≤ 60 fps budget', fits && r.tier === 2, `scale ${r.scale} tier ${r.tier} [${r.log.join(',')}]`)
}
// 3. Heavy device: scale floor not enough → tier drops; ends within budget.
{
  // Part of the cost doesn't scale with resolution (geometry, shadows, CPU) → only a tier drop fixes it.
  const cost = (s: number, tier: number) => Math.max(16.67, (tier === 2 ? 20 : tier === 1 ? 11 : 7) + 8 * s * s)
  const r = run({ seconds: 60, frameMs: cost })
  check('heavy device: tier lowered and frame fits budget', r.tier < 2 && cost(r.scale, r.tier) <= 17.4, `scale ${r.scale} tier ${r.tier} [${r.log.join(',')}]`)
}
// 4. No oscillation: after settling, at most one probe-and-revert per 60 s.
{
  const r = run({ seconds: 120, frameMs: (s) => Math.max(16.67, 20 * s * s) })
  const tail = r.log.slice(4)
  check('no oscillation after settling', tail.length <= 4, `[${r.log.join(',')}]`)
}
// 5. Measured headroom (GPU timer) on a lowered setting → scales back up.
{
  const a = new AdaptiveQuality()
  let up = 0
  for (let i = 0; i < 60 * 20; i++) {
    const d = a.sample(16.67, 5, 4, { canScaleDown: true, canScaleUp: true, canTierDown: true, canTierUp: false })
    if (d?.kind === 'scaleUp') up++
  }
  check('measured headroom → scale up', up >= 2, `${up} scaleUp decisions in 20 s`)
}
// 6. Tab-switch spikes ignored.
{
  const a = new AdaptiveQuality()
  let changes = 0
  for (let i = 0; i < 600; i++) if (a.sample(i % 100 === 99 ? 2000 : 16.67, NaN, 4, { canScaleDown: true, canScaleUp: false, canTierDown: true, canTierUp: false })) changes++
  check('ignores >250 ms hitches (tab switch)', changes === 0)
}
process.exit(failures ? 1 : 0)
