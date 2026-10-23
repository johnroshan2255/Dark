import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { isOverland } from '../../rendering/artStyle'
import { createFenceGeometry, createLampGlowGeometry, createPoleGeometry } from '../Road/propMeshes'
import { createPoiGeometries } from '../POI/poiGeometry'
import { createDesertUndergrowth, createRegionUndergrowth, createTreeLibrary, createUndergrowth, type LeafColours, type SpeciesDef } from './treeFactory'

/**
 * Placeholder low-poly vegetation/prop geometry built in code, until AI-generated
 * GLB assets pass the asset pipeline (skills/asset-optimization). Shared by every chunk.
 * Colours are linear albedo baked per vertex (tip darkening = cheap fake AO).
 */

const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)


export interface PropGeometries {
  /** Tree species library (7 species × 3 detail levels; cactus + joshua are desert-only). */
  trees: SpeciesDef[]
  rock: THREE.BufferGeometry
  /** Mid-distance rock (LOD1 chunks): same shape family, 20 tris instead of 80. */
  rockFar: THREE.BufferGeometry
  fern: THREE.BufferGeometry
  bush: THREE.BufferGeometry
  /** Desert undergrowth (replaces fern/bush on sand). */
  agave: THREE.BufferGeometry
  shrub: THREE.BufferGeometry
  /** Region undergrowth: autumn leaf piles, mystic glowing mushrooms. */
  leafPile: THREE.BufferGeometry
  glowShroom: THREE.BufferGeometry
  pole: THREE.BufferGeometry
  /** Street-lamp glow + ground pool, instanced with the poles (MaterialLibrary.lampGlow). */
  lampGlow: THREE.BufferGeometry
  fence: THREE.BufferGeometry
  wire: THREE.LineBasicMaterial
  /** Procedural-place geometry by PropType. */
  poi: Map<number, THREE.BufferGeometry>
  dispose(): void
}

/**
 * BOULDERS — SIX natural rock shapes instead of one stamped stone (every boulder used to be the same chiselled
 * polytope, only turned and scaled — "all the stones look the same"). Each shape is the CONVEX HULL of its own
 * seeded point cloud (a rounded boulder, a flat slab, a leaning wedge, a long ridge rock, a split block with
 * chamfered corners, a low lumpy outcrop): irregular flat facets of every size, like a weathered low-poly rock.
 * The near (`rock`) and far (`rockFar`) meshes MERGE all six, each vertex tagged with its shape (`rockVar`); every
 * instance keeps only its own shape (`rockPick`, per instance; the others collapse to a point in the vertex shader —
 * MaterialLibrary `rockVariants`) → still ONE draw per chunk. Physics uses the same point cloud as the convex hull
 * (`ROCK_HULLS[rockPick(k)]`) → the collider IS the visible rock.
 * Cost: near ≈ 6 × 28–36 tris merged (~1.9× the vertices of the old 80-tri stone per instance; the other shapes'
 * triangles are zero-area — never rasterised), far ≈ 6 × 10–16 tris.
 */
export const ROCK_VARIANTS = 6

/** The rock shape of instance k of a chunk's rock records (the renderer and the physics agree on it). */
export function rockPick(k: number): number {
  return Math.min(ROCK_VARIANTS - 1, Math.floor(hash01(k, 29) * ROCK_VARIANTS))
}

/** Deterministic 0..1 hash (instance index, salt) — the same on every client. */
function hash01(k: number, salt: number): number {
  let h = (Math.imul(k | 0, 0x27d4eb2d) ^ Math.imul(salt | 0, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

interface RockShape {
  /** Semi-axes (x, y, z) of the cloud (unit rock ≈ 1 m radius, height ≤ ~0.95 so a rock never towers). */
  a: [number, number, number]
  /** Cloud points (0: the chamfered-box block). */
  n: number
  /** Radial jitter (± fraction). */
  j: number
  /** Top slope: y += tilt · x above the base (a leaning / sloped top). */
  tilt: number
}
const ROCK_SHAPES: RockShape[] = [
  { a: [1.15, 0.78, 1.0], n: 18, j: 0.14, tilt: 0 }, // rounded boulder
  { a: [1.3, 0.42, 1.05], n: 16, j: 0.1, tilt: 0.12 }, // flat slab
  { a: [0.78, 0.82, 0.85], n: 14, j: 0.08, tilt: 0.32 }, // leaning wedge
  { a: [1.55, 0.58, 0.68], n: 16, j: 0.12, tilt: 0.1 }, // long ridge rock
  { a: [0.98, 0.72, 0.92], n: 0, j: 0.1, tilt: 0.06 }, // split block (chamfered box)
  { a: [1.2, 0.52, 1.15], n: 20, j: 0.2, tilt: 0.22 }, // low lumpy outcrop
]

/** The point cloud of shape v (unit rock, base at y = −0.25 — buried; +0.2 lift applied by the callers). `far`: a
 *  sparser cloud (fewer facets) for the LOD1 mesh. Seeded LCG → identical everywhere. */
function rockCloud(v: number, far: boolean): THREE.Vector3[] {
  const S = ROCK_SHAPES[v]
  let st = (0x9e3779b9 ^ Math.imul(v + 1, 0x85ebca6b)) >>> 0
  const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296)
  const pts: THREE.Vector3[] = []
  const put = (x: number, y: number, z: number) => {
    if (y > -0.25) y += S.tilt * x // sloped top
    pts.push(new THREE.Vector3(x, Math.max(-0.25, y), z))
  }
  if (S.n === 0) {
    // Block: the 8 corners of a box, each cut by a chamfer (3 points pulled in along its edges), jittered.
    for (let c = 0; c < 8; c++) {
      const sx = c & 1 ? 1 : -1, sy = c & 2 ? 1 : -1, sz = c & 4 ? 1 : -1
      const k = (1 + (rnd() - 0.5) * 2 * S.j)
      const x = sx * S.a[0] * k, y = sy * S.a[1] * k, z = sz * S.a[2] * k
      if (far) { put(x * 0.92, y * 0.92, z * 0.92); continue }
      const ch = 0.18 + 0.2 * rnd()
      put(x * (1 - ch), y, z); put(x, y * (1 - ch * 1.4), z); put(x, y, z * (1 - ch))
    }
  } else {
    const n = far ? Math.ceil(S.n * 0.5) : S.n
    for (let i = 0; i < n; i++) {
      // A random direction (normal-ish from 3 uniforms), stretched to the ellipsoid, jittered radially.
      let dx = rnd() * 2 - 1, dy = rnd() * 2 - 1, dz = rnd() * 2 - 1
      const l = Math.hypot(dx, dy, dz) || 1
      dx /= l; dy /= l; dz /= l
      const k = 1 + (rnd() - 0.5) * 2 * S.j
      put(dx * S.a[0] * k, dy * S.a[1] * k, dz * S.a[2] * k)
    }
    // A ring at the base so the rock always sits on a broad footprint (no balanced spinning tops).
    for (let i = 0; i < (far ? 4 : 6); i++) {
      const t = (i / (far ? 4 : 6)) * Math.PI * 2 + rnd() * 0.6
      put(Math.cos(t) * S.a[0] * (0.8 + 0.15 * rnd()), -0.25, Math.sin(t) * S.a[2] * (0.8 + 0.15 * rnd()))
    }
  }
  return pts
}

/** Collision hulls per shape (unit rock, +0.2 lift like the meshes): xyz triples. */
export const ROCK_HULLS: Float32Array[] = Array.from({ length: ROCK_VARIANTS }, (_, v) => {
  const pts = rockCloud(v, false)
  const out = new Float32Array(pts.length * 3)
  pts.forEach((p, i) => out.set([p.x, p.y + 0.2, p.z], i * 3))
  return out
})

function makeRock(far: boolean): THREE.BufferGeometry {
  // OVERLAND: blue-grey, soft (normals bent to the centre like the painted rocks) — their boulders are low-poly
  // but softly shaded, not hard-faceted.
  const over = isOverland()
  const body = srgb(over ? 0x505a72 : 0x857d74), top = srgb(over ? 0x8c98ac : 0xaaa294), tmp = new THREE.Color(), p = new THREE.Vector3(), n = new THREE.Vector3()
  const pos: number[] = [], nor: number[] = [], col: number[] = [], vars: number[] = []
  for (let v = 0; v < ROCK_VARIANTS; v++) {
    const g = new ConvexGeometry(rockCloud(v, far))
    const gp = g.getAttribute('position'), gn = g.getAttribute('normal')
    // Per-facet tone (±6 %): each plane of the rock its own shade, like broken stone.
    for (let i = 0; i < gp.count; i++) {
      p.fromBufferAttribute(gp, i)
      // Facets read, softened toward the centre so the edges don't sparkle.
      n.fromBufferAttribute(gn, i).multiplyScalar(over ? 0.35 : 0.62).add(p.clone().setY(p.y - 0.1).normalize().multiplyScalar(over ? 0.65 : 0.38)).normalize()
      const face = Math.floor(i / 3)
      const f = 0.94 + 0.12 * hash01(v * 97 + face, 41)
      tmp.copy(body).lerp(top, THREE.MathUtils.smoothstep(p.y, -0.2, 0.5)).multiplyScalar(f)
      pos.push(p.x, p.y + 0.2, p.z)
      nor.push(n.x, n.y, n.z)
      col.push(tmp.r, tmp.g, tmp.b)
      vars.push(v)
    }
    g.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('rockVar', new THREE.Float32BufferAttribute(vars, 1))
  g.name = far ? 'rockFar' : 'rock'
  g.computeBoundingSphere()
  return g
}

export function createPropGeometries(opts: { tieredPines?: boolean; leaves?: LeafColours } = {}): PropGeometries {
  const lib = createTreeLibrary({ tiered: opts.tieredPines, leaves: opts.leaves })
  const rock = makeRock(false)
  const rockFar = makeRock(true)
  const { fern, bush } = createUndergrowth()
  const { agave, shrub } = createDesertUndergrowth()
  const { leafPile, glowShroom } = createRegionUndergrowth()
  const pole = createPoleGeometry()
  const lampGlow = createLampGlowGeometry()
  const fence = createFenceGeometry()
  const poi = createPoiGeometries()
  const wire = new THREE.LineBasicMaterial({ color: new THREE.Color().setHex(0x141414, THREE.SRGBColorSpace) })
  // Every geometry on the shared vegetation material must carry the billboard attributes (zeros = normal geo).
  for (const g of [fern, bush, pole, fence]) {
    const n = g.getAttribute('position').count
    if (!g.getAttribute('bbCenter')) g.setAttribute('bbCenter', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
    if (!g.getAttribute('bbOff')) g.setAttribute('bbOff', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
  }
  return {
    trees: lib.species,
    rock,
    rockFar,
    fern,
    bush,
    agave,
    shrub,
    leafPile,
    glowShroom,
    pole,
    lampGlow,
    fence,
    wire,
    poi,
    dispose: () => {
      lib.dispose()
      ;[rock, rockFar, fern, bush, agave, shrub, leafPile, glowShroom, pole, lampGlow, fence].forEach((g) => g.dispose())
      wire.dispose()
      poi.forEach((g) => g.dispose())
    },
  }
}
