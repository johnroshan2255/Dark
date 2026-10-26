/**
 * TERRAIN SUN SHADOW (worker): for every texel of the shadow grids, march toward the sun over the height grids and
 * keep the highest angle the ground rises above the sun's ray — a soft visibility (the sun is a disc: the further the
 * blocker, the wider the penumbra). The box at 4 m (its 2 m heights near, the world's beyond) and the world at 16 m.
 * ~1–2 s per sun position on a desktop core; the main thread swaps the textures in when it's done.
 */
interface Grid { h: Float32Array; n: number; step: number; origin: number }
let inner: Grid, far: Grid

function sample(g: Grid, x: number, z: number): number {
  const n = g.n
  let fx = (x - g.origin) / g.step, fz = (z - g.origin) / g.step
  fx = fx < 0 ? 0 : fx > n - 1.0001 ? n - 1.0001 : fx
  fz = fz < 0 ? 0 : fz > n - 1.0001 ? n - 1.0001 : fz
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * n + i, h = g.h
  const a = h[k] + (h[k + 1] - h[k]) * tx
  const b = h[k + n] + (h[k + n + 1] - h[k + n]) * tx
  return a + (b - a) * tz
}

function heightAt(x: number, z: number): number {
  const e = -inner.origin - inner.step
  return x > -e && x < e && z > -e && z < e ? sample(inner, x, z) : sample(far, x, z)
}

/** Visibility of the sun from (x, z) — 0 shadow … 1 lit. */
function visibility(x: number, z: number, dx: number, dz: number, tanE: number, s0: number, reach: number): number {
  const y0 = heightAt(x, z) + 0.6
  let worst = -1
  for (let s = s0; s < reach; s *= 1.075) {
    const h = heightAt(x + dx * s, z + dz * s)
    const a = (h - y0) / s - tanE // how far above the ray the ground stands (as a slope)
    if (a > worst) worst = a
    if (worst > 0.06) break
  }
  // a sun disc ~1.1°, softened a little more for the painterly look
  const t = Math.min(1, Math.max(0, (0.035 - worst) / 0.07))
  return t * t * (3 - 2 * t)
}

function bake(g: { n: number; step: number; origin: number }, dx: number, dz: number, tanE: number, s0: number): Uint8Array {
  const out = new Uint8Array(g.n * g.n)
  for (let j = 0; j < g.n; j++) {
    const z = g.origin + j * g.step
    for (let i = 0; i < g.n; i++) out[j * g.n + i] = Math.round(visibility(g.origin + i * g.step, z, dx, dz, tanE, s0, 9000) * 255)
  }
  return out
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data
  if (m.type === 'init') {
    inner = m.inner
    far = m.far
    return
  }
  // sun: unit vector; march along its horizontal direction
  const [sx, sy, sz] = m.sun as number[]
  const hl = Math.hypot(sx, sz) || 1
  const tanE = Math.max(sy, 0.005) / hl
  const box = { n: m.boxN, step: m.boxStep, origin: inner.origin }
  const world = { n: far.n, step: far.step, origin: far.origin }
  const a = bake(box, sx / hl, sz / hl, tanE, 3)
  const b = bake(world, sx / hl, sz / hl, tanE, 12)
  ;(self as unknown as Worker).postMessage({ id: m.id, box: a, world: b }, [a.buffer, b.buffer])
}
