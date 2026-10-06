import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import humanUrl from './models/characters/human.lod0.glb?url'
import { vehicleDef, type VehicleDef } from '../gameplay/vehicle/catalogue'
import { loadTreeModels } from './treeModels'

/**
 * Loads the GLB models once at startup (parallel with Rapier init) and bakes them into plain geometry for the
 * game's own materials — no GLTF materials, scene graphs or PBR programs survive (skills/asset-optimization).
 *
 *   human   our stylized human (scripts/blender/human.py): one static T-pose mesh with vertex colours, no rig → rigged
 *           and animated procedurally by CharacterModel. Returned in its baked source frame (metres, facing +Z).
 *   vehicles the garage catalogue (gameplay/vehicle/catalogue.ts): pickup (Sketchfab, 00amza), Mercedes G500 4×4²,
 *           Żuk A06 — each baked by `bakeVehicle` (materials → vertex colours, paint mask, wheels split out or
 *           found by name, glass split off) and normalised: metres, facing −Z, origin on the ground at the
 *           wheelbase centre. Loaded on demand and cached (`loadVehicle`).
 * Credits: ASSET_LIST.md § Credits.
 */
export interface TruckModel {
  /** Catalogue id. */
  id: string
  /** Body: position / normal / uv / color (material colour baked) / paintMask (1 = takes the paint colour). */
  body: THREE.BufferGeometry
  glass: THREE.BufferGeometry
  /** Front-left wheel, centred on its hub (right-side wheels use it turned 180°). */
  wheel: THREE.BufferGeometry
  /** Steering wheel (rim + spokes), centred on its hub; turns about `steeringAxis` (unit, pointing forward/down
   *  the column, away from the driver) at `steeringPivot`. null = the model has none we can find. */
  steeringWheel: THREE.BufferGeometry | null
  steeringPivot: [number, number, number]
  steeringAxis: [number, number, number]
  /** Hub centres FL, FR, RL, RR (m, truck space). */
  wheelPos: [number, number, number][]
  wheelRadius: number
  /** Body half extents (m) for the collider, and the body's y range. */
  half: { x: number; y: number; z: number }
  bottom: number
  /** Body z extent (m): the nose (−Z) and the tail (+Z) — the body is not symmetric about the wheelbase. */
  front: number
  rear: number
  /** Body texture, or null for flat-coloured models (colour is in the vertices). */
  map: THREE.Texture | null
  /** Per-pixel paint mask for textured models (R = 1 on the body paint, 0 on rims, glass, trim, lights, rust),
   *  same UVs as `map`; null = the per-vertex `paintMask` alone decides (flat-coloured models). */
  paintMap: THREE.Texture | null
  /** Lamp lenses found on the model (right side; the left mirrors it): centre + half size (m, truck space). */
  lamps: { head: Lamp | null; tail: Lamp | null }
  /** Opening front doors (cut out of the body in Blender: nodes `door_FL*` / `door_FR*` with a `hinge` extra). */
  doors: CarDoor[]
  /** Steering-wheel rim radius (m). */
  steeringRadius: number
  /** UV of a pale, flat texel in `map` (untextured parts of a textured model sample it → their own colour). */
  neutralUv: [number, number]
}

export interface CarDoor {
  /** −1 = left (driver, −x), +1 = right. */
  side: -1 | 1
  /** Door skin + trim, in door space: origin on the hinge line, closed = identity, rear edge toward +z. */
  body: THREE.BufferGeometry
  glass: THREE.BufferGeometry | null
  /** Hinge point (m, truck space). */
  hinge: [number, number, number]
  /** Hinge → rear edge (m) and the door's bottom / top (door space y). */
  length: number
  bottom: number
  top: number
}

export interface Lamp {
  c: [number, number, number]
  w: number
  h: number
}

/** RGBA pixels of a texture image, downscaled to ≤ `max` px (CPU analysis at load). */
function readPixels(tex: THREE.Texture, max = 512): { data: Uint8ClampedArray; w: number; h: number } | null {
  const img = tex.image as (CanvasImageSource & { width: number; height: number }) | undefined
  if (!img || !img.width || typeof document === 'undefined') return null
  const k = Math.min(1, max / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  return { data: ctx.getImageData(0, 0, w, h).data, w, h }
}

function hsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let hh = 0
  if (d > 1e-6) hh = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [hh / 6, mx > 0 ? d / mx : 0, mx]
}

/**
 * PAINT MASK from the texture: a vehicle's body colour is ONE dominant hue across the big panels (olive pickup,
 * blue Żuk) while rims, tyres, glass, chrome, seats, lights and rust are greys, blacks, creams, reds. The most
 * common saturated hue wins; pixels within ~25° of it (and saturated / bright enough) are paint. Soft edges.
 */
function buildPaintMap(tex: THREE.Texture): THREE.Texture | null {
  const px = readPixels(tex)
  if (!px) return null
  const { data, w, h } = px
  const bins = new Float32Array(48)
  for (let i = 0; i < w * h; i++) {
    const [hh, sat, val] = hsv(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255)
    if (sat > 0.22 && val > 0.18) bins[Math.floor(hh * 48) % 48] += sat
  }
  let best = 0
  for (let i = 1; i < 48; i++) if (bins[i] + bins[(i + 47) % 48] * 0.5 + bins[(i + 1) % 48] * 0.5 > bins[best] + bins[(best + 47) % 48] * 0.5 + bins[(best + 1) % 48] * 0.5) best = i
  const h0 = (best + 0.5) / 48
  const out = new Uint8Array(w * h * 4)
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  for (let i = 0; i < w * h; i++) {
    const [hh, sat, val] = hsv(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255)
    let dh = Math.abs(hh - h0)
    dh = Math.min(dh, 1 - dh)
    const m = (1 - ss(0.06, 0.1, dh)) * ss(0.1, 0.2, sat) * ss(0.06, 0.14, val)
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = Math.round(m * 255)
    out[i * 4 + 3] = 255
  }
  const t = new THREE.DataTexture(out, w, h)
  t.flipY = false // canvas rows are top-down; DataTexture row 0 = v 0 — same orientation as a glTF map (flipY false)
  if (tex.flipY) {
    // A flipY map samples row 0 at v = 1: flip our rows to match.
    const row = w * 4, tmp = new Uint8Array(row)
    for (let y = 0; y < h >> 1; y++) {
      tmp.set(out.subarray(y * row, y * row + row))
      out.copyWithin(y * row, (h - 1 - y) * row, (h - y) * row)
      out.set(tmp, (h - 1 - y) * row)
    }
  }
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.generateMipmaps = false
  t.wrapS = tex.wrapS
  t.wrapT = tex.wrapT
  t.needsUpdate = true
  t.name = 'paintMask'
  return t
}

/**
 * LAMPS from the textured body. Headlights: among the faces in the front 18 % that look straight ahead at lamp
 * height, the brightest texel marks a lens — the lens is that face plus its neighbours within 15 cm of similar
 * brightness (a lens is often only light grey in the texture, as bright as the chrome bumper, so a fixed
 * threshold fails; a local cluster doesn't). Tail lights: the reddest rear-facing face and its red neighbours.
 * Both sides are folded onto +x; the area-weighted centre and extent give one lamp per side.
 */
function findLamps(body: THREE.BufferGeometry, tex: THREE.Texture, front: number, rear: number): { head: Lamp | null; tail: Lamp | null } {
  const px = readPixels(tex, 1024)
  const uv = body.getAttribute('uv')
  if (!px || !uv) return { head: null, tail: null }
  const pos = body.getAttribute('position')
  const len = rear - front
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3()
  type Cand = { x: number; y: number; z: number; area: number; score: number; pts: number[] }
  const heads: Cand[] = [], tails: Cand[] = []
  const texel = (u: number, v: number): [number, number, number] => {
    const fu = u - Math.floor(u), fv = v - Math.floor(v)
    const ix = Math.min(px.w - 1, Math.floor(fu * px.w)), iy = Math.min(px.h - 1, Math.floor((tex.flipY ? 1 - fv : fv) * px.h))
    const o = (iy * px.w + ix) * 4
    return [px.data[o] / 255, px.data[o + 1] / 255, px.data[o + 2] / 255]
  }
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2)
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a))
    const area = n.length() / 2
    if (area < 1e-6) continue
    n.normalize()
    const cx = Math.abs((a.x + b.x + c.x) / 3), cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3
    const isFront = cz < front + len * 0.18 && Math.abs(n.z) > 0.85
    const isRear = cz > rear - len * 0.18 && Math.abs(n.z) > 0.6
    if ((!isFront && !isRear) || cy < 0.35 || cy > 1.6) continue
    // Texel at the centroid and 3 points toward the corners: the face's brightest / reddest sample.
    let bright = 0, red = 0
    for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
      const u = uv.getX(t) * w[0] + uv.getX(t + 1) * w[1] + uv.getX(t + 2) * w[2]
      const v = uv.getY(t) * w[0] + uv.getY(t + 1) * w[1] + uv.getY(t + 2) * w[2]
      const [r, g, bl] = texel(u, v)
      const [, sat, val] = hsv(r, g, bl)
      if (sat < 0.25) bright = Math.max(bright, val)
      red = Math.max(red, r - Math.max(g, bl) * 1.4)
    }
    const pts = [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]
    if (isFront && cx > 0.15) heads.push({ x: cx, y: cy, z: cz, area, score: bright, pts })
    if (isRear && cx > 0.15 && red > 0.12) tails.push({ x: cx, y: cy, z: cz, area, score: red, pts })
  }
  const cluster = (list: Cand[], tol: number, sign: number): Lamp | null => {
    if (!list.length) return null
    const best = list.reduce((p, q) => (q.score > p.score ? q : p))
    let W = 0, X = 0, Y = 0, Z = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
    for (const q of list) {
      if (Math.hypot(q.x - best.x, q.y - best.y, q.z - best.z) > 0.15 || q.score < best.score - tol) continue
      W += q.area; X += q.x * q.area; Y += q.y * q.area; Z += q.z * q.area
      for (let k = 0; k < 9; k += 3) {
        x0 = Math.min(x0, Math.abs(q.pts[k])); x1 = Math.max(x1, Math.abs(q.pts[k])); y0 = Math.min(y0, q.pts[k + 1]); y1 = Math.max(y1, q.pts[k + 1])
      }
    }
    if (W < 0.002) return null // < ~20 cm² of lens: nothing reliable
    return { c: [X / W, Y / W, Z / W + sign * 0.02], w: Math.min(0.3, Math.max(0.05, (x1 - x0) / 2)), h: Math.min(0.22, Math.max(0.04, (y1 - y0) / 2)) }
  }
  return { head: cluster(heads, 0.1, -1), tail: cluster(tails, 0.15, 1) }
}

export type VehicleModel = TruckModel

export interface GameModels {
  human: THREE.BufferGeometry
  truck: TruckModel
}

const vehicleCache = new Map<string, Promise<VehicleModel>>()

/** Load (once) and bake a catalogue vehicle. */
export function loadVehicle(id: string, onProgress?: (f: number) => void): Promise<VehicleModel> {
  const def = vehicleDef(id)
  let p = vehicleCache.get(def.id)
  if (!p) {
    let total = def.bytes
    p = new GLTFLoader()
      .loadAsync(def.url, (e) => {
        if (e.lengthComputable) total = e.total
        onProgress?.(Math.min(1, e.loaded / total))
      })
      .then((g) => bakeVehicle(g.scene, def))
    vehicleCache.set(def.id, p)
  } else onProgress?.(1)
  return p
}

/** @param onProgress 0..1 over both downloads (bytes). */
export async function loadModels(onProgress?: (f: number) => void, vehicleId = 'pickup'): Promise<GameModels> {
  const loader = new GLTFLoader()
  const got = [0, 0]
  const report = () => onProgress?.(Math.min(1, (got[0] + got[1]) / 2))
  const [h, t] = await Promise.all([
    loader.loadAsync(humanUrl, (e) => ((got[0] = e.lengthComputable ? e.loaded / e.total : 0.5), report())),
    loadVehicle(vehicleId, (f) => ((got[1] = f), report())),
    loadTreeModels(), // Blender trees: registered before the world builds its tree library (treeModels.ts)
  ])
  return { human: bakeFirstMesh(h.scene), truck: t }
}

/** Every mesh in world space. `name` includes the parent's (a multi-material node is a Group of primitives);
 *  `extras` = the node's glTF extras (e.g. a door's `hinge`). */
function bakedMeshes(scene: THREE.Object3D): { name: string; geo: THREE.BufferGeometry; mat: THREE.Material; extras: Record<string, unknown> }[] {
  scene.updateMatrixWorld(true)
  const out: { name: string; geo: THREE.BufferGeometry; mat: THREE.Material; extras: Record<string, unknown> }[] = []
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld)
    const parent = m.parent && m.parent !== scene ? m.parent : null
    out.push({ name: parent ? `${m.name}|${parent.name}` : m.name, geo: g, mat: m.material as THREE.Material, extras: { ...(parent?.userData ?? {}), ...m.userData } })
  })
  return out
}

/** UV of the palest flat texel (low saturation, bright, uniform neighbourhood) — untextured parts of a textured
 *  model (interior, axles) point all their UVs at it so the shared textured material shows their own colour. */
function neutralTexel(tex: THREE.Texture): [number, number] {
  const px = readPixels(tex, 128)
  if (!px) return [0, 0]
  const { data, w, h } = px
  let best = -1e9, bu = 0, bv = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4
      const [, sat, val] = hsv(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255)
      let dev = 0
      for (const d of [-4, 4, -w * 4, w * 4]) dev += Math.abs(data[o + d] - data[o]) + Math.abs(data[o + d + 1] - data[o + 1]) + Math.abs(data[o + d + 2] - data[o + 2])
      const score = val - sat * 2 - dev / 255
      if (score > best) (best = score), (bu = (x + 0.5) / w), (bv = (y + 0.5) / h)
    }
  }
  return [bu, tex.flipY ? 1 - bv : bv]
}

function bakeFirstMesh(scene: THREE.Object3D): THREE.BufferGeometry {
  const [first] = bakedMeshes(scene)
  first.geo.deleteAttribute('uv')
  return first.geo
}

/** Connected components (vertices welded by position) → per-triangle component id + component bounds. */
function components(g: THREE.BufferGeometry): { triComp: Int32Array; boxes: Map<number, { box: THREE.Box3; tris: number }> } {
  const pos = g.getAttribute('position')
  const idx = g.index
  const tri = idx ? idx.count / 3 : pos.count / 3
  const vi = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k)
  const weld = new Map<string, number>()
  const rep = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`
    let r = weld.get(k)
    if (r === undefined) weld.set(k, (r = i))
    rep[i] = r
  }
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i)
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]]
    return a
  }
  for (let t = 0; t < tri; t++) {
    const a = find(rep[vi(t, 0)]), b = find(rep[vi(t, 1)]), c = find(rep[vi(t, 2)])
    parent[b] = a
    parent[find(c)] = a
  }
  const triComp = new Int32Array(tri)
  const boxes = new Map<number, { box: THREE.Box3; tris: number }>()
  const v = new THREE.Vector3()
  for (let t = 0; t < tri; t++) {
    const c = find(rep[vi(t, 0)])
    triComp[t] = c
    let e = boxes.get(c)
    if (!e) boxes.set(c, (e = { box: new THREE.Box3(), tris: 0 }))
    e.tris++
    for (let k = 0; k < 3; k++) e.box.expandByPoint(v.fromBufferAttribute(pos, vi(t, k)))
  }
  return { triComp, boxes }
}

/** New geometry with only the triangles `keep(t)` (non-indexed, attributes copied). */
function subset(g: THREE.BufferGeometry, keep: (t: number) => boolean): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g
  const tri = src.getAttribute('position').count / 3
  const out = new THREE.BufferGeometry()
  for (const name of Object.keys(src.attributes)) {
    const a = src.getAttribute(name) as THREE.BufferAttribute
    const n = a.itemSize
    const arr: number[] = []
    for (let t = 0; t < tri; t++) {
      if (!keep(t)) continue
      for (let k = 0; k < 3; k++) for (let c = 0; c < n; c++) arr.push(a.array[(t * 3 + k) * n + c])
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, n))
  }
  if (src !== g) src.dispose()
  return out
}

/** Linear material colour + texture (if any) of a baked mesh. */
function matColor(mat: THREE.Material): { color: THREE.Color; map: THREE.Texture | null; glass: boolean } {
  const m = mat as THREE.MeshStandardMaterial
  const color = (m.color ?? new THREE.Color(1, 1, 1)).clone()
  const map = (m.map as THREE.Texture | undefined) ?? null
  const glass = m.transparent || /wind|glas/i.test(mat.name)
  return { color, map, glass }
}

/** Geometry with only position/normal/uv/color/paintMask (so bodies merge), colour baked, uv kept only with a map. */
function paintGeometry(g: THREE.BufferGeometry, color: THREE.Color, keepUv: boolean, paint: number): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone()
  for (const name of Object.keys(out.attributes)) if (!['position', 'normal', 'uv'].includes(name)) out.deleteAttribute(name)
  const n = out.getAttribute('position').count
  if (!out.getAttribute('normal')) out.computeVertexNormals()
  if (!keepUv) out.deleteAttribute('uv')
  if (!out.getAttribute('uv')) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) color.toArray(col, i * 3)
  out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  out.setAttribute('paintMask', new THREE.BufferAttribute(new Float32Array(n).fill(paint), 1))
  return out
}

/**
 * LAMPS from named lamp parts (untextured models: lens glass and glow meshes, e.g. the G500's `glas_light` and
 * `lights_brakes`): front-facing pale parts in the front 20 % → headlights; rear-facing red parts in the rear
 * 20 % → tail lights. Seeded at the biggest qualifying face, clustered within 20 cm, both sides folded onto +x.
 */
function findLampsInParts(parts: { geo: THREE.BufferGeometry; color: THREE.Color }[], front: number, rear: number): { head: Lamp | null; tail: Lamp | null } {
  const len = rear - front
  type Cand = { x: number; y: number; z: number; area: number; pts: number[] }
  const heads: Cand[] = [], tails: Cand[] = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3()
  for (const { geo, color } of parts) {
    const pos = geo.getAttribute('position')
    const [, sat, val] = hsv(color.r, color.g, color.b)
    const red = color.r > 0.25 && color.g < color.r * 0.45 && color.b < color.r * 0.45
    const pale = !red && (sat < 0.35 || val > 0.5)
    for (let t = 0; t + 2 < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2)
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a))
      const area = n.length() / 2
      if (area < 1e-7) continue
      n.normalize()
      const cz = (a.z + b.z + c.z) / 3
      const cand = { x: Math.abs((a.x + b.x + c.x) / 3), y: (a.y + b.y + c.y) / 3, z: cz, area, pts: [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z] }
      if (cand.x < 0.15) continue
      if (pale && cz < front + len * 0.2 && n.z < -0.4) heads.push(cand)
      if (red && cz > rear - len * 0.2 && n.z > 0.4) tails.push(cand)
    }
  }
  const cluster = (list: Cand[], sign: number): Lamp | null => {
    if (!list.length) return null
    const best = list.reduce((p, q) => (q.area > p.area ? q : p))
    let W = 0, X = 0, Y = 0, Z = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
    for (const q of list) {
      if (Math.hypot(q.x - best.x, q.y - best.y, q.z - best.z) > 0.2) continue
      W += q.area; X += q.x * q.area; Y += q.y * q.area; Z += q.z * q.area
      for (let k = 0; k < 9; k += 3) {
        x0 = Math.min(x0, Math.abs(q.pts[k])); x1 = Math.max(x1, Math.abs(q.pts[k])); y0 = Math.min(y0, q.pts[k + 1]); y1 = Math.max(y1, q.pts[k + 1])
      }
    }
    if (W < 1e-4) return null
    return { c: [X / W, Y / W, Z / W + sign * 0.02], w: Math.min(0.3, Math.max(0.05, (x1 - x0) / 2)), h: Math.min(0.22, Math.max(0.04, (y1 - y0) / 2)) }
  }
  return { head: cluster(heads, -1), tail: cluster(tails, 1) }
}

/**
 * Bake ANY catalogue vehicle: every mesh gets its material colour in the vertices (flat-coloured models need no
 * texture at all), paint panels are masked, the glass is split off, the four wheels are found by name
 * (`def.wheelRegex`) or split out of the body by shape (parts touching the ground, round in side view), and the
 * whole thing is normalised: metres (`def.length`), facing −Z, origin on the ground at the wheelbase centre.
 */
function bakeVehicle(scene: THREE.Object3D, def: VehicleDef): VehicleModel {
  const meshes = bakedMeshes(scene)
  const bodies: THREE.BufferGeometry[] = [], glasses: THREE.BufferGeometry[] = []
  const wheelParts: { geo: THREE.BufferGeometry; name: string }[] = []
  // Doors (FL / FR: skin, trim and their window) and the steering wheel, split out by node name (Blender prep).
  const doorParts = new Map<string, { body: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[]; hinge: number[] }>()
  const steerParts: THREE.BufferGeometry[] = []
  // Untextured parts: on a textured model their UVs are pointed at a neutral texel once the map is known.
  const flat: THREE.BufferGeometry[] = []
  let map: THREE.Texture | null = null
  // Lamp lenses / glows by name (untextured models place their lamps from these: findLampsInParts).
  const lampParts: { geo: THREE.BufferGeometry; color: THREE.Color }[] = []
  for (const m of meshes) {
    const { color, map: mm, glass } = matColor(m.mat)
    if (/light|lamp|glow/i.test(m.name) || /light|lamp|glow/i.test(m.mat.name)) lampParts.push({ geo: m.geo.clone(), color })
    const doorKey = /door_(FL|FR)/i.exec(m.name)?.[1].toUpperCase()
    let door = doorKey ? doorParts.get(doorKey) : undefined
    if (doorKey && !door) doorParts.set(doorKey, (door = { body: [], glass: [], hinge: (m.extras.hinge as number[]) ?? [0, 0, 0] }))
    if (glass) {
      const g = paintGeometry(m.geo, new THREE.Color().setHex(0x1b2430, THREE.SRGBColorSpace), false, 0)
      ;(door ? door.glass : glasses).push(g)
      continue
    }
    if (mm && !map) map = mm
    const textured = !!mm
    // Door insides / cabin interior: dark trim, never painted (textured: the texture darkened).
    const inner = /inner|interior/i.test(m.mat.name)
    const paint = inner ? 0 : def.paintRegex ? (def.paintRegex.test(m.mat.name) ? 1 : 0) : 1
    const g = paintGeometry(m.geo, textured ? new THREE.Color(inner ? 0.3 : 1, inner ? 0.3 : 1, inner ? 0.3 : 1) : color, textured, paint)
    if (!textured) flat.push(g)
    if (def.wheelRegex && def.wheelRegex.test(m.name)) wheelParts.push({ geo: g, name: m.name })
    else if (door) door.body.push(g)
    else if (/steering_wheel/i.test(m.name)) steerParts.push(g)
    else bodies.push(g)
  }
  const neutralUv: [number, number] = map ? neutralTexel(map) : [0, 0]
  if (map) {
    for (const g of flat) {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) uv.setXY(i, neutralUv[0], neutralUv[1])
    }
  }
  let body = mergeGeometries(bodies, false)!
  const glass = glasses.length ? mergeGeometries(glasses, false)! : new THREE.BufferGeometry()
  const doorGeo = [...doorParts.entries()].map(([key, d]) => ({
    key, hinge: new THREE.Vector3(...d.hinge),
    body: mergeGeometries(d.body, false)!, glass: d.glass.length ? mergeGeometries(d.glass, false)! : null,
  }))
  // Normalise: forward axis → −Z, metres, wheel bottoms on y = 0, origin at the wheelbase centre.
  const size = new THREE.Vector3()
  const all = mergeGeometries([body, ...wheelParts.map((w) => w.geo), ...doorGeo.map((d) => d.body)], false)!
  const whole = new THREE.Box3().setFromBufferAttribute(all.getAttribute('position') as THREE.BufferAttribute)
  whole.getSize(size)
  const fwdLen = def.forward.endsWith('z') ? size.z : size.x
  const k = def.length / fwdLen
  const rot = def.forward === '+z' ? Math.PI : def.forward === '-z' ? 0 : def.forward === '+x' ? -Math.PI / 2 : Math.PI / 2
  const norm = new THREE.Matrix4().makeRotationY(rot).multiply(new THREE.Matrix4().makeScale(k, k, k))
  // Wheels by name (centres from their bounds) or by shape (connected components of the body).
  let wheels: { c: THREE.Vector3; r: number; geo: THREE.BufferGeometry }[]
  if (wheelParts.length) {
    const byCorner = new Map<string, THREE.BufferGeometry[]>()
    for (const w of wheelParts) {
      const key = (w.name.match(def.wheelRegex!)?.[1] ?? '').toUpperCase()
      byCorner.set(key, [...(byCorner.get(key) ?? []), w.geo])
    }
    wheels = [...byCorner.values()].map((parts) => {
      const geo = mergeGeometries(parts, false)!
      const bb = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute)
      return { c: bb.getCenter(new THREE.Vector3()), r: bb.getSize(new THREE.Vector3()).y / 2, geo }
    })
  } else {
    const { triComp, boxes } = components(body)
    const found = [...boxes.entries()]
      .filter(([, e]) => {
        e.box.getSize(size)
        const along = def.forward.endsWith('z') ? size.z : size.x
        const across = def.forward.endsWith('z') ? size.x : size.z
        return e.box.min.y < whole.min.y + 0.15 * (whole.max.y - whole.min.y) && size.y > 0.12 * (whole.max.y - whole.min.y) && Math.abs(size.y - along) < 0.25 * size.y && across < 0.6 * size.y
      })
      .map(([id, e]) => ({ id, c: e.box.getCenter(new THREE.Vector3()), r: e.box.getSize(new THREE.Vector3()).y / 2 }))
    if (found.length !== 4) throw new Error(`${def.id}: expected 4 wheel parts, found ${found.length}`)
    const isWheel = new Set(found.map((w) => w.id))
    wheels = found.map((w) => ({ c: w.c, r: w.r, geo: subset(body, (t) => triComp[t] === w.id) }))
    body = subset(body, (t) => !isWheel.has(triComp[t]))
  }
  // Steering wheel (pickup): the ring in front of the left seat, found in normalised space.
  let steeringWheel: THREE.BufferGeometry | null = null
  let pivot = new THREE.Vector3(), axis = new THREE.Vector3(0, 0, -1), steeringRadius = 0.19
  if (steerParts.length) {
    // Named in Blender (G500, Żuk): same pivot / axis solve as below.
    steeringWheel = mergeGeometries(steerParts, false)!.applyMatrix4(norm)
  } else if (def.steering) {
    const { triComp, boxes } = components(body)
    const steer = new Set<number>()
    const nb = new THREE.Box3()
    for (const [id, e] of boxes) {
      nb.copy(e.box).applyMatrix4(norm)
      const c = nb.getCenter(new THREE.Vector3()), sz = nb.getSize(new THREE.Vector3())
      if (c.x < -0.15 && c.z > -0.8 && c.z < -0.4 && c.y > 0.8 && c.y < 1.3 && sz.x > 0.3 && sz.x < 0.65 && sz.z < 0.25) steer.add(id)
    }
    if (steer.size) {
      steeringWheel = subset(body, (t) => steer.has(triComp[t])).applyMatrix4(norm)
      body = subset(body, (t) => !steer.has(triComp[t]))
    }
  }
  if (steeringWheel) {
    // Pivot = rim centre; axis = rim normal, pointing down the column (away from the driver).
    const sp = steeringWheel.getAttribute('position')
    let lx = 0, rx = 0, by = 0, ty = 0
    for (let i = 1; i < sp.count; i++) {
      if (sp.getX(i) < sp.getX(lx)) lx = i
      if (sp.getX(i) > sp.getX(rx)) rx = i
      if (sp.getY(i) < sp.getY(by)) by = i
      if (sp.getY(i) > sp.getY(ty)) ty = i
    }
    const P = (i: number) => new THREE.Vector3().fromBufferAttribute(sp, i)
    steeringWheel.computeBoundingBox()
    pivot = steeringWheel.boundingBox!.getCenter(new THREE.Vector3())
    axis = new THREE.Vector3().crossVectors(P(rx).sub(P(lx)), P(ty).sub(P(by))).normalize()
    if (axis.z > 0) axis.negate()
    steeringRadius = (P(rx).x - P(lx).x) / 2
    steeringWheel.translate(-pivot.x, -pivot.y, -pivot.z)
  }
  body.applyMatrix4(norm)
  glass.applyMatrix4(norm)
  for (const l of lampParts) l.geo.applyMatrix4(norm)
  for (const w of wheels) (w.c.applyMatrix4(norm), (w.r *= k), w.geo.applyMatrix4(norm))
  for (const d of doorGeo) (d.body.applyMatrix4(norm), d.glass?.applyMatrix4(norm), d.hinge.applyMatrix4(norm))
  // Ground = wheel bottoms; origin = wheelbase centre.
  const groundY = Math.min(...wheels.map((w) => w.c.y - w.r))
  const cx = wheels.reduce((a, w) => a + w.c.x, 0) / 4, cz = wheels.reduce((a, w) => a + w.c.z, 0) / 4
  const shift = new THREE.Matrix4().makeTranslation(-cx, -groundY, -cz)
  body.applyMatrix4(shift)
  glass.applyMatrix4(shift)
  for (const l of lampParts) l.geo.applyMatrix4(shift)
  for (const w of wheels) (w.c.applyMatrix4(shift), w.geo.applyMatrix4(shift))
  if (steeringWheel) pivot.applyMatrix4(shift)
  // Doors: into door space (hinge at the origin). Closed-door bounds still count for the body box below.
  const outline = new THREE.Box3()
  const doors: CarDoor[] = doorGeo.map((d) => {
    d.body.applyMatrix4(shift)
    d.glass?.applyMatrix4(shift)
    d.hinge.applyMatrix4(shift)
    d.body.computeBoundingBox()
    outline.union(d.body.boundingBox!)
    d.body.translate(-d.hinge.x, -d.hinge.y, -d.hinge.z)
    d.glass?.translate(-d.hinge.x, -d.hinge.y, -d.hinge.z)
    d.body.computeBoundingBox()
    d.body.computeBoundingSphere()
    d.glass?.computeBoundingSphere()
    const b = d.body.boundingBox!
    return { side: d.hinge.x < 0 ? -1 : 1, body: d.body, glass: d.glass, hinge: d.hinge.toArray() as [number, number, number], length: b.max.z, bottom: b.min.y, top: b.max.y }
  })
  doors.sort((a, b) => a.side - b.side) // driver's (left) door first
  const fl = wheels.reduce((a, b) => (b.c.x + b.c.z < a.c.x + a.c.z ? b : a)) // most −x (left) and −z (front)
  const wheel = fl.geo.clone().translate(-fl.c.x, -fl.c.y, -fl.c.z)
  const pick = (sx: number, sz: number) => wheels.reduce((a, b) => (b.c.x * sx + b.c.z * sz > a.c.x * sx + a.c.z * sz ? b : a))
  const wheelPos = [pick(-1, -1), pick(1, -1), pick(-1, 1), pick(1, 1)].map((w) => [w.c.x, w.c.y, w.c.z] as [number, number, number])
  for (const g of [body, wheel, glass, steeringWheel]) if (g) (g.computeBoundingBox(), g.computeBoundingSphere())
  const bb = body.boundingBox!.clone()
  if (doors.length) bb.union(outline)
  if (map) map.colorSpace = THREE.SRGBColorSpace
  const paintMap = map ? buildPaintMap(map) : null
  const lamps = map ? findLamps(body, map, bb.min.z, bb.max.z) : { head: null, tail: null }
  if (lampParts.length) {
    const fromParts = findLampsInParts(lampParts.map((l) => ({ geo: l.geo.index ? l.geo.toNonIndexed() : l.geo, color: l.color })), bb.min.z, bb.max.z)
    lamps.head ??= fromParts.head
    lamps.tail ??= fromParts.tail
  }
  lampParts.forEach((l) => l.geo.dispose())
  meshes.forEach((m) => m.geo.dispose())
  all.dispose()
  return {
    id: def.id,
    body, glass, wheel, wheelPos,
    steeringWheel, steeringPivot: pivot.toArray() as [number, number, number], steeringAxis: axis.toArray() as [number, number, number],
    wheelRadius: fl.r,
    half: { x: (bb.max.x - bb.min.x) / 2, y: (bb.max.y - bb.min.y) / 2, z: (bb.max.z - bb.min.z) / 2 },
    bottom: bb.min.y,
    front: bb.min.z,
    rear: bb.max.z,
    map,
    paintMap,
    lamps,
    doors,
    steeringRadius,
    neutralUv,
  }
}

/** Downscaled copy of a texture (LOW tier: 1024² → 512² saves ~4 MB of GPU memory). */
export function downscaleTexture(tex: THREE.Texture, size: number): THREE.Texture {
  const img = tex.image as (CanvasImageSource & { width: number }) | undefined
  if (!img || !img.width || img.width <= size) return tex
  const c = document.createElement('canvas')
  c.width = c.height = size
  c.getContext('2d')!.drawImage(img, 0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.flipY = tex.flipY
  t.anisotropy = 4
  return t
}
