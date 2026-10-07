import * as THREE from 'three'
import { isOverland } from '../../rendering/artStyle'
import { createFenceGeometry, createLampGlowGeometry, createPoleGeometry } from '../Road/propMeshes'
import { createPoiGeometries } from '../POI/poiGeometry'
import { createDesertUndergrowth, createRegionUndergrowth, createTreeLibrary, createUndergrowth, type SpeciesDef } from './treeFactory'

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
 * Boulder: a chiselled low-poly stone (flat facets and top, ROCK_PLANES) with soft painted shading: normals part
 * facet, part bent toward the rock's centre, a warm-grey vertical gradient in the vertex colours;
 * brush strokes, pale tops and ragged moss caps are painted by the STONE surface shader (shaders/paint.ts).
 */
/**
 * The boulder's CHISELLED cut planes (Genshin's stones: a few big flat facets, a flat top, clean edges — not a lumpy
 * blob): unit normal + distance. Every sphere direction is projected onto the nearest plane → a convex polytope.
 */
const ROCK_PLANES: [number, number, number, number][] = [
  [0, 1, 0, 0.6], [0, -1, 0, 0.55],
  [0.9, 0.35, 0.25, 0.8], [-0.7, 0.45, 0.55, 0.78], [-0.55, 0.3, -0.78, 0.84], [0.35, 0.42, -0.85, 0.8],
  [0.12, 0.1, 0.98, 0.9], [-0.98, 0.05, -0.1, 0.86], [0.8, -0.12, -0.55, 0.9], [0.55, 0.05, 0.8, 0.95],
].map(([x, y, z, h]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l, h] })

/** The boulder's deterministic shape (shared by the meshes and the physics hull): the cut polytope along (x, y, z). */
function rockVertex(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const l = Math.hypot(x, y, z) || 1
  const dx = x / l, dy = y / l, dz = z / l
  let r = 1.1
  for (const [nx, ny, nz, h] of ROCK_PLANES) {
    const c = dx * nx + dy * ny + dz * nz
    if (c > 1e-3) r = Math.min(r, h / c)
  }
  return out.set(dx * r * 1.15, Math.max(dy * r * 0.8, -0.25), dz * r)
}

/**
 * Collision hull for a unit rock: EVERY vertex of the near mesh (42, detail 1 — the far 12 are a subset), same
 * jitter + base offset as the meshes. PhysicsWorld builds one convex hull per rock from it, scaled (incl. the
 * instance's vertical jitter) and rotated like the instance, so the collider is exactly the visible boulder.
 * (The old 12-point hull sat up to ~40 % inside the 42-vertex mesh: you walked into thin air around big rocks.)
 */
export const ROCK_HULL: Float32Array = (() => {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const p = g.getAttribute('position')
  const seen = new Set<string>()
  const pts: number[] = []
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    rockVertex(p.getX(i), p.getY(i), p.getZ(i), v)
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    pts.push(v.x, v.y + 0.2, v.z)
  }
  g.dispose()
  return new Float32Array(pts)
})()

function makeRock(detail = 1): THREE.BufferGeometry {
  const g0 = new THREE.IcosahedronGeometry(1, detail)
  const pos0 = g0.getAttribute('position')
  const rv = new THREE.Vector3()
  for (let i = 0; i < pos0.count; i++) {
    rockVertex(pos0.getX(i), pos0.getY(i), pos0.getZ(i), rv)
    pos0.setXYZ(i, rv.x, rv.y, rv.z)
  }
  const g = g0.index ? g0.toNonIndexed() : g0
  g.deleteAttribute('uv')
  g.computeVertexNormals() // per-face (non-indexed)
  const pos = g.getAttribute('position')
  const nor = g.getAttribute('normal')
  const col = new Float32Array(pos.count * 3)
  // OVERLAND: blue-grey, soft (normals bent to the centre like the painted rocks) — their boulders are low-poly
  // but softly shaded, not hard-faceted.
  const over = isOverland()
  const body = srgb(over ? 0x505a72 : 0x857d74), top = srgb(over ? 0x8c98ac : 0xaaa294), tmp = new THREE.Color(), v = new THREE.Vector3(), n = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // Facets read (Genshin's chiselled stones), softened toward the centre so the edges don't sparkle.
    n.fromBufferAttribute(nor, i).multiplyScalar(over ? 0.35 : 0.62).add(v.clone().setY(v.y - 0.1).normalize().multiplyScalar(over ? 0.65 : 0.38)).normalize()
    nor.setXYZ(i, n.x, n.y, n.z)
    tmp.copy(body).lerp(top, THREE.MathUtils.smoothstep(v.y, -0.2, 0.5))
    tmp.toArray(col, i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.translate(0, 0.2, 0)
  if (g !== g0) g0.dispose()
  g.name = detail ? 'rock' : 'rockFar'
  g.computeBoundingSphere()
  return g
}

export function createPropGeometries(): PropGeometries {
  const lib = createTreeLibrary()
  const rock = makeRock()
  const rockFar = makeRock(0)
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
