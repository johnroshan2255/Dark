import * as THREE from 'three'
import { nearBridge } from '../Road/bridges'
import { CELL_SIZE, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { hashFloat } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { chunkKey } from '../types'
import type { WorldChunk } from '../WorldChunk'
import { LandmarkKind } from '../Landmarks/landmarks'
import { WorldFields } from '../WorldFields'
import { createGrassGeometry, createStrapGrassGeometry } from './grass'
import { FM_TOP } from '../types'
/** Patch-corner offsets checked on a rock top (GrassField.fillTile). */
const EDGE_PROBE = [[0.9, 0.9], [-0.9, 0.9], [0.9, -0.9], [-0.9, -0.9]] as const
import { isBright, isGenshin, isOverland } from '../../rendering/artStyle'
import { farmFieldAt, homeYardAt } from '../POI/pois'
import { Biome, BIOME_COUNT, type BiomeWeights, type RegionWeights } from '../Biomes'
import { blendBy } from '../biomes/BiomeDefs'

/**
 * Dense grass carpet AROUND THE PLAYER — cost ∝ radius², independent of loaded chunks. ONE draw call.
 *
 * A G×G window of 4 m tiles is mapped toroidally onto fixed slots of one InstancedMesh
 * (slot = (tx mod G, tz mod G)). When the player moves, tiles that enter the window are refilled
 * (nearest first, TILE_FILLS_PER_FRAME per frame) with partial buffer uploads; slots still holding a tile
 * that left the window sit outside the fade radius, so the shader has already shrunk them to nothing.
 *
 * Placement is deterministic (hash of world tile + index), heights come from loaded chunk data (exact
 * match with the rendered terrain), colour from the terrain vertex colour underneath + dry/yellow tufts.
 */
/** Tile edge (m) of the layers' toroidal windows (4 m: the square window hugs the circle closely) and of the
 *  meadow-density grid the per-patch density is interpolated from. */
const TILE = 4
const CORNER = 8
/** Patches (1 m²) refilled per frame across both layers. */
const PATCH_FILLS_PER_FRAME = 160
const DRY_KEY = 0x6a55

export interface GrassSettings {
  /** Fade-out radius (m). */
  radius: number
  /** Individual blades per m² (per 1 m patch). */
  density: number
  /** Blade segments: 1 = 1 tri (LOW), 2 = 3 tris curved (MEDIUM/HIGH). */
  blades: number
  /** Blade height / width multipliers (art style; default 1). */
  tall?: number
  wide?: number
  /** Blade height spread (default 1). */
  vary?: number
  /** Random lean multiplier (default 1; Genshin's upright blades 0.35). */
  lean?: number
}

/**
 * The tier's grass budget adjusted for the art style. OVERLAND (over the hill): a pale straw meadow of single
 * blades reaching further out.
 */
export function styledGrass(s: GrassSettings): GrassSettings {
  // GENSHIN (Statue of the Seven / Starfell reference): a LUSH field of thin, UPRIGHT individual blades of a fairly
  // even height (knee-ish), 1.5× the tier's blades per m², 0.72× as wide (same coverage, finer look).
  // Anime grass (Genshin meadow close-up): tall, broad-ish curving blades (×1.2 tall, ×0.95 wide, more lean).
  // Genshin field close-ups (Fontaine / Mondstadt meadows): TALL (knee-to-waist), THIN, long blades packed densely —
  // 1.65× taller and 0.6× as wide as the tier's blade, 2× the blades per m² (thin blades → about the same blade
  // pixels as the old 1.5× wide field, which is what grass costs).
  // (2nd pass: 0.6× thin blades at 2× density turned into 1–2 px hatching — now fewer, WIDER RIBBONS that read one by
  // one, leaning every way: 1.15× density, 1.6× wide, 1.5× tall, lean 1.6.)
  if (isGenshin()) return { ...s, density: Math.round(s.density * 1.4), tall: 1.45, wide: 0.7, vary: 0.6, lean: 1.4 } // thin separate blades in loose tufts of 4 (createGrassGeometry)
  if (!isOverland()) return s
  // INDIVIDUAL blades like theirs (not card clumps): the tier's density, 1.35× taller and 1.4× wider blades so
  // the straw closes into a soft carpet, 1.3× radius. ~1.7× the tier's blade triangles.
  // Their meadow is FUR-dense short blades: 3× the tier's blades per m² as single-triangle blades (a 0.4 m blade
  // has no visible curve) inside 0.85× the radius → ~2.2× the tier's blade count, the painted straw streaks carry
  // the meadow beyond. Thinning starts late and blades widen faster with distance so the field stays SOLID.
  return { radius: s.radius * 0.85, density: Math.round(s.density * 3), blades: 1, tall: 0.95, wide: 0.9 }
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _rb = [0, 0]
const _vp = new THREE.Matrix4()
const _fr = new THREE.Frustum()
const _sph = new THREE.Sphere()
const _dir = new THREE.Vector3()
/** Frustum planes (nx, ny, nz, d) ×6 for the inlined per-patch test. */
const _planes = new Float32Array(24)
/** Extra culling margin (m) so the packed set stays valid until the view moves past the re-pack thresholds. */
const VIEW_SLACK = 1
const _list: number[] = []
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)
const _bw: BiomeWeights = [0, 0]
const _wn: RegionWeights = new Float32Array(BIOME_COUNT)

/** Per-layer uniforms (MaterialLibrary): the grow-in / shrink-out band and the thinning range (m from the player). */
export interface GrassUniforms {
  band: { value: THREE.Vector4 }
  thin: { value: THREE.Vector2 }
}

/** One layer of the field: its own window of tiles, mesh and blade geometry. */
interface Layer {
  mat: THREE.Material
  u: GrassUniforms
  mesh: THREE.InstancedMesh | null
  geometry: THREE.BufferGeometry | null
  density: THREE.InstancedBufferAttribute | null
  /** Per patch: terrain height gradient in the patch's own (rotated) frame, ÷ its height scale. */
  slope: THREE.InstancedBufferAttribute | null
  /** BRIGHT: per patch the grass MASS field (value − threshold, and its gradient in the patch's frame) — massField. */
  mass: THREE.InstancedBufferAttribute | null
  g: number
  slotTx: Int32Array
  slotTz: Int32Array
  slotOk: Uint8Array
  order: { dx: number; dz: number }[]
  key: string
  /** The toroidal tile store (CPU): per patch matrix ×16, colour ×3, density, slope ×2 — the GPU buffers hold only
   *  the tiles in view (`compact`). */
  mats: Float32Array
  cols: Float32Array
  dens: Float32Array
  slopes: Float32Array
  masses: Float32Array
  /** Per slot: patches with blades, centre height and bounding radius (m) of the tile's blades. */
  live: Uint8Array
  tileY: Float32Array
  tileR: Float32Array
  /** Blades are visible from `inner` out to `reach` m from the player (the layer's band incl. its jitter). */
  inner: number
  reach: number
  /** Slots drawn last frame (in draw order) and whether the store changed since. */
  drawn: number[]
  dirty: boolean
}

/**
 * Grass around the player in THREE layers (one draw call each):
 *   NEAR  0 … ~26 % of the radius: the full blade density and curved blades (curved tiers; else to ~45 %).
 *   MID   ~22 … 45 %: the same blades per m² as single triangles — a blade's curve doesn't read past ~8 m, so the
 *         blade COUNT stays and its triangles drop 3× (ULTRA near-field 122 k → ~55 k triangles in view).
 *   FAR   ~40 % … 100 %: ~40 % of the blades, single triangles, 1.6× wider (the same coverage at a distance).
 * They crossfade blade by blade over a band (the far layer grows in as the near one thins), so the field looks
 * continuous while the far annulus — ~80 % of the area — costs well under half: −40…50 % grass vertices vs one
 * dense layer at the same radius. The per-patch DENSITY (meadow / forest floor / verge / biome) is bilinearly
 * interpolated between the 8 m tile corners and fed per instance (`iDensity`), and each blade picks its own
 * thresholds in the shader → no squares, no rows, no rings; blades grow in and out with distance (Genshin).
 */
const sstepG = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export class GrassField {
  readonly root = new THREE.Group()
  private readonly near: Layer
  private readonly mid: Layer
  private readonly far: Layer
  private get layers(): Layer[] {
    return [this.near, this.mid, this.far]
  }
  private readonly corners = new Map<number, number>()
  /** Stats. */
  instances = 0
  fillsLastFrame = 0

  constructor(
    nearMat: THREE.Material,
    midMat: THREE.Material,
    farMat: THREE.Material,
    nearU: GrassUniforms,
    midU: GrassUniforms,
    farU: GrassUniforms,
    private readonly fields: WorldFields,
    private readonly chunks: Map<string, WorldChunk>,
  ) {
    this.root.name = 'grass-field'
    const layer = (mat: THREE.Material, u: GrassUniforms): Layer => ({
      mat, u, mesh: null, geometry: null, density: null, slope: null, mass: null, g: 0, slotTx: new Int32Array(0), slotTz: new Int32Array(0), slotOk: new Uint8Array(0), order: [], key: '',
      mats: new Float32Array(0), cols: new Float32Array(0), dens: new Float32Array(0), slopes: new Float32Array(0), masses: new Float32Array(0), live: new Uint8Array(0), tileY: new Float32Array(0), tileR: new Float32Array(0), inner: 0, reach: 0, drawn: [], dirty: true,
    })
    this.near = layer(nearMat, nearU)
    this.mid = layer(midMat, midU)
    this.far = layer(farMat, farU)
  }

  configure(s: GrassSettings): void {
    if (s.radius <= 0 || s.density <= 0) {
      // Grass OFF: no meshes, no fills (the painted straw / meadow streaks on the terrain carry the look).
      for (const L of this.layers) this.disposeLayer(L)
      this.instances = 0
      return
    }
    const R = s.radius
    // Curved blades (2 segments) only in the NEAR band; the MID layer carries the same density as flat blades out to
    // where the far layer takes over. Flat-blade tiers: one near layer as before, no mid.
    const curved = s.blades > 1
    const nearIn = curved ? 0.22 : 0.36, nearOut = curved ? 0.28 : 0.5
    // Bands: (grow in from, to, shrink out from, to) — each blade at its own distance, ±18 % of the band (shader).
    // The mid layer has GROWN IN before the near one shrinks out (blades shrink in both size axes: crossfading over
    // one band left ~half the coverage at its middle — a visibly thinner ring of meadow 6–8 m out on ULTRA).
    const midIn = nearIn - 0.05, midFull = nearIn + 0.01
    this.near.u.band.value.set(-2, -1, R * nearIn, R * nearOut)
    this.mid.u.band.value.set(R * midIn, R * midFull, R * 0.36, R * 0.5)
    this.far.u.band.value.set(R * 0.36, R * 0.5, R * 0.74, R)
    const thinStart = R * (isOverland() ? 0.6 : 0.4)
    for (const L of this.layers) L.u.thin.value.set(thinStart, R)
    // Reach = band end + its jitter: the tile window and the view culling cover exactly that.
    this.near.inner = 0
    this.near.reach = R * nearOut + 0.18 * R * (nearOut - nearIn)
    this.mid.inner = R * midIn - 0.18 * R * (midFull - midIn)
    this.mid.reach = R * 0.5 + 0.18 * R * 0.14
    this.far.inner = R * 0.36 - 0.18 * R * 0.14
    this.far.reach = R + 0.18 * R * 0.26
    // (BRIGHT strap clumps, 2026-10-25: HIGH / ULTRA's near ring holds 1.2× the blades — the design's full masses;
    //  the gaps between masses draw nothing, so the field averages about the old count. MEDIUM / LOW as before.)
    const nearN = isBright() && s.density >= 30 ? Math.round(s.density * 1.2) : Math.round(s.density)
    this.setupLayer(this.near, this.near.reach, nearN, s.blades, s.tall ?? 1, s.wide ?? 1, s.vary ?? 1, s.lean ?? 1)
    // (a flat triangle covers ¾ of the curved ribbon's area: 1.35× wider keeps the same coverage)
    // (bright: the outer rings' blades wider — 1.7× / 2.8× — so the masses stay full out to the field's edge at the
    //  same vertex count: a few more pixels per blade, no more blades)
    const bw = isBright() ? [1.7, 2.8] : [1.35, 1.75]
    if (curved) this.setupLayer(this.mid, this.mid.reach, Math.round(s.density), 1, s.tall ?? 1, (s.wide ?? 1) * bw[0], s.vary ?? 1, s.lean ?? 1)
    else this.disposeLayer(this.mid)
    this.setupLayer(this.far, this.far.reach, Math.max(4, Math.round(s.density * 0.32)), 1, s.tall ?? 1, (s.wide ?? 1) * bw[1], s.vary ?? 1, s.lean ?? 1)
    this.instances = this.layers.reduce((n, L) => n + (L.mesh ? L.mats.length / 16 : 0), 0)
    for (const L of this.layers) L.dirty = true
  }

  private setupLayer(L: Layer, radius: number, blades: number, segments: number, tall: number, wide: number, vary = 1, lean = 1): void {
    const g = Math.ceil((radius * 2) / TILE) + 1
    const key = `${g}|${blades}|${segments}|${tall}|${wide}|${vary}|${lean}`
    if (key === L.key && L.mesh) return
    this.disposeLayer(L)
    L.key = key
    L.g = g
    L.geometry = isBright()
      ? createStrapGrassGeometry(blades, segments, tall, wide, L !== this.far) // (bright: strap blades in clumps)
      : createGrassGeometry(blades, segments, tall, wide, vary, lean, isGenshin() ? 4 : 1, L !== this.far) // Genshin: loose tufts of 4
    const count = g * g * TILE * TILE // one 1 m² patch per cell
    L.mats = new Float32Array(count * 16)
    L.cols = new Float32Array(count * 3)
    L.dens = new Float32Array(count)
    L.slopes = new Float32Array(count * 2)
    L.masses = new Float32Array(isBright() ? count * 3 : 0)
    L.live = new Uint8Array(g * g)
    L.tileY = new Float32Array(g * g)
    L.tileR = new Float32Array(g * g)
    L.drawn = []
    L.dirty = true
    L.density = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage)
    L.geometry.setAttribute('iDensity', L.density)
    L.slope = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2).setUsage(THREE.DynamicDrawUsage)
    L.geometry.setAttribute('iSlope', L.slope)
    if (isBright()) {
      L.mass = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
      L.geometry.setAttribute('iMass', L.mass)
    }
    const mesh = new THREE.InstancedMesh(L.geometry, L.mat, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false // surrounds the camera
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.matrixAutoUpdate = false
    mesh.name = L === this.near ? 'grass.near' : L === this.mid ? 'grass.mid' : 'grass.far'
    mesh.count = 0 // (compact: only the tiles in view are drawn)
    L.mesh = mesh
    this.root.add(mesh)
    L.slotTx = new Int32Array(g * g).fill(0x7fffffff)
    L.slotTz = new Int32Array(g * g).fill(0x7fffffff)
    L.slotOk = new Uint8Array(g * g)
    // Window offsets sorted nearest-first (fill priority).
    const half = Math.floor(g / 2)
    const order: { dx: number; dz: number; d: number }[] = []
    for (let dz = -half; dz < g - half; dz++) for (let dx = -half; dx < g - half; dx++) order.push({ dx, dz, d: dx * dx + dz * dz })
    order.sort((a, b) => a.d - b.d)
    L.order = order
  }

  update(focus: THREE.Vector3, camera?: THREE.Camera): void {
    let fills = 0
    // The near layer first (what you see at your feet), then mid and far; ≤ PATCH_FILLS_PER_FRAME patches in all.
    for (const L of this.layers) {
      const mesh = L.mesh
      if (!mesh) continue
      const ctx = Math.floor(focus.x / TILE)
      const ctz = Math.floor(focus.z / TILE)
      const g = L.g
      for (const o of L.order) {
        if (fills * TILE * TILE >= PATCH_FILLS_PER_FRAME) break
        const tx = ctx + o.dx
        const tz = ctz + o.dz
        const slot = (((tx % g) + g) % g) + (((tz % g) + g) % g) * g
        if (L.slotTx[slot] === tx && L.slotTz[slot] === tz && L.slotOk[slot]) continue
        L.slotTx[slot] = tx
        L.slotTz[slot] = tz
        L.slotOk[slot] = this.fillTile(L, slot, tx, tz) ? 1 : 0
        fills++
      }
    }
    this.fillsLastFrame = fills
    // Re-pack only when the view moved past the culling margin (VIEW_SLACK): > 0.5 m of camera / player travel or
    // > 1.5° of turn (≤ 0.8 m of sweep at the far edge, 31 m) — or the store / field changed (L.dirty).
    let view = !camera
    if (camera) {
      camera.updateMatrixWorld()
      camera.getWorldDirection(_dir)
      const proj = camera.projectionMatrix.elements
      if (camera.position.distanceToSquared(this.viewPos) > 0.25 || _dir.dot(this.viewDir) < 0.99966 || focus.distanceToSquared(this.viewFocus) > 0.25 || proj[0] !== this.viewProj[0] || proj[5] !== this.viewProj[1]) {
        view = true
        this.viewPos.copy(camera.position)
        this.viewDir.copy(_dir)
        this.viewFocus.copy(focus)
        this.viewProj[0] = proj[0]
        this.viewProj[1] = proj[5]
        _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        _fr.setFromProjectionMatrix(_vp)
        for (let i = 0; i < 6; i++) {
          const pl = _fr.planes[i]
          _planes[i * 4] = pl.normal.x
          _planes[i * 4 + 1] = pl.normal.y
          _planes[i * 4 + 2] = pl.normal.z
          _planes[i * 4 + 3] = pl.constant
        }
      }
    }
    for (const L of this.layers) this.compact(L, focus, camera ? _fr : null, view)
  }
  private readonly viewPos = new THREE.Vector3(1e9, 0, 0)
  private readonly viewDir = new THREE.Vector3()
  private readonly viewFocus = new THREE.Vector3(1e9, 0, 0)
  private readonly viewProj = [0, 0]

  /**
   * VIEW CULLING of the field (the grass costs its SUBMITTED blades: measured on the M4, ULTRA's 330 k blade
   * triangles cost ~1 ms even with every blade clipped in the vertex shader — vertex fetch, not shading). Each frame
   * the tiles that have blades, lie within the layer's reach of the player and touch the view frustum are packed,
   * nearest first (front-to-back: less overdraw on desktop GPUs), into the GPU buffers; the draw covers only those.
   * ~⅓ of the window is in view, so every tier can afford the same field. Re-packed only when the view moved past
   * the culling slack or the store changed (refills): ≤ ~2 k patches × 88 B per pack.
   */
  private compact(L: Layer, focus: THREE.Vector3, fr: THREE.Frustum | null, view: boolean): void {
    const mesh = L.mesh
    if (!mesh || (!view && !L.dirty)) return
    const g = L.g
    const ctx = Math.floor(focus.x / TILE)
    const ctz = Math.floor(focus.z / TILE)
    const list = _list
    list.length = 0
    for (const o of L.order) {
      const tx = ctx + o.dx
      const tz = ctz + o.dz
      const slot = (((tx % g) + g) % g) + (((tz % g) + g) % g) * g
      if (L.slotTx[slot] !== tx || L.slotTz[slot] !== tz || !L.live[slot]) continue
      // Nearest point of the tile to the player beyond the reach → every blade there is shrunk to nothing.
      const ddx = Math.max(tx * TILE - focus.x, 0, focus.x - (tx + 1) * TILE)
      const ddz = Math.max(tz * TILE - focus.z, 0, focus.z - (tz + 1) * TILE)
      if (ddx * ddx + ddz * ddz > (L.reach + 0.5) ** 2) continue
      // Farthest point inside the layer's grow-in distance → the inner layer draws that tile, these blades are nil.
      const fdx = Math.max(Math.abs(focus.x - tx * TILE), Math.abs(focus.x - (tx + 1) * TILE))
      const fdz = Math.max(Math.abs(focus.z - tz * TILE), Math.abs(focus.z - (tz + 1) * TILE))
      if (fdx * fdx + fdz * fdz < Math.max(0, L.inner - 1) ** 2) continue
      if (fr) {
        _sph.center.set((tx + 0.5) * TILE, L.tileY[slot], (tz + 0.5) * TILE)
        _sph.radius = L.tileR[slot] + VIEW_SLACK
        if (!fr.intersectsSphere(_sph)) continue
      }
      list.push(slot)
    }
    // Tiles pass the coarse test above; inside them every PATCH is culled on its own (4 m tiles round an 8–31 m
    // reach send ~2–3× the patches in view) — so the pack is redone whenever the view moved (≤ ~2 k sphere tests).
    const perPatch = fr !== null
    L.dirty = false
    L.drawn = list.slice()
    const n = TILE * TILE
    const mats = mesh.instanceMatrix.array as Float32Array
    const cols = mesh.instanceColor!.array as Float32Array
    const dens = L.density!.array as Float32Array
    const slopes = L.slope!.array as Float32Array
    const masses = L.mass ? (L.mass.array as Float32Array) : null
    let k = 0
    const reach2 = (L.reach + 0.8) ** 2, inner2 = Math.max(0, L.inner - 0.8) ** 2
    for (const slot of list) {
      const b = slot * n
      if (perPatch) {
        // (inlined sphere-vs-frustum test and element copies: no per-patch allocation — this runs for ~2.5 k patches
        // whenever the view moved: 0.62 → 0.10 ms per frame turning, phone emulation CPU ×4)
        const sm = L.mats, sc = L.cols, sd = L.dens, ss = L.slopes, sms = L.masses, P = _planes, r = 1.9 + VIEW_SLACK
        for (let i = b; i < b + n; i++) {
          if (sd[i] <= 0) continue
          const o = i * 16
          const px = sm[o + 12], py = sm[o + 13] + 0.4, pz = sm[o + 14]
          const d2 = (px - focus.x) ** 2 + (pz - focus.z) ** 2
          if (d2 > reach2 || d2 < inner2) continue
          if (P[0] * px + P[1] * py + P[2] * pz + P[3] < -r || P[4] * px + P[5] * py + P[6] * pz + P[7] < -r || P[8] * px + P[9] * py + P[10] * pz + P[11] < -r ||
              P[12] * px + P[13] * py + P[14] * pz + P[15] < -r || P[16] * px + P[17] * py + P[18] * pz + P[19] < -r || P[20] * px + P[21] * py + P[22] * pz + P[23] < -r) continue
          const d = k * 16
          for (let j = 0; j < 16; j++) mats[d + j] = sm[o + j]
          cols[k * 3] = sc[i * 3]
          cols[k * 3 + 1] = sc[i * 3 + 1]
          cols[k * 3 + 2] = sc[i * 3 + 2]
          dens[k] = sd[i]
          slopes[k * 2] = ss[i * 2]
          slopes[k * 2 + 1] = ss[i * 2 + 1]
          if (masses) (masses[k * 3] = sms[i * 3]), (masses[k * 3 + 1] = sms[i * 3 + 1]), (masses[k * 3 + 2] = sms[i * 3 + 2])
          k++
        }
        continue
      }
      mats.set(L.mats.subarray(b * 16, (b + n) * 16), k * 16)
      cols.set(L.cols.subarray(b * 3, (b + n) * 3), k * 3)
      dens.set(L.dens.subarray(b, b + n), k)
      slopes.set(L.slopes.subarray(b * 2, (b + n) * 2), k * 2)
      if (masses) masses.set(L.masses.subarray(b * 3, (b + n) * 3), k * 3)
      k += n
    }
    mesh.count = k
    if (k === 0) return
    mesh.instanceMatrix.clearUpdateRanges()
    mesh.instanceMatrix.addUpdateRange(0, k * 16)
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor!.clearUpdateRanges()
    mesh.instanceColor!.addUpdateRange(0, k * 3)
    mesh.instanceColor!.needsUpdate = true
    L.density!.clearUpdateRanges()
    L.density!.addUpdateRange(0, k)
    L.density!.needsUpdate = true
    if (L.mass) {
      L.mass.clearUpdateRanges()
      L.mass.addUpdateRange(0, k * 3)
      L.mass.needsUpdate = true
    }
    L.slope!.clearUpdateRanges()
    L.slope!.addUpdateRange(0, k * 2)
    L.slope!.needsUpdate = true
  }

  /** A full MEADOW (the PlayCanvas soft look — Over the Hill's dense soft carpets): a high floor under the trees and at
   *  least 0.85 of the meadow on a map that thins its grass. Set before the first update (the corners are cached). */
  meadow = false

  /** Meadow density at a CORNER-grid point (cached): open ground dense, deep forest sparse; none on snow, little on sand. */
  private corner(ix: number, iz: number): number {
    const key = (ix + 32768) * 65536 + (iz + 32768)
    let v = this.corners.get(key)
    if (v !== undefined) return v
    const x = ix * CORNER, z = iz * CORNER
    const h = this.fields.height(x, z)
    // Region grass amount (BiomeDefs.grass, blended): full meadows in the forest and the mystic woods, a little less
    // in the autumn valleys, sparse dry tufts on sand, none on snow.
    const bare = Math.max(0, blendBy(this.fields.region(x, z, _wn, h), (d) => d.grass))
    // Genshin: a full carpet even near trees (its meadows never show bare soil between the blades).
    const floor = isGenshin() || this.meadow ? 0.72 : 0.45
    v = (floor + (1 - floor) * (1 - this.fields.forestDensity(x, z, h))) * bare
    // Fixed maps: no stray tufts on the open desert / beach sand — the desert's grass grows round its pools
    // (FixedMap.poolRing: refs — grass and sedge ring a desert spring's water).
    const map = this.fields.map
    if (map) {
      v *= this.meadow ? Math.max(0.85, map.grass) : map.grass
      const sand = this.fields.biome(x, z, _bw)[0]
      if (sand > 0.01) v = v * (1 - sand) + sand * 0.85 * map.poolRing(x, z)
    }
    // Bright autumn: no grass on the snow patches; remember the autumn weight for the tussock clumping.
    const au = _wn[Biome.Autumn]
    v *= 1 - this.fields.autumnSnow(x, z, au)
    if (this.corners.size > 20000) (this.corners.clear(), this.autumn.clear())
    this.corners.set(key, v)
    this.autumn.set(key, au)
    return v
  }
  private readonly autumn = new Map<number, number>()
  /** Autumn weight (bilinear on the corner grid; corners are filled by `meadowAt` first). */
  private autumnAt(x: number, z: number): number {
    const fx = x / CORNER, fz = z / CORNER
    const ix = Math.floor(fx), iz = Math.floor(fz)
    const u = fx - ix, v = fz - iz
    const k = (i: number, j: number) => this.autumn.get((i + 32768) * 65536 + (j + 32768)) ?? 0
    return k(ix, iz) * (1 - u) * (1 - v) + k(ix + 1, iz) * u * (1 - v) + k(ix, iz + 1) * (1 - u) * v + k(ix + 1, iz + 1) * u * v
  }

  /** Meadow density at any point: bilinear between the corner-grid values (continuous — no tile edges). */
  private meadowAt(x: number, z: number): number {
    const fx = x / CORNER, fz = z / CORNER
    const ix = Math.floor(fx), iz = Math.floor(fz)
    const u = fx - ix, v = fz - iz
    return this.corner(ix, iz) * (1 - u) * (1 - v) + this.corner(ix + 1, iz) * u * (1 - v) + this.corner(ix, iz + 1) * (1 - u) * v + this.corner(ix + 1, iz + 1) * u * v
  }

  /** Highest rock-top surface at world (x, z) from the loaded chunks' fmTop grids (own chunk + neighbours, since a
   *  formation's mesh reaches past its chunk); −1e9 where no rock top. */
  private rockTop(x: number, z: number): number {
    const ci = Math.floor(x / CHUNK_SIZE), cj = Math.floor(z / CHUNK_SIZE)
    let best = -1e9
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const c = this.chunks.get(chunkKey(ci + di, cj + dj))
      const t = c?.data.fmTop
      if (!t || !t.length) continue
      const i = Math.floor((x - (ci + di) * CHUNK_SIZE - FM_TOP.origin) / FM_TOP.cell), j = Math.floor((z - (cj + dj) * CHUNK_SIZE - FM_TOP.origin) / FM_TOP.cell)
      if (i < 0 || j < 0 || i >= FM_TOP.res || j >= FM_TOP.res) continue
      best = Math.max(best, t[j * FM_TOP.res + i])
    }
    return best
  }

  /** Returns false if the terrain under the tile isn't loaded yet (retried next frames). */
  private fillTile(L: Layer, slot: number, tx: number, tz: number): boolean {
    const mats = L.mats
    const cols = L.cols
    const dens = L.dens
    const slopes = L.slopes
    const n = TILE * TILE
    let live = 0, yMin = Infinity, yMax = -Infinity
    const base = slot * n
    const x0 = tx * TILE
    const z0 = tz * TILE
    let ok = this.chunks.has(chunkKey(Math.floor((x0 + TILE / 2) / CHUNK_SIZE), Math.floor((z0 + TILE / 2) / CHUNK_SIZE)))
    const centreBw = this.fields.biome(x0 + TILE / 2, z0 + TILE / 2, _bw)
    const dryBiome = centreBw[0] > 0.5
    const bare = Math.max(0, 1 - centreBw[0] * 0.96 - centreBw[1])
    const seed = this.fields.seed
    const bright = isBright()
    for (let i = 0; i < n; i++) {
      // Jittered 1 m grid (±0.35 m): patches overlap a little and never line up into rows.
      const fx = (i % TILE) + 0.5 + (hashFloat(seed, tx, tz, i * 4 + 1) - 0.5) * 0.7
      const fz = Math.floor(i / TILE) + 0.5 + (hashFloat(seed, tx, tz, i * 4 + 2) - 0.5) * 0.7
      const wx = x0 + fx, wz = z0 + fz
      const r = hashFloat(seed, tx, tz, i * 4 + 3)
      const chunk = this.chunks.get(chunkKey(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)))
      const road = this.fields.roadDistance(wx, wz) - WorldFields.ROAD_HALF_WIDTH
      const verge = road < 9 ? 1 - road / 12 : 0
      if (!chunk) ok = false
      // Density: the corners' meadow factor interpolated across the tile (continuous — no tile edges), the
      // verge pushes it up; the shader shows that fraction of each patch's blades.
      const meadow = this.meadowAt(wx, wz)
      let density = Math.min(1, Math.max(meadow, verge * bare))
      // GOLDEN TUSSOCKS (bright autumn, their straw clumps): the blades gather into ~2 m clumps with soil between —
      // still separate blades, just fewer between the clumps (cheaper, not dearer).
      if (this.fields.palette === 0) {
        const au = this.autumnAt(wx, wz)
        if (au > 0.05) {
          density *= 1 - au * 0.85 * (1 - sstepG(0.42, 0.6, this.fields.colorVariation(wx * 24 + 7, wz * 24 - 3)))
          density *= 1 - Math.min(1, this.fields.autumnSnow(wx, wz, au) * 1.6) // per blade: none on the snow patches
        }
      }
      // BRIGHT MASSES (the strap-clump design): the grass grows in ~3 m masses with ground between — the local density
      // sets how much ground they cover (a sparse map: fewer masses, each still full). A patch wholly in a gap is
      // never drawn (no vertices at all — the masses' gaps are free); the rest carry the field to the shader.
      let mv = 0, mgx = 0, mgz = 0
      if (bright && density >= 0.03) {
        // (≈ 30 % of a full meadow is gaps, like the design — and those patches cost nothing)
        const thr = 0.62 - 0.36 * Math.sqrt(Math.min(1, density))
        const m0 = this.massField(wx, wz)
        mgx = (this.massField(wx + 0.5, wz) - this.massField(wx - 0.5, wz))
        mgz = (this.massField(wx, wz + 0.5) - this.massField(wx, wz - 0.5))
        mv = m0 - thr
        // (the patch's blades reach ~0.9 m from its centre: skip it only if the mass is off over all of that)
        if (mv + 0.95 * Math.hypot(mgx, mgz) < 0.02) density = 0
      }
      if (!chunk || road < 0.3 || density < 0.03 || nearBridge(this.fields, wx, wz, 0.3)) { // (no grass through a bridge deck)
        ZERO.toArray(mats, (base + i) * 16)
        dens[base + i] = 0
        continue
      }
      const d = chunk.data
      const lx = wx - d.cx * CHUNK_SIZE
      const lz = wz - d.cz * CHUNK_SIZE
      let gh = sampleHeight(d.heights, lx, lz)
      // ROAD RIBBON (gutters, ruts — Road/RoadDetail): bare soil in the hollows, blades stand on the ribbon elsewhere.
      const rib = chunk.ribbon
      if (rib && rib.sample(lx, lz, _rb)) {
        if (_rb[1] < -0.01) {
          ZERO.toArray(mats, (base + i) * 16)
          dens[base + i] = 0
          continue
        }
        gh = _rb[0]
      }
      const ni = Math.min(CHUNK_VERTS - 1, Math.round(lz / CELL_SIZE)) * CHUNK_VERTS + Math.min(CHUNK_VERTS - 1, Math.round(lx / CELL_SIZE))
      // GREEN ROCK TOPS: the flat tops of crags and formations (pillar crowns, cave hills, ledges) carry the ground
      // cover in their colour — grow the grass ON them (ChunkData.fmTop), not under them at the terrain height.
      let rt = this.rockTop(wx, wz)
      // Only where the WHOLE patch (±0.9 m incl. blade lean) is on the same top — no blades hanging over the rim.
      if (rt > gh + 0.25) {
        for (const [ex, ez] of EDGE_PROBE) {
          if (Math.abs(this.rockTop(wx + ex, wz + ez) - rt) > 0.6) { rt = -1e9; break }
        }
        if (rt < -1e8) { ZERO.toArray(mats, (base + i) * 16); dens[base + i] = 0; continue }
      }
      const onRock = rt > gh + 0.25
      // No grass inside a cave hill / under a boulder pile / through a pillar (arches stand over the meadow).
      const fm = this.fields.formations.near(wx, wz)
      if (!onRock && fm && fm.kind !== 0 && Math.hypot(wx - fm.x, wz - fm.z) < fm.radius * (fm.kind === 2 ? 0.55 : 0.9)) {
        ZERO.toArray(mats, (base + i) * 16)
        dens[base + i] = 0
        continue
      }
      // No grass through a landmark's stone platform / foundation (the giant trees keep their meadow).
      const lm = this.fields.landmarks.near(wx, wz)
      if (lm && lm.kind !== LandmarkKind.GiantTree && lm.kind !== LandmarkKind.FrostTree && Math.hypot(wx - lm.x, wz - lm.z) < lm.radius * 0.95) {
        ZERO.toArray(mats, (base + i) * 16)
        dens[base + i] = 0
        continue
      }
      // NO GRASS ON ROCK: cliffs, plateau faces, gorge walls and mesas are painted stone from ~39° (terrain shader
      // `cliff` from normal.y 0.78, ground colour → rock) — grass thins from ~29° and is gone by ~37°, so the blades
      // stop where the rock begins instead of carpeting the cliff faces.
      const e = 0.5
      const gx = (sampleHeight(d.heights, Math.min(CHUNK_SIZE, lx + e), lz) - sampleHeight(d.heights, Math.max(0, lx - e), lz)) / (2 * e)
      const gz = (sampleHeight(d.heights, lx, Math.min(CHUNK_SIZE, lz + e)) - sampleHeight(d.heights, lx, Math.max(0, lz - e))) / (2 * e)
      const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz)
      // (Matched to the terrain shader's cliff paint, normal.y 0.6–0.67 ≈ 48–53°: every slope still painted green
      // keeps its grass — it used to stop at ~37° and left the green banks bare. Rock tops: always flat enough.)
      const rockK = onRock ? 1 : Math.min(1, Math.max(0, (ny - 0.64) / 0.08))
      const fp = this.fields.pois.near(wx, wz)
      if (rockK <= 0 || gh < WorldFields.WATER + 0.5 || d.netEdge[ni] < -0.3 || (fp && (farmFieldAt(fp, wx, wz) || homeYardAt(fp, wx, wz)))) {
        ZERO.toArray(mats, (base + i) * 16)
        dens[base + i] = 0
        continue
      }
      // Softer near track edges and the waterline: thin out instead of a hard stop.
      const edgeK = Math.min(1, Math.max(0, (road - 0.3) / 1.2)) * Math.min(1, Math.max(0, (d.netEdge[ni] + 0.3) / 1.5))
      dens[base + i] = density * (0.35 + 0.65 * edgeK) * rockK * rockK
      _p.set(wx, (onRock ? rt : gh) - 0.04, wz)
      live++
      yMin = Math.min(yMin, _p.y)
      yMax = Math.max(yMax, _p.y)
      const ang = r * 97.0
      _q.setFromAxisAngle(_up, ang)
      const sc = isOverland() ? 0.95 + hashFloat(seed, tx, tz, i * 4) * 0.1 : 0.9 + hashFloat(seed, tx, tz, i * 4) * 0.25 + verge * 0.3
      // Terrain gradient here (central differences on the chunk's own heights = the rendered mesh), turned into
      // the patch's rotated frame: local x = (cos, −sin), local z = (sin, cos) of the world axes.
      const ca = Math.cos(ang), sa = Math.sin(ang)
      slopes[(base + i) * 2] = onRock ? 0 : (gx * ca - gz * sa) / sc
      slopes[(base + i) * 2 + 1] = onRock ? 0 : (gx * sa + gz * ca) / sc
      if (bright) {
        // (the mass field in the patch's own rotated frame, like the slope; the shader adds root · gradient)
        const mo = (base + i) * 3
        L.masses[mo] = mv
        L.masses[mo + 1] = mgx * ca - mgz * sa
        L.masses[mo + 2] = mgx * sa + mgz * ca
      }
      _s.set(1, sc, 1) // XZ stays 1 so patches keep tiling
      _m.compose(_p, _q, _s).toArray(mats, (base + i) * 16)
      const o = (base + i) * 3
      // Base colour = the ground's own colour (blades melt into the terrain → a carpet, not tufts); only a
      // few dry clumps on sunny verges (refs), and a slight per-clump hue jitter.
      // Overland: one even golden field — no dry clumps, no per-patch jitter (they read as tufts in a short field).
      // Genshin: no dry tufts in the carpet and a near-even tone (±3 %).
      const dry = dryBiome || (!isOverland() && !isGenshin() && hashFloat(seed, tx, tz, i * 4 + DRY_KEY) < 0.03 + verge * 0.06)
      const j = isOverland() ? 1 : isGenshin() ? 0.97 + hashFloat(seed, tx, tz, i * 4 + DRY_KEY + 1) * 0.06 : 0.92 + hashFloat(seed, tx, tz, i * 4 + DRY_KEY + 1) * 0.16
      const tr = d.colors[ni * 3], tg = d.colors[ni * 3 + 1], tb = d.colors[ni * 3 + 2]
      if (dry) {
        cols[o] = tr * 1.3; cols[o + 1] = tg * 1.15; cols[o + 2] = tb * 0.7
      } else {
        // (Genshin: exactly the ground's hue — the grass shader does the tip / root shading.)
        if (isGenshin()) { cols[o] = tr * j; cols[o + 1] = tg * j; cols[o + 2] = tb * j }
        else { cols[o] = tr * 0.95 * j; cols[o + 1] = tg * 1.05 * j; cols[o + 2] = tb * 0.95 * j }
      }
    }
    // Bounding sphere of the tile's blades for the view test: half-diagonal + patch jitter + blade height, lean and
    // distance widening (the grass shader's 1.8 m patch margin) + the height spread across the tile.
    L.live[slot] = live
    L.tileY[slot] = live ? (yMin + yMax) * 0.5 + 0.4 : 0
    L.tileR[slot] = live ? TILE * 0.7072 + 0.35 + 1.8 + (yMax - yMin) * 0.5 : 0
    L.dirty = true
    return ok
  }

  /** The bright grass MASS field at (x, z): two octaves of hashed value noise (~3 m and ~1.1 m), 0..1 — on the CPU
   *  (deterministic, the same on every device; GPU sin-hashes differ between phones). The shader gets it per patch. */
  private massField(x: number, z: number): number {
    return this.valueNoise(x * 0.33 + 7.1, z * 0.33 + 7.1, 811) * 0.7 + this.valueNoise(x * 0.9 + 3.3, z * 0.9 + 3.3, 812) * 0.3
  }

  private valueNoise(x: number, z: number, salt: number): number {
    const ix = Math.floor(x), iz = Math.floor(z)
    let fx = x - ix, fz = z - iz
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz)
    const s = this.fields.seed
    const a = hashFloat(s, ix, iz, salt), b = hashFloat(s, ix + 1, iz, salt), c = hashFloat(s, ix, iz + 1, salt), d = hashFloat(s, ix + 1, iz + 1, salt)
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
  }

  get triangles(): number {
    let t = 0
    for (const L of this.layers) if (L.mesh) t += L.mesh.count * (L.geometry!.getAttribute('position').count / 3)
    return t
  }

  private disposeLayer(L: Layer): void {
    if (L.mesh) {
      this.root.remove(L.mesh)
      L.mesh.dispose()
      L.mesh = null
    }
    L.geometry?.dispose()
    L.geometry = null
    L.density = null
    L.slope = null
    L.mass = null
    L.key = ''
  }

  dispose(): void {
    for (const L of this.layers) this.disposeLayer(L)
  }
}
