import * as THREE from 'three'
import type { BiomeField, BiomeWeights } from '../../world/Biomes'
import { SNOW_LINE } from '../../world/Biomes'
import { globalUniforms } from '../shaders/uniforms'

/**
 * BIOME MAP: the region biome weights [desert, snow] (WITHOUT the altitude snow line — shaders add it from the
 * world height, `BIOME_GLSL`) baked into a small RG8 texture centred on the player, so every shader can ask
 * "is this point in the snow / the desert?" with ONE texture fetch: snow on tree shelves and rock tops, frozen
 * lakes, sandstone strata. Rendering only (GPU results never feed gameplay).
 *
 * 64² texels × 32 m = 2048 m square (covers the streamed ring and the horizon detail); biome borders blend over
 * 260 m, so 32 m texels with linear filtering are smooth. Re-centred in 256 m steps; the rebuild is time-sliced
 * (ROWS_PER_FRAME rows into a staging buffer, then one upload) → ~0.1 ms/frame for 8 frames every 256 m of travel.
 * Memory: 8 KB texture + 8 KB staging. `uBiomeActive` = 0 when the window holds no snow or sand: the shaders then
 * skip the fetch (most of the time in the forest — no per-vertex texture read on the trees at all).
 */
const RES = 64
const CELL = 32
const SIZE = RES * CELL
const SNAP = 256
const ROWS_PER_FRAME = 8

export class BiomeMap {
  readonly texture: THREE.DataTexture
  private readonly data = new Uint8Array(RES * RES * 2)
  private readonly staging = new Uint8Array(RES * RES * 2)
  private readonly bw: BiomeWeights = [0, 0]
  private cx = Number.NaN
  private cz = Number.NaN
  /** Rebuild in progress: next row and its target centre. */
  private row = -1
  private nx = 0
  private nz = 0

  constructor(private readonly biomes: BiomeField) {
    this.texture = new THREE.DataTexture(this.data, RES, RES, THREE.RGFormat, THREE.UnsignedByteType)
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    this.texture.name = 'biomeMap'
    globalUniforms.uBiomeMap.value = this.texture
  }

  /** Call every frame with the player position; the first call (or a teleport) bakes synchronously. */
  update(x: number, z: number): void {
    const cx = Math.round(x / SNAP) * SNAP
    const cz = Math.round(z / SNAP) * SNAP
    const far = !(Math.abs(cx - this.cx) <= SIZE * 0.25 && Math.abs(cz - this.cz) <= SIZE * 0.25)
    if (cx !== this.cx || cz !== this.cz) {
      if (this.row < 0 || this.nx !== cx || this.nz !== cz) {
        this.row = 0
        this.nx = cx
        this.nz = cz
      }
    }
    if (this.row < 0) return
    // Teleport / first frame: the old map does not cover the player → bake it all now.
    const rows = far ? RES : ROWS_PER_FRAME
    const x0 = this.nx - SIZE / 2, z0 = this.nz - SIZE / 2
    for (let n = 0; n < rows && this.row < RES; n++, this.row++) {
      const j = this.row
      for (let i = 0; i < RES; i++) {
        const w = this.biomes.weights(x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL, this.bw)
        const o = (j * RES + i) * 2
        this.staging[o] = Math.round(w[0] * 255)
        this.staging[o + 1] = Math.round(w[1] * 255)
      }
    }
    if (this.row < RES) return
    this.data.set(this.staging)
    this.texture.needsUpdate = true
    // Any snow / sand in the window? (Shaders skip their biome lookups when not — uBiomeActive.)
    let any = 0
    for (let i = 0; i < this.staging.length; i++) if (this.staging[i] > 1) { any = 1; break }
    globalUniforms.uBiomeActive.value = any
    this.cx = this.nx
    this.cz = this.nz
    this.row = -1
    globalUniforms.uBiomeRect.value.set(x0, z0, 1 / SIZE, 1 / SIZE)
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/**
 * GLSL: `biomeAt(xz)` → region weights (desert, snow); `snowAt(xz, y)` adds the altitude snow line exactly like
 * `BiomeField.weights(…, h)` (78–112 m, 30 m higher in the desert).
 */
export const BIOME_GLSL = /* glsl */ `
uniform sampler2D uBiomeMap; uniform vec4 uBiomeRect; uniform float uBiomeActive;
// No snow or desert anywhere in the map (most of the forest): skip the fetch entirely (uniform branch).
vec2 biomeAt(vec2 xz) { return uBiomeActive > 0.5 ? texture2D(uBiomeMap, (xz - uBiomeRect.xy) * uBiomeRect.zw).rg : vec2(0.0); }
vec2 biomeWithSnowLine(vec2 xz, float y) {
  vec2 b = biomeAt(xz);
  float alt = smoothstep(${SNOW_LINE[0].toFixed(1)} + b.x * 30.0, ${SNOW_LINE[1].toFixed(1)} + b.x * 30.0, y);
  float snow = max(b.y, alt);
  return vec2(min(b.x, 1.0 - snow), snow);
}`
