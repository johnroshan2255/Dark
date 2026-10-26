import * as THREE from 'three'
import type { Horizon } from './Horizon'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { Tier } from './quality'
import { SHADOW_GLSL, type TerrainShadow } from './TerrainShadow'

/**
 * ROCKS — Over-the-Hill boulders: chunky low-poly blocks (the convex hull of a few points on a squashed, boxy blob:
 * big flat faces, chamfered edges), light neutral grey, flat-shaded, a soft darkening toward the ground. Placed once
 * at load from the map (deterministic): OUTCROPS of 3–8 blocks on the steeper slopes and ridges, lone boulders in the
 * meadows, a few in and along the river. One instanced draw per shape variant; the instances written are those
 * within the tier's reach, in view, not behind a hill and not too small to see (`update`).
 */
const VARIANTS = 6
const CELL = 128

export interface Inst { x: number; y: number; z: number; s: number; sy: number; rot: number; tilt: number; v: number }

export class Rocks {
  readonly group = new THREE.Group()
  private readonly meshes: THREE.InstancedMesh[] = []
  private readonly grid = new Map<number, Inst[]>()
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()
  private readonly reach: number
  count = 0
  /** Every rock (the physics builds colliders for the ones near the car) and each shape's vertices (unit size). */
  readonly all: Inst[]
  readonly shapes: Float32Array[] = []
  /** Where the rocks stand (R8 on the box's 2 m grid, 255 = covered): the grass keeps out of them. */
  readonly footprint: THREE.DataTexture

  constructor(private readonly map: MapData, atmos: Atmosphere, shadow: TerrainShadow, tier: Tier, farGrid: THREE.Vector4) {
    this.reach = tier.rockReach
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...atmos.uniforms, ...shadow.uniforms, uFarGrid: { value: farGrid } },
      defines: tier.spec ? { OTH_SPEC: '' } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
    })
    const all = (this.all = this.place())
    for (let v = 0; v < VARIANTS; v++) {
      const geo = boulder(0x51ed + v * 977)
      this.shapes.push(geo.attributes.position.array as Float32Array)
      const n = all.filter((r) => r.v === v).length
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n))
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.meshes.push(mesh)
      this.group.add(mesh)
    }
    const g = map.inner, fp = new Uint8Array(g.n * g.n)
    for (const r of all) {
      const rad = r.s * 0.5, i0 = Math.max(0, Math.floor((r.x - rad - g.origin) / g.step)), i1 = Math.min(g.n - 1, Math.ceil((r.x + rad - g.origin) / g.step))
      const j0 = Math.max(0, Math.floor((r.z - rad - g.origin) / g.step)), j1 = Math.min(g.n - 1, Math.ceil((r.z + rad - g.origin) / g.step))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(g.origin + i * g.step - r.x, g.origin + j * g.step - r.z) / rad
        const v = Math.round(255 * Math.min(1, Math.max(0, (1.15 - d) / 0.3)))
        if (v > fp[j * g.n + i]) fp[j * g.n + i] = v
      }
    }
    this.footprint = new THREE.DataTexture(fp, g.n, g.n, THREE.RedFormat, THREE.UnsignedByteType)
    this.footprint.minFilter = this.footprint.magFilter = THREE.LinearFilter
    this.footprint.unpackAlignment = 1
    this.footprint.needsUpdate = true
    for (const r of all) {
      const k = this.key(Math.floor(r.x / CELL), Math.floor(r.z / CELL))
      let list = this.grid.get(k)
      if (!list) this.grid.set(k, (list = []))
      list.push(r)
    }
  }

  private key(i: number, j: number): number { return (i + 512) * 1024 + (j + 512) }

  /** Rocks within r m of (x, z), biggest first (the shot harness). */
  candidates(x: number, z: number, r: number): Inst[] {
    const out: Inst[] = []
    for (const list of this.grid.values()) for (const k of list) if ((k.x - x) ** 2 + (k.z - z) ** 2 < r * r) out.push(k)
    return out.sort((a, b) => b.s - a.s).slice(0, 80)
  }

  /** The biggest rock within r m of (x, z) — the shot harness frames outcrops with it. */
  biggestNear(x: number, z: number, r: number): Inst | null {
    let best: Inst | null = null
    for (const list of this.grid.values()) for (const k of list) {
      if ((k.x - x) ** 2 + (k.z - z) ** 2 < r * r && (!best || k.s > best.s)) best = k
    }
    return best
  }

  /** Deterministic placement from the map's height + mask. */
  private place(): Inst[] {
    const out: Inst[] = []
    const map = this.map, half = map.half - 40
    let s = 0x2545f491
    const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
    const mk: [number, number, number, number] = [0, 0, 0, 0]
    const slope = (x: number, z: number) => {
      const dx = map.height(x + 3, z) - map.height(x - 3, z), dz = map.height(x, z + 3) - map.height(x, z - 3)
      return Math.hypot(dx, dz) / 6
    }
    // not in / at the water, never on a track
    const dry = (x: number, z: number) => map.maskAt(x, z, mk)[2] < 0.8 && map.trailDist(x, z) > map.meta.trails.hw + 2.5
    const add = (x: number, z: number, size: number, sink: number) => {
      // (sunk by the ground's fall across the rock, so its uphill side never floats)
      const r = size * 0.5
      const y = Math.min(map.height(x - r, z), map.height(x + r, z), map.height(x, z - r), map.height(x, z + r), map.height(x, z))
      out.push({ x, y: y - sink * size * 0.3, z, s: size, sy: size * (1.0 + 0.6 * rnd()), rot: rnd() * Math.PI * 2, tilt: (rnd() - 0.5) * 0.2, v: Math.floor(rnd() * VARIANTS) })
    }
    // OUTCROPS: a jittered 40 m grid; likelier on steep ground and the rock mask, never in water
    for (let gz = -half; gz < half; gz += 40) {
      for (let gx = -half; gx < half; gx += 40) {
        const x = gx + rnd() * 40, z = gz + rnd() * 40
        const sl = slope(x, z)
        map.maskAt(x, z, mk)
        // (none ON the outcrops — they're terrain now; a few loose boulders round their edge)
        if (mk[0] > 0.55) continue
        const p = Math.min(0.6, Math.max(0, (sl - 0.22) * 1.6) + mk[0] * 1.2) * (dry(x, z) ? 1 : 0) * (1 - mk[3] * 0.5)
        if (rnd() > p) continue
        const n = 4 + Math.floor(rnd() * 6), big = 5 + rnd() * 9
        for (let i = 0; i < n; i++) {
          const a = rnd() * Math.PI * 2, d = rnd() * big * 1.4
          const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d
          if (!dry(px, pz)) continue
          add(px, pz, big * (0.35 + 0.65 * rnd()) * (i === 0 ? 1.3 : 1), 0.25)
        }
      }
    }
    // round the SPAWN and along the TRACKS: a few boulders close by (the player's first view is never empty)
    const sp = map.meta.spawn
    for (let k = 0; k < 26; k++) {
      const a = rnd() * Math.PI * 2, d = 22 + rnd() * 160
      const x = sp.x + Math.cos(a) * d, z = sp.z + Math.sin(a) * d
      if (dry(x, z)) add(x, z, 1.4 + rnd() * 3.2, 0.3)
    }
    for (const L of map.meta.trails.lines) for (let i = 0; i < L.length; i += 3) {
      if (rnd() > 0.12) continue
      const [x0, z0] = L[i], side = rnd() < 0.5 ? -1 : 1, j = Math.min(L.length - 1, i + 1)
      const dx = L[j][0] - x0, dz = L[j][1] - z0, l = Math.hypot(dx, dz) || 1, off = map.meta.trails.hw + 3 + rnd() * 9
      const x = x0 - (dz / l) * off * side, z = z0 + (dx / l) * off * side
      if (dry(x, z)) add(x, z, 0.9 + rnd() * 2.4, 0.3)
    }
    // LONE BOULDERS in the open
    for (let gz = -half; gz < half; gz += 70) {
      for (let gx = -half; gx < half; gx += 70) {
        if (rnd() > 0.22) continue
        const x = gx + rnd() * 70, z = gz + rnd() * 70
        if (!dry(x, z)) continue
        add(x, z, 1.2 + rnd() * 2.6, 0.3)
      }
    }
    // the RIVER: stones in the shallows and on the banks
    const r = map.meta.water.river
    for (let i = 0; i < r.x.length; i += 2) {
      if (rnd() > 0.35) continue
      const a = rnd() * Math.PI * 2, d = r.hw[i] * (0.6 + rnd() * 1.4)
      add(r.x[i] + Math.cos(a) * d, r.z[i] + Math.sin(a) * d, 0.6 + rnd() * 1.8, 0.35)
    }
    return out
  }

  /** Terrain occlusion (main.ts sets it): cells behind the hills are skipped. */
  horizon: Horizon | null = null
  /** Per 128 m cell: the lowest base and the highest top of its rocks (the culling's box). */
  private readonly cellBox = new Map<number, [number, number]>()
  private readonly lastPos = new THREE.Vector3(Number.NaN, 0, 0)
  private readonly lastDir = new THREE.Vector3()
  private readonly frustum = new THREE.Frustum()
  private readonly pv = new THREE.Matrix4()
  private readonly box = new THREE.Box3()
  private readonly dir = new THREE.Vector3()
  private readonly p = new THREE.Vector3()
  private readonly sc = new THREE.Vector3()
  /** Cells culled at the last rebuild: outside the view, hidden behind the ground (the HUD). */
  culled = { frustum: 0, occluded: 0, small: 0 }

  /** A rock's world matrix (the same one it is drawn with). */
  matrixOf(r: Inst, out: THREE.Matrix4): THREE.Matrix4 {
    this.q.setFromEuler(this.e.set(r.tilt, r.rot, r.tilt * 0.6))
    return out.compose(new THREE.Vector3(r.x, r.y, r.z), this.q, new THREE.Vector3(r.s, r.sy, r.s * 0.9))
  }

  /**
   * Re-picks the rocks to draw when the camera has moved 4 m or turned (they never move). CULLING, per 128 m cell:
   * DISTANCE (the tier's reach), FRUSTUM (the cell's box against the view), OCCLUSION (the cell hidden behind the
   * hills: Horizon); per rock: DISTANCE again, and SMALL-FEATURE culling (a rock under ~2 px tall at its distance).
   */
  update(camera: THREE.PerspectiveCamera): void {
    camera.getWorldDirection(this.dir)
    if (camera.position.distanceToSquared(this.lastPos) < 16 && this.dir.dot(this.lastDir) > 0.9985) return
    this.lastPos.copy(camera.position); this.lastDir.copy(this.dir)
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.pv)
    const cx = camera.position.x, cz = camera.position.z, R = this.reach
    // (a rock s m big at d m is s / d × this px tall: under 2 px it isn't drawn)
    const pxPerRad = (innerHeight * Math.min(devicePixelRatio, 2)) / (2 * Math.tan((camera.fov * Math.PI) / 360))
    const minRatio = 2 / pxPerRad
    for (const m of this.meshes) m.count = 0
    this.culled.frustum = this.culled.occluded = this.culled.small = 0
    const i0 = Math.floor((cx - R) / CELL), i1 = Math.floor((cx + R) / CELL), j0 = Math.floor((cz - R) / CELL), j1 = Math.floor((cz + R) / CELL)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = this.key(i, j), list = this.grid.get(k)
      if (!list) continue
      const x0 = i * CELL, z0 = j * CELL
      const nx = Math.max(x0 - cx, 0, cx - x0 - CELL), nz = Math.max(z0 - cz, 0, cz - z0 - CELL)
      if (nx * nx + nz * nz > R * R) continue
      let yb = this.cellBox.get(k)
      if (!yb) {
        yb = [Infinity, -Infinity]
        for (const r of list) { yb[0] = Math.min(yb[0], r.y - r.s * 0.3); yb[1] = Math.max(yb[1], r.y + r.sy * 0.7) }
        this.cellBox.set(k, yb)
      }
      // (rocks hang over their cell's edge by up to half their size)
      this.box.min.set(x0 - 10, yb[0], z0 - 10)
      this.box.max.set(x0 + CELL + 10, yb[1], z0 + CELL + 10)
      if (!this.frustum.intersectsBox(this.box)) { this.culled.frustum++; continue }
      if (this.horizon?.hidden(x0 - 10, z0 - 10, x0 + CELL + 10, z0 + CELL + 10, yb[1])) { this.culled.occluded++; continue }
      for (const r of list) {
        const dx = r.x - cx, dz = r.z - cz, d2 = dx * dx + dz * dz
        if (d2 > R * R) continue
        if (r.sy * r.sy < minRatio * minRatio * d2) { this.culled.small++; continue }
        const mesh = this.meshes[r.v]
        this.q.setFromEuler(this.e.set(r.tilt, r.rot, r.tilt * 0.6))
        this.m.compose(this.p.set(r.x, r.y, r.z), this.q, this.sc.set(r.s, r.sy, r.s * 0.9))
        mesh.setMatrixAt(mesh.count++, this.m)
      }
    }
    this.count = 0
    for (const m of this.meshes) { m.instanceMatrix.needsUpdate = true; this.count += m.count }
  }
}

/**
 * One boulder shape (unit size): a CHAMFERED BLOCK — each corner of a box of random proportions (jittered) cut by
 * three chamfer points, a few faces bulged a little — then hulled: big flat faces, soft bevelled edges, flat-shaded.
 */
function boulder(seed: number): THREE.BufferGeometry {
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
  const ex = 0.5, ey = 0.5 * (0.55 + 0.35 * rnd()), ez = 0.5 * (0.65 + 0.35 * rnd())
  const pts: THREE.Vector3[] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    // the top a little smaller than the base, every corner its own
    const k = sy > 0 ? 0.9 + 0.08 * rnd() : 1
    const cx = sx * ex * k * (0.85 + 0.15 * rnd()), cy = sy * ey * (0.85 + 0.15 * rnd()), cz = sz * ez * k * (0.85 + 0.15 * rnd())
    const c = 0.1 + 0.08 * rnd()
    pts.push(new THREE.Vector3(cx - sx * c, cy, cz), new THREE.Vector3(cx, cy - sy * c, cz), new THREE.Vector3(cx, cy, cz - sz * c))
  }
  // bulged sides (a facet or two more); the top stays flat
  for (let i = 0; i < 3; i++) {
    const a = rnd() * Math.PI * 2
    pts.push(new THREE.Vector3(Math.cos(a) * ex * 1.06, (rnd() - 0.3) * ey, Math.sin(a) * ez * 1.06))
  }
  // flat faces, the chamfer bands between them smoothed (creased normals): big planes with soft rounded edges
  const g = toCreasedNormals(new ConvexGeometry(pts), Math.PI / 4.5)
  g.deleteAttribute('uv')
  return g
}

const VERT = /* glsl */ `
${ATMOS_GLSL}
out vec3 vWorld;
out vec3 vN;
out float vUp;
void main() {
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vUp = position.y + 0.5; // 0 at the base … 1 on top
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
uniform vec4 uFarGrid;
${SHADOW_GLSL}
in vec3 vWorld;
in vec3 vN;
in float vUp;
const vec3 STONE = vec3(0.2, 0.205, 0.23);
float fhash(vec3 n) { return fract(sin(dot(floor(n * 300.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vWorld);
  // light grey, each face a touch different, the tops lighter, a soft darkening into the ground
  vec3 albedo = STONE * (0.94 + 0.12 * fhash(N)) * mix(0.72, 1.0, smoothstep(0.0, 0.45, vUp)) * (1.0 + 0.06 * N.y);
  float sun = sunVisibility(vWorld.xz);
  vec3 c = shade(albedo, N, V, 0.75, 0.04, mix(0.6, 1.0, smoothstep(0.0, 0.5, vUp)), sun, 0.05);
  c += headlight(albedo, N, vWorld);
  gl_FragColor = vec4(applyAtmos(c, vWorld), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
