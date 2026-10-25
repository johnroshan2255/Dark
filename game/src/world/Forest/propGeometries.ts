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
 * BOULDERS — natural rock shapes instead of one stamped stone ("all the stones look the same"). Each shape is the
 * CONVEX HULL of its own seeded point cloud. The near (`rock`) and far (`rockFar`) meshes MERGE all the shapes, each
 * vertex tagged with its shape (`rockVar`); every instance keeps only its own (`rockPick`; the others collapse to a
 * point in the vertex shader — MaterialLibrary `rockVariants`) → ONE draw per chunk. Physics uses the same point
 * cloud as the convex hull (`ROCK_HULLS[rockPick(k)]`) → the collider IS the visible rock.
 * (2026-10-25, the user: "the rocks are so sharp — we need smooth shapes", on phones at no extra cost: THREE rounded
 * shapes — boulder, slab, low outcrop — instead of six (the brick-like split block, the wedge and the long ridge
 * read as chiselled blocks). Every instance runs all the merged shapes' vertices, so half the shapes buys each one
 * twice the facets for the same work: ~28 points spread evenly over the visible dome (none wasted under the buried
 * base), their radius swelling in smooth low lumps (no per-point spikes) → a round, softly lumpy stone.)
 * Cost: near ≈ 3 × ~60 tris merged (≈ the old 6 × ~32), far ≈ 3 × ~28 (≈ the old 6 × ~16).
 */
export const ROCK_VARIANTS = 3

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
  /** Cloud points over the dome (near; the far mesh takes ~45 %). */
  n: number
  /** Lump depth: the radius swells / dips by up to ± this fraction, smoothly over the stone. */
  j: number
  /** Top slope: y += tilt · x above the base (a leaning / sloped top). */
  tilt: number
}
const ROCK_SHAPES: RockShape[] = [
  { a: [1.15, 0.8, 1.0], n: 28, j: 0.1, tilt: 0 }, // rounded boulder
  { a: [1.3, 0.46, 1.05], n: 28, j: 0.08, tilt: 0.1 }, // flat slab
  { a: [1.2, 0.56, 1.1], n: 28, j: 0.14, tilt: 0.18 }, // low lumpy outcrop
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
  const n = far ? Math.round(S.n * 0.45) : S.n
  // EVENLY spread directions over the dome above the base (a jittered Fibonacci cap, y from the top down to just
  // below the base plane), the radius swelling in smooth lumps (three low sine waves over the direction)
  const ph0 = rnd() * 6.283, p1 = rnd() * 6.283, p2 = rnd() * 6.283, p3 = rnd() * 6.283
  const yLow = -0.25 / S.a[1] - 0.1
  for (let i = 0; i < n; i++) {
    const fy = 1 - ((1 - yLow) * (i + 0.5)) / n, fr = Math.sqrt(Math.max(0, 1 - fy * fy)), fa = ph0 + i * 2.3999632
    const dx = Math.cos(fa) * fr, dy = fy, dz = Math.sin(fa) * fr
    const k = 1 + S.j * (Math.sin(dx * 2.3 + p1) * Math.sin(dz * 2.9 + p2) + 0.5 * Math.sin(dy * 3.1 + p3))
    put(dx * S.a[0] * k, dy * S.a[1] * k, dz * S.a[2] * k)
  }
  // A ring at the base so the rock always sits on a broad footprint (no balanced spinning tops).
  const nb = far ? 5 : 8
  for (let i = 0; i < nb; i++) {
    const t = (i / nb) * Math.PI * 2 + rnd() * 0.3
    put(Math.cos(t) * S.a[0] * (0.86 + 0.08 * rnd()), -0.25, Math.sin(t) * S.a[2] * (0.86 + 0.08 * rnd()))
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
    // SMOOTH shading (2026-10-24, every style): each corner's normal is the area-weighted average of the facets meeting
    // there, bent a little toward the centre — a rounded weathered stone, no flat triangles; the grain, cracks and relief
    // come from the material's rock surface (stylize rockDetail). One tone (no per-facet shade: it drew the triangles).
    const acc = new Map<string, THREE.Vector3>(), key = (q: THREE.Vector3) => `${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)}`
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3()
    for (let i = 0; i < gp.count; i += 3) {
      a.fromBufferAttribute(gp, i); b.fromBufferAttribute(gp, i + 1); c.fromBufferAttribute(gp, i + 2)
      fn.subVectors(c, b).cross(a.clone().sub(b)) // (length = 2 × area: area-weighted)
      if (fn.dot(c.set(gn.getX(i), gn.getY(i), gn.getZ(i))) < 0) fn.negate() // (outward, as the hull's own normal)
      c.fromBufferAttribute(gp, i + 2)
      for (const q of [a, b, c]) {
        const k = key(q)
        acc.set(k, (acc.get(k) ?? new THREE.Vector3()).add(fn))
      }
    }
    for (let i = 0; i < gp.count; i++) {
      p.fromBufferAttribute(gp, i)
      n.copy(acc.get(key(p))!).normalize().multiplyScalar(0.8).add(p.clone().setY(p.y - 0.1).normalize().multiplyScalar(0.2)).normalize()
      tmp.copy(body).lerp(top, THREE.MathUtils.smoothstep(p.y, -0.2, 0.5))
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

export function createPropGeometries(opts: { tieredPines?: boolean; leaves?: LeafColours; autumnPines?: boolean; softBush?: boolean } = {}): PropGeometries {
  const lib = createTreeLibrary({ tiered: opts.tieredPines, leaves: opts.leaves, autumn: opts.autumnPines, aspen: opts.softBush })
  const rock = makeRock(false)
  const rockFar = makeRock(true)
  const { fern, bush } = createUndergrowth(opts.softBush)
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
