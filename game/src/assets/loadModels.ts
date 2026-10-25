import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import heroUrl from './models/characters/hero.lod0.glb?url'
import heroTowUrl from './models/characters/hero_tow_clips.glb?url'
import hullUrl from './models/vehicles/boat_hull.lod0.glb?url'
import { DEFAULT_VEHICLE, vehicleDef, type VehicleDef } from '../gameplay/vehicle/catalogue'
import { bodyHulls, triangles } from '../gameplay/vehicle/hulls'
import { loadTreeModels } from './treeModels'

/**
 * Loads the GLB models once at startup (parallel with Rapier init) and bakes them into plain geometry for the
 * game's own materials — no GLTF materials, scene graphs or PBR programs survive (skills/asset-optimization).
 *
 *   hero    the player (scripts/blender/hero/): one skinned mesh (15 k tris, 65-bone Mixamo skeleton incl. fingers),
 *           its 1024² albedo and 13 Mixamo clips — kept as a scene graph (CharacterModel animates it).
 *   vehicles the garage catalogue (gameplay/vehicle/catalogue.ts): Mercedes G500 4×4², BMW E30, the kei van — each
 *           baked by `bakeVehicle` (materials → vertex colours, paint mask, wheels split out or
 *           found by name, glass split off) and normalised: metres, facing −Z, origin on the ground at the
 *           wheelbase centre. Loaded on demand and cached (`loadVehicle`).
 *   hull    the amphibious boat hull every car deploys (scripts/blender/boat_hull.py; gameplay/vehicle/BoatHull.ts):
 *           6 parts in normalised hull space with their hinge pivots, vertex colours only (~41 KB, loaded once).
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
  /** Underside height (m) of the body ahead of the front / behind the rear tyres: the bumper colliders start there. */
  overhang: { front: number; rear: number }
  /** Half the tyre width (m), from the wheel mesh: the tyre envelope samples its tread edges too. */
  tyreHalfWidth: number
  /** Body + glass + closed doors as one triangle soup (xyz… per corner): the car's exact collider. */
  readonly mesh: Float32Array
  /** Convex pieces cut from `mesh` (gameplay/vehicle/hulls): the body against terrain and formations. */
  readonly hulls: Float32Array[]
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
  /** That texel's colour (linear; white for flat-coloured models) — parts with a set colour divide it out. */
  neutralColor: [number, number, number]
  /** The amphibious hull (shared by every car; fitted to this one by BoatHull). */
  hull: HullAsset
  /** Brake hardware per axle (Blender `caliper_FL` / `caliper_RL`: disc + hat + caliper, or drum + backing plate),
   *  in hub space of the LEFT wheel — the right side is it turned 180° (calipers at 12 o'clock: symmetric). null =
   *  the model has none. Vertex-coloured; drawn hub + steer + suspension, never spinning (Car). */
  brakes: { front: THREE.BufferGeometry | null; rear: THREE.BufferGeometry | null }
  /** Rim radius / tyre radius of the wheel (glTF extra `rim` on `wheel_*`; scripts/blender/vehicle_realism.py) —
   *  where the rubber starts for the tyre-deformation shader (`tyreW` attribute on the wheel, 0 everywhere else). */
  rim: number
  /** The COCKPIT (scripts/blender/vehicle_cabin.py): the static cabin (`cab_*`: dash panels, seats, console, column…)
   *  drawn with the body but not part of its collider; the gauge faces (`dial_*`, UV-mapped onto the canvas the car
   *  draws its instruments on); and the moving parts — pedals, gear lever, wipers — in pivot space. */
  cabin: THREE.BufferGeometry | null
  dials: THREE.BufferGeometry | null
  controls: CockpitPart[]
  /** TOW HOOKS (scripts/blender/vehicle_hooks.py: `hook_F` / `hook_R`, their fairlead plates in the body), front and
   *  rear; null = the model has none. */
  hooks: { front: TowHook | null; rear: TowHook | null }
}

/** A detachable tow hook: geometry with its EYE (where the rope ties on) at the origin, where it hangs stowed (m, truck
 *  space), and the FAIRLEAD the rope leaves the car through (m, truck space). Vertex-coloured, on the car program. */
export interface TowHook {
  geo: THREE.BufferGeometry
  eye: [number, number, number]
  fairlead: [number, number, number]
}

/** A moving cockpit part (Blender `pedal_gas|brake|clutch`, `gear_lever`, `wiper_L|R` with `pivot` + `axis` extras):
 *  geometry with its pivot at the origin; it turns about `axis` (unit, truck space) at `pivot` (m, truck space). */
export interface CockpitPart {
  kind: string
  geo: THREE.BufferGeometry
  pivot: [number, number, number]
  axis: [number, number, number]
}

/** Boat hull parts in normalised hull space (scripts/blender/boat_hull.py): geometry + hinge pivot (glTF space). */
export interface HullAsset {
  parts: Map<string, { geo: THREE.BufferGeometry; pivot: [number, number, number] }>
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
 * PAINT MASK from the texture: a vehicle's body colour is ONE dominant hue across the big panels (the G500's
 * green) while rims, tyres, glass, chrome, seats, lights and rust are greys, blacks, creams, reds. The most
 * common saturated hue wins; pixels within ~25° of it (and saturated / bright enough) are paint. Soft edges.
 */
function buildPaintMap(tex: THREE.Texture, white = false): THREE.Texture | null {
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
    // (a WHITE car, catalogue `whitePaint`: the bright, neutral texels are the paint — trim, glass, lamps and tyres
    //  are dark or coloured)
    const m = white ? ss(0.62, 0.78, val) * (1 - ss(0.1, 0.2, sat)) : (1 - ss(0.06, 0.1, dh)) * ss(0.1, 0.2, sat) * ss(0.06, 0.14, val)
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
/** Lowest body point (m) ahead of the front tyres and behind the rear ones, within the frame's width (the same
 *  1.05 r gap the frame boxes leave around the wheels — the arches dip lower there). Missing = the frame height. */
function overhangs(body: THREE.BufferGeometry, wheelPos: [number, number, number][], r: number, halfX: number): { front: number; rear: number } {
  const p = body.getAttribute('position')
  const zf = Math.min(wheelPos[0][2], wheelPos[1][2]) - 1.05 * r, zr = Math.max(wheelPos[2][2], wheelPos[3][2]) + 1.05 * r
  let front = Infinity, rear = Infinity
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getX(i)) > halfX * 0.9) continue
    const y = p.getY(i), z = p.getZ(i)
    if (z < zf) front = Math.min(front, y)
    else if (z > zr) rear = Math.min(rear, y)
  }
  return { front: Number.isFinite(front) ? front : 0.34, rear: Number.isFinite(rear) ? rear : 0.34 }
}

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

/** The player character: glTF scene (rig + skinned mesh), its animation clips and albedo texture. */
export interface HeroAsset {
  scene: THREE.Group
  clips: THREE.AnimationClip[]
  map: THREE.Texture | null
}

export interface GameModels {
  hero: HeroAsset
  truck: TruckModel
}

const vehicleCache = new Map<string, Promise<VehicleModel>>()

/** Load (once) and bake a catalogue vehicle. */
export function loadVehicle(id: string, onProgress?: (f: number) => void): Promise<VehicleModel> {
  const def = vehicleDef(id)
  let p = vehicleCache.get(def.id)
  if (!p) {
    let total = def.bytes
    const car = new GLTFLoader().loadAsync(def.url, (e) => {
      if (e.lengthComputable) total = e.total
      onProgress?.(Math.min(1, e.loaded / total))
    })
    p = Promise.all([car, loadHull()]).then(([g, hull]) => ({ ...bakeVehicle(g.scene, def), hull }))
    vehicleCache.set(def.id, p)
  } else onProgress?.(1)
  return p
}

let hullPromise: Promise<HullAsset> | null = null

/** Load (once) the amphibious hull: its parts by node name (`hull_*`), each with its `pivot` extra. */
export function loadHull(): Promise<HullAsset> {
  hullPromise ??= new GLTFLoader().loadAsync(hullUrl).then((g) => {
    const parts: HullAsset['parts'] = new Map()
    for (const m of bakedMeshes(g.scene)) {
      const name = /hull_\w+/.exec(m.name)?.[0]
      if (!name) continue
      for (const a of Object.keys(m.geo.attributes)) if (a !== 'position' && a !== 'normal' && a !== 'color') m.geo.deleteAttribute(a)
      parts.set(name, { geo: m.geo, pivot: (m.extras.pivot as [number, number, number] | undefined) ?? [0, 0, 0] })
    }
    return { parts }
  })
  return hullPromise
}

/** @param onProgress 0..1 over both downloads (bytes). */
export async function loadModels(onProgress?: (f: number) => void, vehicleId = DEFAULT_VEHICLE): Promise<GameModels> {
  const loader = new GLTFLoader()
  const got = [0, 0]
  const report = () => onProgress?.(Math.min(1, (got[0] + got[1]) / 2))
  const [h, t] = await Promise.all([
    loader.loadAsync(heroUrl, (e) => ((got[0] = e.lengthComputable ? e.loaded / e.total : 0.5), report())),
    loadVehicle(vehicleId, (f) => ((got[1] = f), report())),
    loadTreeModels(), // Blender trees: registered before the world builds its tree library (treeModels.ts)
  ])
  let map: THREE.Texture | null = null
  h.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh
    if (m.isSkinnedMesh && !map) map = (m.material as THREE.MeshStandardMaterial).map
  })
  return { hero: { scene: h.scene, clips: h.animations, map }, truck: t }
}

/** The hero's TOW clips (scripts/blender/hero/hero_clips_add.py: Mixamo, retargeted onto its rig, ~0.4 MB) — loaded
 *  after the game starts (nothing needs them before someone takes a hook). */
let towClips: Promise<THREE.AnimationClip[]> | null = null
export function loadHeroTowClips(): Promise<THREE.AnimationClip[]> {
  return (towClips ??= new GLTFLoader().loadAsync(heroTowUrl).then((g) => g.animations))
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
function neutralTexel(tex: THREE.Texture): { uv: [number, number]; color: [number, number, number] } {
  const px = readPixels(tex, 128)
  if (!px) return { uv: [0, 0], color: [1, 1, 1] }
  const { data, w, h } = px
  let best = -1e9, bu = 0, bv = 0, bo = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4
      const [, sat, val] = hsv(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255)
      let dev = 0
      for (const d of [-4, 4, -w * 4, w * 4]) dev += Math.abs(data[o + d] - data[o]) + Math.abs(data[o + d + 1] - data[o + 1]) + Math.abs(data[o + d + 2] - data[o + 2])
      const score = val - sat * 2 - dev / 255
      if (score > best) (best = score), (bu = (x + 0.5) / w), (bv = (y + 0.5) / h), (bo = o)
    }
  }
  const lin = (c: number) => new THREE.Color().setRGB(c / 255, 0, 0, THREE.SRGBColorSpace).r
  return { uv: [bu, tex.flipY ? 1 - bv : bv], color: [lin(data[bo]), lin(data[bo + 1]), lin(data[bo + 2])] }
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

/**
 * REAL PAINT (catalogue `grade`): a model's texture painted in toy-bright colours is graded toward weathered real
 * paint — saturation × sat (around each texel's own luminance) and brightness × gain — keeping its rust, grime and
 * detail. In place, once at load (after the paint mask and lamps have read the original), full resolution.
 */
function gradeTexture(tex: THREE.Texture, sat: number, gain: number): void {
  const img = tex.image as (CanvasImageSource & { width: number; height: number }) | undefined
  if (!img || !img.width || typeof document === 'undefined') return
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0)
  const px = g.getImageData(0, 0, c.width, c.height)
  const d = px.data
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]
    d[i] = (l + (d[i] - l) * sat) * gain
    d[i + 1] = (l + (d[i + 1] - l) * sat) * gain
    d[i + 2] = (l + (d[i + 2] - l) * sat) * gain
  }
  g.putImageData(px, 0, 0)
  tex.image = c
  tex.needsUpdate = true
}

/** A `tyreW` attribute of zeros (geometry drawn on the car program that is not a tyre). */
export function zeroTyre(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute('tyreW')) g.setAttribute('tyreW', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count), 1))
  return g
}

/** Geometry with only position/normal/uv/color/paintMask (so bodies merge), colour baked, uv kept only with a map.
 *  `keepColor`: multiply the source's own vertex colours in (parts authored with them, e.g. `caliper_*`). */
function paintGeometry(g: THREE.BufferGeometry, color: THREE.Color, keepUv: boolean, paint: number, keepColor = false): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone()
  const src = keepColor ? (out.getAttribute('color') as THREE.BufferAttribute | undefined) : undefined
  const srcCol = src ? Array.from({ length: src.count }, (_, i) => [src.getX(i), src.getY(i), src.getZ(i)]) : null
  for (const name of Object.keys(out.attributes)) if (!['position', 'normal', 'uv'].includes(name)) out.deleteAttribute(name)
  const n = out.getAttribute('position').count
  if (!out.getAttribute('normal')) out.computeVertexNormals()
  if (!keepUv) out.deleteAttribute('uv')
  if (!out.getAttribute('uv')) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    color.toArray(col, i * 3)
    if (srcCol) for (let k = 0; k < 3; k++) col[i * 3 + k] *= srcCol[i][k]
  }
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
function bakeVehicle(scene: THREE.Object3D, def: VehicleDef): Omit<VehicleModel, 'hull'> {
  // Models prepared by vehicle_realism.py carry baked AMBIENT OCCLUSION in their vertex colours (scene extra
  // `vertex_ao`): multiplied into every part's material colour. (Older models' vertex colours are not trusted.)
  const vertexAo = !!scene.userData.vertex_ao
  const meshes = bakedMeshes(scene)
  let rim = 0.6
  const bodies: THREE.BufferGeometry[] = [], glasses: THREE.BufferGeometry[] = []
  const wheelParts: { geo: THREE.BufferGeometry; name: string }[] = []
  // Doors (FL / FR: skin, trim and their window) and the steering wheel, split out by node name (Blender prep).
  const doorParts = new Map<string, { body: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[]; hinge: number[] }>()
  const steerParts: THREE.BufferGeometry[] = []
  // Cockpit (vehicle_cabin.py): static cabin parts, gauge faces, moving controls (pivot / axis extras, glTF space).
  const cabParts: THREE.BufferGeometry[] = [], dialParts: THREE.BufferGeometry[] = []
  const controlParts: { kind: string; geo: THREE.BufferGeometry; pivot: THREE.Vector3; axis: THREE.Vector3 }[] = []
  // Brake hardware (`caliper_<FL|FR|RL|RR>`, scripts/blender/vehicle_brakes.py): kept out of the body and of the
  // wheel search (a drum is round and near the ground); the left corners become the per-axle geometry.
  const brakeParts = new Map<string, THREE.BufferGeometry[]>()
  // Tow hooks (`hook_F` / `hook_R`, vehicle_hooks.py): kept out of the body and its collider — the game takes them off.
  const hookParts = new Map<'F' | 'R', { geo: THREE.BufferGeometry; eye: THREE.Vector3; fairlead: THREE.Vector3 }>()
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
    if (/^dial_/i.test(m.name)) {
      // (UVs kept: they map onto the instrument canvas; position + uv only)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', m.geo.getAttribute('position'))
      g.setAttribute('uv', m.geo.getAttribute('uv'))
      if (m.geo.index) g.setIndex(m.geo.index)
      dialParts.push(g)
      continue
    }
    if (glass) {
      // (the car's glass material carries the tint: plain white here)
      const g = paintGeometry(m.geo, new THREE.Color(1, 1, 1), false, 0)
      ;(door ? door.glass : glasses).push(g)
      continue
    }
    const hookKey = /hook_(F|R)\b/i.exec(m.name)?.[1].toUpperCase() as 'F' | 'R' | undefined
    if (hookKey) {
      const g = paintGeometry(m.geo, color, !!mm, 0, true)
      if (!mm) flat.push(g)
      hookParts.set(hookKey, { geo: g, eye: new THREE.Vector3(...((m.extras.eye as number[]) ?? [0, 0, 0])), fairlead: new THREE.Vector3(...((m.extras.fairlead as number[]) ?? [0, 0, 0])) })
      continue
    }
    const brakeKey = /caliper_(FL|FR|RL|RR|BL|BR)/i.exec(m.name)?.[1].toUpperCase().replace('B', 'R')
    if (brakeKey) {
      const g = paintGeometry(m.geo, color, !!mm, 0, true)
      if (!mm) flat.push(g)
      brakeParts.set(brakeKey, [...(brakeParts.get(brakeKey) ?? []), g])
      continue
    }
    if (typeof m.extras.rim === 'number') rim = m.extras.rim as number
    if (mm && !map) map = mm
    const textured = !!mm
    // Door insides / cabin interior: dark trim, never painted (textured: the texture darkened).
    const inner = /inner|interior/i.test(m.mat.name)
    const paint = inner || /^(wheel_|caliper_|acc_|cab_|pedal_|gear_|wiper_|tow_)/i.test(m.name) ? 0 : def.paintRegex ? (def.paintRegex.test(m.mat.name) ? 1 : 0) : 1
    const g = paintGeometry(m.geo, textured ? new THREE.Color(inner ? 0.3 : 1, inner ? 0.3 : 1, inner ? 0.3 : 1) : inner ? color.clone().multiplyScalar(0.35) : color, textured, paint, (vertexAo && !inner) || /^wheel_/i.test(m.name)) // (a big-triangle cabin liner would draw AO gradients as X shapes)
    if (!textured) flat.push(g)
    const control = /^(pedal_(?:gas|brake|clutch)|gear_lever|wiper_[LR])/i.exec(m.name)?.[1].toLowerCase()
    if (def.wheelRegex && def.wheelRegex.test(m.name)) wheelParts.push({ geo: g, name: m.name })
    else if (control && Array.isArray(m.extras.pivot)) controlParts.push({ kind: control, geo: g, pivot: new THREE.Vector3(...(m.extras.pivot as number[])), axis: new THREE.Vector3(...((m.extras.axis as number[]) ?? [1, 0, 0])) })
    else if (/^cab_/i.test(m.name)) cabParts.push(g)
    else if (door) door.body.push(g)
    else if (/steering_wheel/i.test(m.name)) steerParts.push(g)
    else bodies.push(g)
  }
  const neutral = map ? neutralTexel(map) : { uv: [0, 0] as [number, number], color: [1, 1, 1] as [number, number, number] }
  const neutralUv = neutral.uv
  if (map) {
    // Untextured parts sample the neutral texel: point their UVs at it and divide its tint out of their colours,
    // so each shows its own colour (rubber stays black, chrome stays chrome).
    const [nr, ng, nb] = neutral.color.map((c) => 1 / Math.max(0.1, c))
    for (const g of flat) {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) uv.setXY(i, neutralUv[0], neutralUv[1])
      const c = g.getAttribute('color') as THREE.BufferAttribute
      for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * nr, c.getY(i) * ng, c.getZ(i) * nb)
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
  // Steering wheel: a named part, or (catalogue `steering`) the ring in front of the left seat, found in normalised space.
  let steeringWheel: THREE.BufferGeometry | null = null
  let pivot = new THREE.Vector3(), axis = new THREE.Vector3(0, 0, -1), steeringRadius = 0.19
  if (steerParts.length) {
    // Named in Blender (`steering_wheel`, every car now): same pivot / axis solve as below.
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
  const cabin = cabParts.length ? mergeGeometries(cabParts, false)!.applyMatrix4(norm) : null
  const dials = dialParts.length ? mergeGeometries(dialParts, false)!.applyMatrix4(norm) : null
  const turn = new THREE.Matrix4().makeRotationY(rot)
  for (const c of controlParts) (c.geo.applyMatrix4(norm), c.pivot.applyMatrix4(norm), c.axis.applyMatrix4(turn).normalize())
  for (const l of lampParts) l.geo.applyMatrix4(norm)
  for (const w of wheels) (w.c.applyMatrix4(norm), (w.r *= k), w.geo.applyMatrix4(norm))
  for (const d of doorGeo) (d.body.applyMatrix4(norm), d.glass?.applyMatrix4(norm), d.hinge.applyMatrix4(norm))
  const brakeGeo = new Map([...brakeParts.entries()].map(([k, parts]) => [k, mergeGeometries(parts, false)!.applyMatrix4(norm)]))
  for (const h of hookParts.values()) (h.geo.applyMatrix4(norm), h.eye.applyMatrix4(norm), h.fairlead.applyMatrix4(norm))
  // Ground = wheel bottoms; origin = wheelbase centre.
  const groundY = Math.min(...wheels.map((w) => w.c.y - w.r))
  const cx = wheels.reduce((a, w) => a + w.c.x, 0) / 4, cz = wheels.reduce((a, w) => a + w.c.z, 0) / 4
  const shift = new THREE.Matrix4().makeTranslation(-cx, -groundY, -cz)
  body.applyMatrix4(shift)
  glass.applyMatrix4(shift)
  cabin?.applyMatrix4(shift)
  dials?.applyMatrix4(shift)
  const controls: CockpitPart[] = controlParts.map((c) => {
    c.geo.applyMatrix4(shift)
    c.pivot.applyMatrix4(shift)
    c.geo.translate(-c.pivot.x, -c.pivot.y, -c.pivot.z)
    c.geo.computeBoundingSphere()
    zeroTyre(c.geo)
    return { kind: c.kind, geo: c.geo, pivot: c.pivot.toArray() as [number, number, number], axis: c.axis.toArray() as [number, number, number] }
  })
  if (cabin) (zeroTyre(cabin), cabin.computeBoundingSphere())
  dials?.computeBoundingSphere()
  for (const l of lampParts) l.geo.applyMatrix4(shift)
  for (const w of wheels) (w.c.applyMatrix4(shift), w.geo.applyMatrix4(shift))
  for (const g of brakeGeo.values()) g.applyMatrix4(shift)
  const hook = (key: 'F' | 'R'): TowHook | null => {
    const h = hookParts.get(key)
    if (!h) return null
    h.geo.applyMatrix4(shift)
    h.eye.applyMatrix4(shift)
    h.fairlead.applyMatrix4(shift)
    h.geo.translate(-h.eye.x, -h.eye.y, -h.eye.z)
    h.geo.computeBoundingSphere()
    zeroTyre(h.geo)
    return { geo: h.geo, eye: h.eye.toArray() as [number, number, number], fairlead: h.fairlead.toArray() as [number, number, number] }
  }
  const hooks = { front: hook('F'), rear: hook('R') }
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
  // Brakes into the left hubs' space; their vertex colours divided by the neutral texel they sample (textured
  // models), so the part shows its own colour.
  const hubBrake = (key: string, hub: [number, number, number]): THREE.BufferGeometry | null => {
    const g = brakeGeo.get(key)
    if (!g) return null
    g.translate(-hub[0], -hub[1], -hub[2])
    g.computeBoundingSphere()
    return g
  }
  const brakes = { front: hubBrake('FL', wheelPos[0]), rear: hubBrake('RL', wheelPos[2]) }
  for (const [k, g] of brakeGeo) if (k !== 'FL' && k !== 'RL') g.dispose()
  // TYRE WEIGHT per vertex (the deformation shader flattens and bulges only the rubber): 0 inside the rim, rising
  // over the bead to 1 on the sidewall and tread. Every other geometry on the car program gets 0 (§6: a program's
  // attributes must exist on all of its geometries).
  {
    const p = wheel.getAttribute('position'), tw = new Float32Array(p.count)
    const rimR = rim * fl.r, top = rimR + 0.35 * (fl.r - rimR)
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, (Math.hypot(p.getY(i), p.getZ(i)) - rimR * 1.04) / Math.max(1e-4, top - rimR * 1.04)))
      tw[i] = t * t * (3 - 2 * t)
    }
    wheel.setAttribute('tyreW', new THREE.BufferAttribute(tw, 1))
  }
  for (const g of [body, steeringWheel, brakes.front, brakes.rear, ...doors.map((d) => d.body)]) if (g) zeroTyre(g)
  for (const g of [body, wheel, glass, steeringWheel]) if (g) (g.computeBoundingBox(), g.computeBoundingSphere())
  const bb = body.boundingBox!.clone()
  const tyreHalfWidth = (wheel.boundingBox!.max.x - wheel.boundingBox!.min.x) / 2
  let mesh: Float32Array | undefined, hulls: Float32Array[] | undefined
  if (doors.length) bb.union(outline)
  carExposure(bb, [{ g: body }, { g: glass, solidOnly: true }, ...doors.flatMap((d) => [{ g: d.body, at: d.hinge }, { g: d.glass, at: d.hinge, solidOnly: true }])],
    [cabin, steeringWheel, ...controls.map((c) => c.geo)])
  // The glass's car-space rest position (Car carGlass: its rain / snow and the wipers' arcs are laid out in it — a door
  // pane's own position is hinge-local, which put it under the wiper arcs and broke its crust from the body's)
  const glassRest = (g: THREE.BufferGeometry | null, at = [0, 0, 0]) => {
    const p = g?.getAttribute('position')
    if (!g || !p) return
    const a = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) a.set([p.getX(i) + at[0], p.getY(i) + at[1], p.getZ(i) + at[2]], i * 3)
    g.setAttribute('aGlassP', new THREE.BufferAttribute(a, 3))
  }
  glassRest(glass)
  for (const d of doors) glassRest(d.glass, d.hinge)
  if (map) map.colorSpace = THREE.SRGBColorSpace
  const paintMap = map ? buildPaintMap(map, !!def.whitePaint) : null
  const lamps = map ? findLamps(body, map, bb.min.z, bb.max.z) : { head: null, tail: null }
  if (lampParts.length) {
    const fromParts = findLampsInParts(lampParts.map((l) => ({ geo: l.geo.index ? l.geo.toNonIndexed() : l.geo, color: l.color })), bb.min.z, bb.max.z)
    lamps.head ??= fromParts.head
    lamps.tail ??= fromParts.tail
  }
  lampParts.forEach((l) => l.geo.dispose())
  meshes.forEach((m) => m.geo.dispose())
  all.dispose()
  if (map && def.grade) gradeTexture(map, def.grade.sat, def.grade.gain)
  return {
    id: def.id,
    body, glass, wheel, wheelPos,
    steeringWheel, steeringPivot: pivot.toArray() as [number, number, number], steeringAxis: axis.toArray() as [number, number, number],
    wheelRadius: fl.r,
    half: { x: (bb.max.x - bb.min.x) / 2, y: (bb.max.y - bb.min.y) / 2, z: (bb.max.z - bb.min.z) / 2 },
    bottom: bb.min.y,
    front: bb.min.z,
    rear: bb.max.z,
    overhang: overhangs(body, wheelPos, fl.r, (bb.max.x - bb.min.x) / 2),
    tyreHalfWidth,
    // Built on first use (the car you drive), then kept with the model.
    get mesh() {
      return (mesh ??= triangles([
        { g: body, at: undefined }, { g: glass, at: undefined },
        // door parts are in hinge space: back to the closed position
        ...doors.flatMap((d) => [{ g: d.body, at: d.hinge }, { g: d.glass, at: d.hinge }]),
        // (a part may be an empty placeholder — a door glass with no vertices: switching to it threw here)
      ].filter((p) => p.g?.getAttribute('position')).map((p) => ({ position: p.g!.getAttribute('position').array, index: p.g!.index?.array ?? null, offset: p.at }))))
    },
    get hulls() {
      return (hulls ??= bodyHulls(this.mesh, wheelPos.map((hub) => ({ hub, radius: fl.r, halfWidth: tyreHalfWidth })), 0.3))
    },
    map,
    paintMap,
    lamps,
    doors,
    steeringRadius,
    neutralUv,
    neutralColor: neutral.color,
    brakes,
    rim,
    cabin,
    dials,
    controls,
    hooks,
  }
}

/**
 * DIRT ANCHOR + EXPOSURE (2026-10-24, the user: "the mud / snow is like pixels moving round the car, and the inside of the
 * car gets it too"): every body / door vertex gets `aCar` = (its car-space rest position, its EXPOSURE 0..1). The dirt
 * shader (Car truckMaterial) draws its mud / dust / snow noise from that position — locked to the panels, continuous
 * across the door seams (the world position slid the pattern over the car as it drove) — and only where the surface is
 * open to the outside: the shell (glass counted solid) is voxelised at 8 cm and from each vertex (12 cm off its face)
 * six axis rays march out from each side of it; an exterior panel sees out along ≥ 3 of them, the seats, dash, floor and
 * door cards along none (exposure 0). Signed: − when the outside is against the vertex normal (inward-wound skins). The cabin, steering wheel and controls are sheltered outright. ~50–150 ms per model, at load.
 */
function carExposure(bb: THREE.Box3, parts: { g: THREE.BufferGeometry | null; at?: [number, number, number]; solidOnly?: boolean }[], sheltered: (THREE.BufferGeometry | null)[]): void {
  const C = 0.08, M = 0.3
  const ox = bb.min.x - M, oy = bb.min.y - M, oz = bb.min.z - M
  const nx = Math.ceil((bb.max.x - bb.min.x + 2 * M) / C), ny = Math.ceil((bb.max.y - bb.min.y + 2 * M) / C), nz = Math.ceil((bb.max.z - bb.min.z + 2 * M) / C)
  const solid = new Uint8Array(nx * ny * nz)
  const mark = (x: number, y: number, z: number) => {
    const i = Math.floor((x - ox) / C), j = Math.floor((y - oy) / C), k = Math.floor((z - oz) / C)
    if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) solid[(k * ny + j) * nx + i] = 1
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (const p of parts) {
    const pos = p.g?.getAttribute('position')
    if (!pos) continue
    const idx = p.g!.index, n = idx ? idx.count : pos.count, at = p.at ?? [0, 0, 0]
    const vi = (k: number) => (idx ? idx.getX(k) : k)
    for (let t = 0; t + 2 < n; t += 3) {
      a.fromBufferAttribute(pos, vi(t)); b.fromBufferAttribute(pos, vi(t + 1)); c.fromBufferAttribute(pos, vi(t + 2))
      const s = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / (C * 0.7)))
      for (let u = 0; u <= s; u++) for (let v = 0; u + v <= s; v++) {
        const w = s - u - v
        mark((a.x * u + b.x * v + c.x * w) / s + at[0], (a.y * u + b.y * v + c.y * w) / s + at[1], (a.z * u + b.z * v + c.z * w) / s + at[2])
      }
    }
  }
  const occ = (x: number, y: number, z: number) => {
    const i = Math.floor((x - ox) / C), j = Math.floor((y - oy) / C), k = Math.floor((z - oz) / C)
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1 // out: escaped
    return solid[(k * ny + j) * nx + i]
  }
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const cache = new Map<string, number>()
  for (const p of parts) {
    if (!p.g || p.solidOnly) continue
    const pos = p.g.getAttribute('position'), nor = p.g.getAttribute('normal'), at = p.at ?? [0, 0, 0]
    if (!pos) continue
    const out = new Float32Array(pos.count * 4)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + at[0], y = pos.getY(i) + at[1], z = pos.getZ(i) + at[2]
      const key = `${Math.round(x * 50)},${Math.round(y * 50)},${Math.round(z * 50)},${nor ? Math.round(nor.getX(i) * 4) + ',' + Math.round(nor.getY(i) * 4) + ',' + Math.round(nor.getZ(i) * 4) : ''}`
      let e = cache.get(key)
      if (e === undefined) {
        // both sides of the face (the models' normals are not to be trusted: the van's skin faces inward): the side that
        // sees out along more axes is the OUTSIDE — its exposure, signed by which side it is (+ along the normal)
        const ways = (k: number) => {
          const sx = x + (nor ? nor.getX(i) : 0) * 0.12 * k, sy = y + (nor ? nor.getY(i) : 0) * 0.12 * k, sz = z + (nor ? nor.getZ(i) : 0) * 0.12 * k
          let free = 0
          for (const d of DIRS) {
            for (let s = 1; ; s++) {
              const o = occ(sx + d[0] * C * s, sy + d[1] * C * s, sz + d[2] * C * s)
              if (o === -1) { free++; break }
              if (o === 1) break
            }
          }
          return free
        }
        const fp = ways(1), fn = ways(-1)
        e = Math.min(1, Math.max(0, (Math.max(fp, fn) - 1.5) / 2)) * (fn > fp ? -1 : 1) // 0 (≤ 1 way out) … ±1 (≥ 4)
        cache.set(key, e)
      }
      out.set([x, y, z, e], i * 4)
    }
    p.g.setAttribute('aCar', new THREE.BufferAttribute(out, 4))
  }
  for (const g of sheltered) {
    const pos = g?.getAttribute('position')
    if (!g || !pos) continue
    const out = new Float32Array(pos.count * 4)
    for (let i = 0; i < pos.count; i++) out.set([pos.getX(i), pos.getY(i), pos.getZ(i), 0], i * 4)
    g.setAttribute('aCar', new THREE.BufferAttribute(out, 4))
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
