import * as THREE from 'three'
import { CELL_SIZE, CHUNK_SIZE, CHUNK_VERTS } from '../constants'
import { hashFloat } from '../noise/rng'
import { sampleHeight } from '../Terrain/generateTerrain'
import { chunkKey } from '../types'
import type { WorldChunk } from '../WorldChunk'
import { LandmarkKind } from '../Landmarks/landmarks'
import { WorldFields } from '../WorldFields'
import { createGrassGeometry } from './grass'
import { FM_TOP } from '../types'
/** Patch-corner offsets checked on a rock top (GrassField.fillTile). */
const EDGE_PROBE = [[0.9, 0.9], [-0.9, 0.9], [0.9, -0.9], [-0.9, -0.9]] as const
import { isGenshin, isOverland } from '../../rendering/artStyle'
import { farmFieldAt } from '../POI/pois'
import { BIOME_COUNT, type BiomeWeights, type RegionWeights } from '../Biomes'
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
  g: number
  slotTx: Int32Array
  slotTz: Int32Array
  slotOk: Uint8Array
  order: { dx: number; dz: number }[]
  key: string
}

/**
 * Grass around the player in TWO layers (one draw call each):
 *   NEAR  0 … ~45 % of the radius: the full blade density and curved blades.
 *   FAR   ~40 % … 100 %: ~40 % of the blades, single triangles, 1.6× wider (the same coverage at a distance).
 * They crossfade blade by blade over a band (the far layer grows in as the near one thins), so the field looks
 * continuous while the far annulus — ~80 % of the area — costs well under half: −40…50 % grass vertices vs one
 * dense layer at the same radius. The per-patch DENSITY (meadow / forest floor / verge / biome) is bilinearly
 * interpolated between the 8 m tile corners and fed per instance (`iDensity`), and each blade picks its own
 * thresholds in the shader → no squares, no rows, no rings; blades grow in and out with distance (Genshin).
 */
export class GrassField {
  readonly root = new THREE.Group()
  private readonly near: Layer
  private readonly far: Layer
  private readonly corners = new Map<number, number>()
  /** Stats. */
  instances = 0
  fillsLastFrame = 0

  constructor(
    nearMat: THREE.Material,
    farMat: THREE.Material,
    nearU: GrassUniforms,
    farU: GrassUniforms,
    private readonly fields: WorldFields,
    private readonly chunks: Map<string, WorldChunk>,
  ) {
    this.root.name = 'grass-field'
    const layer = (mat: THREE.Material, u: GrassUniforms): Layer => ({ mat, u, mesh: null, geometry: null, density: null, slope: null, g: 0, slotTx: new Int32Array(0), slotTz: new Int32Array(0), slotOk: new Uint8Array(0), order: [], key: '' })
    this.near = layer(nearMat, nearU)
    this.far = layer(farMat, farU)
  }

  configure(s: GrassSettings): void {
    if (s.radius <= 0 || s.density <= 0) {
      // Grass OFF: no meshes, no fills (the painted straw / meadow streaks on the terrain carry the look).
      this.disposeLayer(this.near)
      this.disposeLayer(this.far)
      this.instances = 0
      return
    }
    const R = s.radius
    const nearR = R * 0.45
    // Bands: near shrinks out over [0.36R, 0.5R]; far grows in over the same band and shrinks out at the edge.
    this.near.u.band.value.set(-2, -1, R * 0.36, R * 0.5)
    this.far.u.band.value.set(R * 0.36, R * 0.5, R * 0.74, R)
    const thinStart = R * (isOverland() ? 0.6 : 0.4)
    this.near.u.thin.value.set(thinStart, R)
    this.far.u.thin.value.set(thinStart, R)
    this.setupLayer(this.near, nearR * 1.12, Math.round(s.density), s.blades, s.tall ?? 1, s.wide ?? 1, s.vary ?? 1, s.lean ?? 1)
    this.setupLayer(this.far, R, Math.max(4, Math.round(s.density * 0.32)), 1, s.tall ?? 1, (s.wide ?? 1) * 1.75, s.vary ?? 1, s.lean ?? 1)
    this.instances = (this.near.mesh?.count ?? 0) + (this.far.mesh?.count ?? 0)
  }

  private setupLayer(L: Layer, radius: number, blades: number, segments: number, tall: number, wide: number, vary = 1, lean = 1): void {
    const g = Math.ceil((radius * 2) / TILE) + 1
    const key = `${g}|${blades}|${segments}|${tall}|${wide}|${vary}|${lean}`
    if (key === L.key && L.mesh) return
    this.disposeLayer(L)
    L.key = key
    L.g = g
    L.geometry = createGrassGeometry(blades, segments, tall, wide, vary, lean, isGenshin() ? 4 : 1) // Genshin: loose tufts of 4
    const count = g * g * TILE * TILE // one 1 m² patch per cell
    L.density = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage)
    L.geometry.setAttribute('iDensity', L.density)
    L.slope = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2).setUsage(THREE.DynamicDrawUsage)
    L.geometry.setAttribute('iSlope', L.slope)
    const mesh = new THREE.InstancedMesh(L.geometry, L.mat, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false // surrounds the camera
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.matrixAutoUpdate = false
    mesh.name = L === this.near ? 'grass.near' : 'grass.far'
    ;(mesh.instanceMatrix.array as Float32Array).fill(0) // all degenerate until filled
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

  update(focus: THREE.Vector3): void {
    let fills = 0
    // The near layer first (what you see at your feet), then the far one; ≤ PATCH_FILLS_PER_FRAME patches in all.
    for (const L of [this.near, this.far]) {
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
  }

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
    const floor = isGenshin() ? 0.72 : 0.45
    v = (floor + (1 - floor) * (1 - this.fields.forestDensity(x, z, h))) * bare
    if (this.corners.size > 20000) this.corners.clear()
    this.corners.set(key, v)
    return v
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
    const mesh = L.mesh!
    const mats = mesh.instanceMatrix.array as Float32Array
    const cols = mesh.instanceColor!.array as Float32Array
    const dens = L.density!.array as Float32Array
    const slopes = L.slope!.array as Float32Array
    const n = TILE * TILE
    const base = slot * n
    const x0 = tx * TILE
    const z0 = tz * TILE
    let ok = this.chunks.has(chunkKey(Math.floor((x0 + TILE / 2) / CHUNK_SIZE), Math.floor((z0 + TILE / 2) / CHUNK_SIZE)))
    const centreBw = this.fields.biome(x0 + TILE / 2, z0 + TILE / 2, _bw)
    const dryBiome = centreBw[0] > 0.5
    const bare = Math.max(0, 1 - centreBw[0] * 0.96 - centreBw[1])
    const seed = this.fields.seed
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
      const density = Math.min(1, Math.max(meadow, verge * bare))
      if (!chunk || road < 0.3 || density < 0.03) {
        ZERO.toArray(mats, (base + i) * 16)
        dens[base + i] = 0
        continue
      }
      const d = chunk.data
      const lx = wx - d.cx * CHUNK_SIZE
      const lz = wz - d.cz * CHUNK_SIZE
      const gh = sampleHeight(d.heights, lx, lz)
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
      if (rockK <= 0 || gh < WorldFields.WATER + 0.5 || d.netEdge[ni] < -0.3 || (fp && farmFieldAt(fp, wx, wz))) {
        ZERO.toArray(mats, (base + i) * 16)
        dens[base + i] = 0
        continue
      }
      // Softer near track edges and the waterline: thin out instead of a hard stop.
      const edgeK = Math.min(1, Math.max(0, (road - 0.3) / 1.2)) * Math.min(1, Math.max(0, (d.netEdge[ni] + 0.3) / 1.5))
      dens[base + i] = density * (0.35 + 0.65 * edgeK) * rockK * rockK
      _p.set(wx, (onRock ? rt : gh) - 0.04, wz)
      const ang = r * 97.0
      _q.setFromAxisAngle(_up, ang)
      const sc = isOverland() ? 0.95 + hashFloat(seed, tx, tz, i * 4) * 0.1 : 0.9 + hashFloat(seed, tx, tz, i * 4) * 0.25 + verge * 0.3
      // Terrain gradient here (central differences on the chunk's own heights = the rendered mesh), turned into
      // the patch's rotated frame: local x = (cos, −sin), local z = (sin, cos) of the world axes.
      const ca = Math.cos(ang), sa = Math.sin(ang)
      slopes[(base + i) * 2] = onRock ? 0 : (gx * ca - gz * sa) / sc
      slopes[(base + i) * 2 + 1] = onRock ? 0 : (gx * sa + gz * ca) / sc
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
    mesh.instanceMatrix.addUpdateRange(base * 16, n * 16)
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor!.addUpdateRange(base * 3, n * 3)
    mesh.instanceColor!.needsUpdate = true
    L.density!.addUpdateRange(base, n)
    L.density!.needsUpdate = true
    L.slope!.addUpdateRange(base * 2, n * 2)
    L.slope!.needsUpdate = true
    return ok
  }

  get triangles(): number {
    let t = 0
    for (const L of [this.near, this.far]) if (L.mesh) t += L.mesh.count * (L.geometry!.getAttribute('position').count / 3)
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
    L.key = ''
  }

  dispose(): void {
    this.disposeLayer(this.near)
    this.disposeLayer(this.far)
  }
}
