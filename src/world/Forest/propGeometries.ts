import * as THREE from 'three'
import { isOverland } from '../../rendering/artStyle'
import { hash4 } from '../noise/rng'
import { createFenceGeometry, createLampGlowGeometry, createPoleGeometry } from '../Road/propMeshes'
import { createPoiGeometries } from '../POI/poiGeometry'
import { createTreeLibrary, createUndergrowth, type SpeciesDef } from './treeFactory'

/**
 * Placeholder low-poly vegetation/prop geometry built in code, until AI-generated
 * GLB assets pass the asset pipeline (skills/asset-optimization). Shared by every chunk.
 * Colours are linear albedo baked per vertex (tip darkening = cheap fake AO).
 */

const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)


export interface PropGeometries {
  /** Tree species library (5 species × 3 detail levels). */
  trees: SpeciesDef[]
  rock: THREE.BufferGeometry
  /** Mid-distance rock (LOD1 chunks): same shape family, 20 tris instead of 80. */
  rockFar: THREE.BufferGeometry
  fern: THREE.BufferGeometry
  bush: THREE.BufferGeometry
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
 * Boulder: lumpy low-poly rock with SOFT painted shading (refer/ + forest-house study): normals bent toward
 * the rock's centre so it lights as one rounded volume, a warm-grey vertical gradient in the vertex colours;
 * brush strokes, pale tops and ragged moss caps are painted by the STONE surface shader (shaders/paint.ts).
 */
/** The boulder's deterministic lumpy shape (shared by the meshes and the physics hull). */
function rockVertex(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const k = 0.72 + (hash4(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100)) / 4294967296) * 0.5
  return out.set(x * k * 1.15, Math.max(y * k * 0.62, -0.25), z * k)
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
  const body = srgb(over ? 0x505a72 : 0x7a7a80), top = srgb(over ? 0x8c98ac : 0x9c9a96), tmp = new THREE.Color(), v = new THREE.Vector3(), n = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    n.fromBufferAttribute(nor, i).multiplyScalar(0.35).add(v.clone().setY(v.y - 0.1).normalize().multiplyScalar(0.65)).normalize()
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
    pole,
    lampGlow,
    fence,
    wire,
    poi,
    dispose: () => {
      lib.dispose()
      ;[rock, rockFar, fern, bush, pole, lampGlow, fence].forEach((g) => g.dispose())
      wire.dispose()
      poi.forEach((g) => g.dispose())
    },
  }
}
