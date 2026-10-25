import type * as pc from 'playcanvas'

/**
 * GLOBAL UNIFORMS on PlayCanvas: the game's shared uniform objects ({ name: { value } } — skyUniforms,
 * globalUniforms: the sky, wind, mist, weather, time) set ONCE per frame into the device's uniform scope, so every
 * PlayCanvas shader that declares one of them reads it (the engine resolves uniforms by name from the scope) — no
 * per-material copies. Colours / vectors go in as reused Float32Arrays (no per-frame allocation).
 */
type U = Record<string, { value: unknown }>

const cache = new WeakMap<object, Float32Array>()
function arr(key: object, n: number): Float32Array {
  let a = cache.get(key)
  if (!a || a.length !== n) cache.set(key, (a = new Float32Array(n)))
  return a
}

export function pushUniforms(device: pc.GraphicsDevice, set: U): void {
  const scope = device.scope
  for (const name in set) {
    const v = set[name].value as Record<string, number> | number | boolean | null
    if (v === null || v === undefined) continue
    if (typeof v === 'number') scope.resolve(name).setValue(v)
    else if (typeof v === 'boolean') scope.resolve(name).setValue(v ? 1 : 0)
    else if ('r' in v && 'g' in v) {
      const a = arr(v, 3)
      a[0] = v.r; a[1] = v.g; a[2] = v.b
      scope.resolve(name).setValue(a)
    } else if ('w' in v) {
      const a = arr(v, 4)
      a[0] = v.x; a[1] = v.y; a[2] = v.z; a[3] = v.w
      scope.resolve(name).setValue(a)
    } else if ('z' in v) {
      const a = arr(v, 3)
      a[0] = v.x; a[1] = v.y; a[2] = v.z
      scope.resolve(name).setValue(a)
    } else if ('x' in v && 'y' in v) {
      const a = arr(v, 2)
      a[0] = v.x; a[1] = v.y
      scope.resolve(name).setValue(a)
    }
    // (textures / matrices: set by the systems that own them)
  }
}
