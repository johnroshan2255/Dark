import * as THREE from 'three'
import type { Horizon } from './Horizon'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { Tier } from './quality'
import type { Rocks } from './Rocks'
import { SHADOW_GLSL, type TerrainShadow } from './TerrainShadow'
import { createLeafTexture, LEAF_GLSL } from './leafTexture'
import { broadleafGeometry, CROWN, spruceGeometry } from './treeGeometry'

/**
 * THE FORESTS — Over-the-Hill mixed woods: open spruce / golden-larch stands (the stylized conifer) and groves of
 * white-trunked birches and red-orange aspens (the broadleaf, treeGeometry.ts), a few bare snags, lone trees on the
 * meadows. Placed once at load, deterministic, from
 * the map's forest mask (a jittered ~6.5 m grid), never on a track, in water, on rock or a boulder.
 *
 * Drawn in 5 instanced draws: per shape family a near LOD (`tier.treeNear`; conifer 864 vertices, broadleaf ~320) and
 * a mid LOD (to `treeMid`), and for every species together
 * beyond, IMPOSTORS to `treeReach`: at load each species is rendered (its near LOD) from 12 directions × 3 heights
 * into an image atlas — albedo × AO and the tree-space normal (two render targets at once) — and a far tree is one
 * camera-facing quad showing the baked view nearest its own, relit with the sun from the normal image: 2 triangles,
 * the full plume detail, the same light. Its alpha test is corrected by the mip level (no shrinking or shimmer far
 * away). Beyond `treeFar` only a share of the impostors is drawn (rank cull), each a little bigger. The lists are
 * rebuilt from 64 m tiles (frustum- and distance-culled) when the camera has moved a few metres or turned.
 *
 * SHADOWS: every tree stamps a soft shadow (offset away from the sun by its height) into the terrain shadow's tree
 * texture (2 m) — the ground, the grass, the water, the rocks and the car darken under the forest; a tree's lower
 * crown also takes the shade it stands in.
 */
const TILE = 64
/** Values per tree in `data`: x, y, z, height, rotation, species, seed, rank.
 *  Species: 0 spruce, 1 larch, 2 snag (the conifer shape) · 3 birch (gold), 4 aspen (red / orange), 5 green broadleaf
 *  (the broadleaf shape, white trunks) — OTH's mixed autumn woods. */
export const TREE_STRIDE = 8
/** The shape family of a species: 0 conifer, 1 broadleaf. */
const family = (sp: number) => (sp >= 3 ? 1 : 0)
/** The species with impostors, in atlas row order (a snag is a pixel there). */
const IMP_SPECIES = [0, 1, 3, 4, 5]

export class Trees {
  readonly group = new THREE.Group()
  /** Every tree (TREE_STRIDE floats each). */
  readonly data: Float32Array
  readonly count: number
  private readonly tiles = new Map<number, number[]>()
  private readonly tileMaxH = new Map<number, number>()
  private readonly lods: { geo: THREE.InstancedBufferGeometry; a0: THREE.InstancedBufferAttribute; a1: THREE.InstancedBufferAttribute; max: number; n: number }[] = []
  private readonly frustum = new THREE.Frustum()
  private readonly pv = new THREE.Matrix4()
  private readonly box = new THREE.Box3()
  private readonly lastPos = new THREE.Vector3(1e9, 0, 0)
  private readonly lastDir = new THREE.Vector3()
  private readonly ranges: number[]
  private bakedSun = new THREE.Vector3(0, -1, 0)
  drawn = [0, 0, 0, 0, 0]
  private readonly impMat: THREE.ShaderMaterial
  private readonly noiseU: THREE.IUniform
  private readonly leafU: THREE.IUniform
  /** The leaf texture (the bushes are built of the same leaf cards). */
  get leafTexture(): THREE.Texture { return this.leafU.value }

  constructor(private readonly map: MapData, atmos: Atmosphere, private readonly shadow: TerrainShadow, tier: Tier, rocks: Rocks) {
    this.noiseU = atmos.uniforms.uNoise
    this.ranges = [tier.treeNear, tier.treeMid, tier.treeFar, tier.treeReach]
    this.data = this.place(rocks)
    this.count = this.data.length / TREE_STRIDE
    for (let i = 0; i < this.count; i++) {
      const o = i * TREE_STRIDE, k = this.key(Math.floor(this.data[o] / TILE), Math.floor(this.data[o + 2] / TILE))
      let l = this.tiles.get(k)
      if (!l) this.tiles.set(k, (l = []))
      l.push(i)
      this.tileMaxH.set(k, Math.max(this.tileMaxH.get(k) ?? 0, this.data[o + 1] + this.data[o + 3]))
    }
    this.leafU = { value: createLeafTexture() }
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...atmos.uniforms, ...shadow.uniforms, uFarGrid: { value: new THREE.Vector4(map.far.n, map.far.step, map.far.origin, 0) }, uLeafTex: this.leafU },
      vertexColors: true,
      defines: { ...(tier.spec ? { OTH_SPEC: '' } : {}), ...(tier.msaa ? { A2C: '' } : {}) },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      // MSAA tiers: the leaf cards' gaps resolve to soft coverage (no hard, shimmering cut-out)
      alphaToCoverage: tier.msaa,
    })
    this.impMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...atmos.uniforms, ...shadow.uniforms, uFarGrid: { value: new THREE.Vector4(map.far.n, map.far.step, map.far.origin, 0) },
        uImpAlb: { value: null }, uImpNor: { value: null }, uImpSize: { value: new THREE.Vector2(IMP.cols * IMP.fw, IMP.rows * IMP.fh) },
      },
      defines: { ...(tier.spec ? { OTH_SPEC: '' } : {}), IMP_NA: IMP.cols.toFixed(1), IMP_ROWS: IMP.rows.toFixed(1), IMP_FW: IMP.FW.toFixed(3), IMP_FH: IMP.FH.toFixed(3), IMP_CY: IMP.CY.toFixed(3), IMP_E1: ((IMP.elev[0] + IMP.elev[1]) / 2).toFixed(3), IMP_E2: ((IMP.elev[1] + IMP.elev[2]) / 2).toFixed(3) },
      vertexShader: IMP_VERT,
      fragmentShader: IMP_FRAG,
      // MSAA tiers: the alpha edge resolves to smooth coverage (no hard, shimmering cut-out); LOW keeps the test
      alphaToCoverage: tier.msaa,
    })
    // capacities: the most trees a LOD can hold in view (its ring's area × the densest forest), capped
    // draws: 0 conifer near, 1 conifer mid, 2 broadleaf near, 3 broadleaf mid, 4 impostors (every species)
    const dens = 1 / 30
    const ring = [[0, this.ranges[0]], [this.ranges[0], this.ranges[1]], [0, this.ranges[0]], [this.ranges[0], this.ranges[1]], [this.ranges[1], this.ranges[3]]]
    for (let l = 0; l < 5; l++) {
      const [r0, r1] = ring[l]
      const max = Math.min(l === 4 ? 60000 : 30000, Math.ceil(Math.PI * (r1 * r1 - r0 * r0) * dens * 0.6) + 64)
      const src = l === 4 ? impostorQuad() : l < 2 ? spruceGeometry(l) : broadleafGeometry(l - 2)
      const geo = new THREE.InstancedBufferGeometry()
      for (const n of l < 4 ? ['position', 'normal', 'color', 'leaf'] : ['position']) geo.setAttribute(n, src.getAttribute(n))
      geo.setIndex(src.getIndex()) // (indexed: the near tree is 947 shared vertices)
      const a0 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4), a1 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
      a0.setUsage(THREE.DynamicDrawUsage); a1.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aT0', a0); geo.setAttribute('aT1', a1)
      geo.instanceCount = 0
      const mesh = new THREE.Mesh(geo, l < 4 ? mat : this.impMat)
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      if (l === 4) mesh.visible = false // (until the atlas is baked)
      this.group.add(mesh)
      this.lods.push({ geo, a0, a1, max, n: 0 })
    }
  }

  private key(i: number, j: number): number { return (i + 512) * 1024 + (j + 512) }

  /** Deterministic placement from the forest mask. */
  private place(rocks: Rocks): Float32Array {
    const map = this.map, out: number[] = []
    const G = 6.5, half = map.half - 50
    let s = 0x7f4a7c15
    const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
    const mk: [number, number, number, number] = [0, 0, 0, 0]
    const hw = map.meta.trails.hw
    const fp = rocks.footprint.image.data as Uint8Array, g = map.inner
    const sp = map.meta.spawn
    // a slow noise: golden larch stands among the spruce
    const vn = (x: number, z: number) => {
      const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi
      const h = (a: number, b: number) => (((Math.imul(a, 374761393) + Math.imul(b, 668265263)) ^ 0x5bd1e995) >>> 0) % 1000 / 1000
      const u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz)
      return (h(xi, zi) * (1 - u) + h(xi + 1, zi) * u) * (1 - w) + (h(xi, zi + 1) * (1 - u) + h(xi + 1, zi + 1) * u) * w
    }
    for (let gz = -half; gz < half; gz += G) {
      for (let gx = -half; gx < half; gx += G) {
        // (jittered past the cell's edges: no rows — a dense grove's cells all hold a tree, and an even grid shows)
        const x = gx + (rnd() * 1.7 - 0.35) * G, z = gz + (rnd() * 1.7 - 0.35) * G
        map.maskAt(x, z, mk)
        const forest = Math.min(1, Math.max(0, (mk[3] - 0.22) / 0.45))
        // (OTH woods are open: clumps and gaps, the ground showing between; lone trees on the meadows — fewer pines:
        //  the user, "no need of that many pine trees")
        const clump = vn(x / 45 + 17, z / 45 - 9)
        // (broadleaf GROVES are dense — OTH ss2: crowns side by side — conifer stands open)
        const groveN = vn(x / 260 + 5, z / 260 - 3)
        // TIGHTNESS (the user: "no need of that many trees — put them near him, at the sides, near the river; I need to
        // feel the tightness like OTH"): the big stands thinner, and clumps where the player IS — round the spawn,
        // lining the tracks (5–26 m off them), along the river banks (14–45 m)
        const td = map.trackDist(x, z), rd = map.riverDist(x, z), sd = Math.hypot(x - sp.x, z - sp.z)
        const clumpS = vn(x / 28 - 3, z / 28 + 21)
        const bands = (td > hw + 3 && td < 26 ? 0.33 * (1 - (td - 5) / 21) : 0) + (rd > 14 && rd < 45 ? 0.34 : 0)
          + (sd < 300 ? 0.52 * (1 - sd / 300) : 0)
        // (a little denser everywhere — the user: "feel a bit denser, but not a lot")
        const p = forest * (0.058 + 0.25 * clump) * (groveN > 0.55 ? 2 : 1) + bands * Math.max(0, clumpS * 1.6 - 0.42)
          + 0.005 + 0.034 * Math.max(0, mk[3] - 0.08)
        const r = rnd()
        if (r > p) continue
        if (mk[2] > 0.75 || mk[0] > 0.45) continue // water / its banks, rock
        if (map.trailDist(x, z) < hw + 3) continue
        if ((x - sp.x) ** 2 + (z - sp.z) ** 2 < 16 * 16) continue
        const gi = Math.round((x - g.origin) / g.step), gj = Math.round((z - g.origin) / g.step)
        if (fp[gj * g.n + gi] > 40) continue // a boulder
        const y = map.height(x, z)
        const sl = Math.hypot(map.height(x + 3, z) - map.height(x - 3, z), map.height(x, z + 3) - map.height(x, z - 3)) / 6
        if (sl > 0.85) continue
        // conifer stands and broadleaf groves by a slow noise (about half each); in a grove birch / aspen / green
        // (by the river and round the spawn mostly broadleaf: birch and aspen line the water in OTH)
        // (and round the spawn a few PINE clumps among them — the user: "add some pines near")
        const pines = sd < 320 && vn(x / 55 + 31, z / 55 - 13) > 0.6
        const broad = !pines && groveN + (rnd() - 0.5) * 0.3 + (forest < 0.2 ? 0.25 : 0) + (rd < 45 ? 0.3 : 0) + (sd < 260 ? 0.15 : 0) > 0.55
        let species: number
        if (broad) {
          const k = vn(x / 120 - 7, z / 120 + 11) + (rnd() - 0.5) * 0.5
          species = k < 0.4 ? 3 : k < 0.86 ? 4 : 5 // (gold 40 %, red / orange 45 %, a few still green)
        } else {
          const larch = vn(x / 230, z / 230) + (rnd() - 0.5) * 0.45 > 0.6 ? 1 : 0
          species = rnd() < 0.05 ? 2 : pines && rnd() < 0.8 ? 0 : larch
        }
        const H = broad ? (7 + 8 * Math.pow(rnd(), 0.8)) * (0.85 + 0.15 * forest) : (6 + 15 * Math.pow(rnd(), 0.8)) * (0.75 + 0.25 * forest)
        out.push(x, y - 0.3, z, H, rnd() * Math.PI * 2, species, rnd(), rnd())
      }
    }
    return new Float32Array(out)
  }

  /** The nearest tree of `species` (−1 any) to (x, z) within r — the shot harness frames trees with it. */
  nearest(x: number, z: number, r: number, species = -1, minH = 0): { x: number; y: number; z: number; h: number } | null {
    let best = -1, bd = r * r
    for (let i = 0; i < this.count; i++) {
      const o = i * TREE_STRIDE
      if (species >= 0 && this.data[o + 5] !== species) continue
      if (this.data[o + 3] < minH) continue
      const d = (this.data[o] - x) ** 2 + (this.data[o + 2] - z) ** 2
      if (d < bd) { bd = d; best = o }
    }
    return best < 0 ? null : { x: this.data[best], y: this.data[best + 1], z: this.data[best + 2], h: this.data[best + 3] }
  }

  /** No tree crown within `clear` m of the segment (ax, az) → (bx, bz) (the shot harness). */
  clearLine(ax: number, az: number, bx: number, bz: number, clear: number): boolean {
    const d = this.data, vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz || 1
    for (let i = 0; i < this.count; i++) {
      const o = i * TREE_STRIDE, px = d[o] - ax, pz = d[o + 2] - az
      const t = Math.max(0, Math.min(1, (px * vx + pz * vz) / L2))
      if ((px - t * vx) ** 2 + (pz - t * vz) ** 2 < clear * clear) return false
    }
    return true
  }

  /** For the shot harness: the nearest tree of `species` ≥ minH tall to (x, z) that a camera `dist` × its height away
   *  (on the yaw side) sees in the open — no other tree's crown within 9 m of the camera or of the sight line. */
  clearShot(x: number, z: number, species: number, minH: number, dist: number, yaw: number): { x: number; y: number; z: number; h: number; cx: number; cz: number } | null {
    const d = this.data, c: number[] = []
    for (let i = 0; i < this.count; i++) {
      const o = i * TREE_STRIDE
      if ((species >= 0 && d[o + 5] !== species) || d[o + 3] < minH) continue
      c.push(o)
    }
    c.sort((a, b) => ((d[a] - x) ** 2 + (d[a + 2] - z) ** 2) - ((d[b] - x) ** 2 + (d[b + 2] - z) ** 2))
    for (const o of c.slice(0, 400)) {
      const D = d[o + 3] * dist, cx = d[o] + Math.sin(yaw) * D, cz = d[o + 2] + Math.cos(yaw) * D
      let blocked = false
      for (let i = 0; i < this.count && !blocked; i++) {
        const p = i * TREE_STRIDE
        if (p === o) continue
        const px = d[p] - cx, pz = d[p + 2] - cz
        if (px * px + pz * pz > (D + 20) ** 2) continue
        // distance from the segment camera → tree
        const ax = d[o] - cx, az = d[o + 2] - cz, L2 = ax * ax + az * az
        const t = Math.max(0, Math.min(1, (px * ax + pz * az) / L2))
        if ((px - t * ax) ** 2 + (pz - t * az) ** 2 < 9 * 9 && t < 0.92) blocked = true
      }
      if (!blocked) return { x: d[o], y: d[o + 1], z: d[o + 2], h: d[o + 3], cx, cz }
    }
    return null
  }

  /** Terrain occlusion (main.ts sets it): tiles behind the hills are skipped. */
  horizon: Horizon | null = null
  /** Tiles skipped as hidden at the last rebuild (the HUD). */
  occluded = 0

  update(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3): void {
    if (sunDir.angleTo(this.bakedSun) > 0.017) this.bakeShadows(sunDir)
    const dir = camera.getWorldDirection(new THREE.Vector3())
    if (camera.position.distanceToSquared(this.lastPos) < 16 && dir.dot(this.lastDir) > 0.9985) return
    this.lastPos.copy(camera.position)
    this.lastDir.copy(dir)
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.pv)
    const cx = camera.position.x, cz = camera.position.z, R = this.ranges
    const reach = R[3]
    for (const l of this.lods) l.n = 0
    this.occluded = 0
    const i0 = Math.floor((cx - reach) / TILE), i1 = Math.floor((cx + reach) / TILE), j0 = Math.floor((cz - reach) / TILE), j1 = Math.floor((cz + reach) / TILE)
    const d = this.data
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = this.key(i, j), list = this.tiles.get(k)
      if (!list) continue
      const x0 = i * TILE, z0 = j * TILE
      const nx = Math.max(x0 - cx, 0, cx - x0 - TILE), nz = Math.max(z0 - cz, 0, cz - z0 - TILE)
      if (nx * nx + nz * nz > reach * reach) continue
      this.box.min.set(x0 - 6, this.map.height(x0 + TILE / 2, z0 + TILE / 2) - 60, z0 - 6)
      this.box.max.set(x0 + TILE + 6, (this.tileMaxH.get(k) ?? 0) + 2, z0 + TILE + 6)
      if (!this.frustum.intersectsBox(this.box)) continue
      if (this.horizon?.hidden(x0 - 6, z0 - 6, x0 + TILE + 6, z0 + TILE + 6, this.box.max.y)) { this.occluded++; continue } // (behind a hill)
      for (const t of list) {
        const o = t * TREE_STRIDE
        const dx = d[o] - cx, dz = d[o + 2] - cz, dist = Math.sqrt(dx * dx + dz * dz)
        if (dist > reach) continue
        const lod = dist < R[0] ? 0 : dist < R[1] ? 1 : 2
        let grow = 1
        const slot = lod === 2 ? 4 : family(d[o + 5]) * 2 + lod
        if (lod === 2) {
          if (d[o + 5] === 2) continue // (no snag impostors: a bare trunk is a pixel there)
          // beyond treeFar the forest thins with distance (rank cull) and the survivors grow a little to keep its cover
          if (dist > R[2]) {
            const share = Math.pow(R[2] / dist, 0.85)
            if (d[o + 7] > share) continue
            grow = Math.min(1.45, Math.pow(1 / share, 0.35))
          }
        }
        const L = this.lods[slot]
        if (L.n >= L.max) continue
        const a = L.a0.array as Float32Array, b = L.a1.array as Float32Array, w = L.n * 4
        a[w] = d[o]; a[w + 1] = d[o + 1]; a[w + 2] = d[o + 2]; a[w + 3] = d[o + 3]
        b[w] = d[o + 4]; b[w + 1] = d[o + 5]; b[w + 2] = d[o + 6]; b[w + 3] = grow
        L.n++
      }
    }
    for (let l = 0; l < 5; l++) {
      const L = this.lods[l]
      L.geo.instanceCount = L.n
      L.a0.addUpdateRange(0, L.n * 4); L.a1.addUpdateRange(0, L.n * 4)
      L.a0.needsUpdate = L.a1.needsUpdate = true
      this.drawn[l] = L.n
    }
  }

  /**
   * Bake the IMPOSTOR atlas (once, at load): each species' near LOD from IMP.cols azimuths × IMP.elev heights, one
   * frame each, into two images at once (multiple render targets): albedo × AO (sqrt-encoded: dark greens keep their
   * steps in 8 bits) and the tree-space normal. Orthographic frames IMP.FW × IMP.FH tree heights, centred IMP.CY up.
   */
  bakeImpostors(renderer: THREE.WebGLRenderer): void {
    const W = IMP.cols * IMP.fw, Hh = IMP.rows * IMP.fh
    const rt = new THREE.WebGLRenderTarget(W, Hh, { count: 2, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter })
    for (const t of rt.textures) { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.colorSpace = THREE.NoColorSpace }
    const bake = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { uSpecies: { value: 0 }, uNoise: this.noiseU, uLeafTex: this.leafU }, vertexColors: true, vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.DoubleSide })
    const scene = new THREE.Scene(), geos = [spruceGeometry(0), broadleafGeometry(0)], mesh = new THREE.Mesh(geos[0], bake)
    scene.add(mesh)
    const cam = new THREE.OrthographicCamera(-IMP.FW / 2, IMP.FW / 2, IMP.FH / 2, -IMP.FH / 2, 0.01, 10)
    const prevRT = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha()
    const prevAuto = renderer.autoClear, prevTM = renderer.toneMapping
    renderer.autoClear = true
    renderer.toneMapping = THREE.NoToneMapping
    const center = new THREE.Vector3(0, IMP.CY, 0)
    // (each species' background: its sqrt-encoded mid colour, alpha 0 — the mipmaps and the alpha edge don't darken it)
    const clear = [[0.3, 0.44, 0.3], [0.8, 0.64, 0.28], [0, 0, 0], [0.88, 0.76, 0.3], [0.86, 0.45, 0.2], [0.38, 0.55, 0.26]]
    for (let ri = 0; ri < IMP_SPECIES.length; ri++) {
      const sp = IMP_SPECIES[ri]
      bake.uniforms.uSpecies.value = sp
      mesh.geometry = geos[family(sp)]
      renderer.setClearColor(new THREE.Color(...(clear[sp] as [number, number, number])), 0)
      for (let e = 0; e < IMP.elev.length; e++) {
        for (let a = 0; a < IMP.cols; a++) {
          const az = (a / IMP.cols) * Math.PI * 2, el = IMP.elev[e]
          cam.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(3).add(center)
          cam.up.set(0, 1, 0)
          cam.lookAt(center)
          cam.updateMatrixWorld()
          const row = ri * IMP.elev.length + e
          rt.viewport.set(a * IMP.fw, row * IMP.fh, IMP.fw, IMP.fh)
          rt.scissor.set(a * IMP.fw, row * IMP.fh, IMP.fw, IMP.fh)
          rt.scissorTest = true
          renderer.setRenderTarget(rt)
          renderer.render(scene, cam)
        }
      }
    }
    renderer.setRenderTarget(prevRT)
    renderer.setClearColor(prevClear, prevAlpha)
    renderer.autoClear = prevAuto
    renderer.toneMapping = prevTM
    for (const g of geos) g.dispose()
    bake.dispose()
    this.impMat.uniforms.uImpAlb.value = rt.textures[0]
    this.impMat.uniforms.uImpNor.value = rt.textures[1]
    this.group.children[4].visible = true
    this.atlas = rt
  }
  /** The impostor atlas (two textures: albedo, normal) — kept for the harness / a debug view. */
  atlas: THREE.WebGLRenderTarget | null = null

  /** Stamp every tree's soft shadow into the terrain shadow's tree texture (2 m grid over the box). */
  private bakeShadows(sun: THREE.Vector3): void {
    this.bakedSun.copy(sun)
    const tex = this.shadow.treeTex, n = tex.image.width, g = this.map.inner, step = g.step
    const px = tex.image.data as Uint8Array
    const lit = new Float32Array(n * n).fill(1)
    const hl = Math.hypot(sun.x, sun.z) || 1, ax = -sun.x / hl, az = -sun.z / hl // away from the sun
    const tanE = Math.max(0.12, sun.y / hl)
    const d = this.data
    for (let t = 0; t < this.count; t++) {
      const o = t * TREE_STRIDE
      if (d[o + 5] === 2) continue
      const H = d[o + 3], cr = CROWN * H
      const len = Math.min(34, (0.45 * H) / tanE)
      const cx = d[o] + ax * len * 0.75, cz = d[o + 2] + az * len * 0.75
      const la = len * 0.7 + cr, lc = cr * 0.95
      const ext = la + 2
      const i0 = Math.max(0, Math.floor((cx - ext - g.origin) / step)), i1 = Math.min(n - 1, Math.ceil((cx + ext - g.origin) / step))
      const j0 = Math.max(0, Math.floor((cz - ext - g.origin) / step)), j1 = Math.min(n - 1, Math.ceil((cz + ext - g.origin) / step))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const rx = g.origin + i * step - cx, rz = g.origin + j * step - cz
        const u = (rx * ax + rz * az) / la, v = (-rx * az + rz * ax) / lc
        const q = u * u + v * v
        if (q >= 1) continue
        const k = j * n + i
        lit[k] *= 1 - 0.6 * (1 - q) * (1 - q * 0.5)
      }
    }
    for (let k = 0; k < n * n; k++) px[k] = Math.round(lit[k] * 255)
    tex.needsUpdate = true
    this.shadow.uniforms.uTreeShOn.value = 1
  }
}

/** The impostor atlas layout: `cols` azimuths × 3 elevations (rad) × 2 species (rows), frames fw × fh px framing
 *  FW × FH tree heights centred CY up (the crown with its plumes, from the side to 55° above). */
const IMP = { cols: 12, elev: [0.05, 0.45, 0.95], rows: 15, fw: 80, fh: 160, FW: 0.56, FH: 1.08, CY: 0.52 }

/** A unit quad (x −0.5…0.5, y 0…1): the impostor's billboard. */
function impostorQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/** The species' colours (spruce, larch, snag trunk), a little different per tree (j = −0.5…0.5). */
const SPECIES_GLSL = /* glsl */ `
// a LEAF MASS's surface: small round leaves (the paint texture's cell channel, in the tree's own space: every tree of a
// species alike, its impostor too), each its own tone, dark gaps between them; p = object position, n = normal
vec3 leafMass(vec3 albedo, vec3 p, vec3 n) {
  // triplanar (no stretched stripes on the sides), 16 cells per 0.26 → a leaf ≈ 0.016 of the height
  vec3 w = pow(abs(n), vec3(4.0)); w /= w.x + w.y + w.z;
  vec3 q = p / 0.26;
  float f1 = texture(uNoise, q.zy).a * w.x + texture(uNoise, q.xz + 0.37).a * w.y + texture(uNoise, q.xy + 0.71).a * w.z;
  float tone = texture(uNoise, q.xz * 0.5 + q.y * 0.3).g;
  return albedo * mix(0.68, 1.08, smoothstep(0.6, 0.3, f1)) * (0.88 + 0.24 * tone);
}
// a CONIFER's needles (the user: "pine trees need feather-like leaves so they look natural"): fine strokes radiating
// out from the trunk along each skirt — light needle tips, dark gaps — in the tree's own space; p = object position
vec3 needles(vec3 albedo, vec3 p) {
  float ang = atan(p.z, p.x);
  float r = length(p.xz);
  vec2 uv = vec2(ang * 9.0, r * 22.0 + p.y * 4.0);
  float s1 = texture(uNoise, uv * vec2(1.0, 0.12)).b;
  float s2 = texture(uNoise, uv * vec2(2.3, 0.3) + 0.37).b;
  float f = 0.6 * s1 + 0.4 * s2;
  return albedo * mix(0.7, 1.16, smoothstep(0.32, 0.72, f));
}
// a leaf CARD's tint (0…1 per card): a little lighter / darker, one card in eight of a birch still yellow-green
vec3 leafTone(vec3 albedo, float tint, float species) {
  if (species < 2.5) return albedo;
  albedo *= 0.82 + 0.3 * fract(tint * 7.13);
  return tint > 0.88 && species < 3.5 ? mix(albedo, vec3(0.42, 0.5, 0.08), 0.6) : albedo;
}
vec3 treeAlbedo(float species, float fol, float j) {
  if (fol < 0.5) {
    if (species > 2.5) return vec3(0.7, 0.68, 0.62);          // birch / aspen: white bark
    return species > 1.5 ? vec3(0.16, 0.13, 0.11) : vec3(0.075, 0.05, 0.04);
  }
  // (calibrated on OTH: a muted olive-green spruce, a gold larch; ss2's aspens: gold, orange, red, a few still green)
  if (species < 0.5) return mix(vec3(0.045, 0.1, 0.05), vec3(0.15, 0.3, 0.14), 0.5 + j * 0.35);
  if (species < 1.5) return mix(vec3(0.6, 0.33, 0.04), vec3(0.95, 0.66, 0.12), 0.55 + j * 0.4);
  if (species < 3.5) return mix(vec3(0.62, 0.32, 0.02), vec3(0.9, 0.62, 0.06), 0.5 + j * 0.8);
  if (species < 4.5) return mix(vec3(0.42, 0.025, 0.02), vec3(0.85, 0.2, 0.025), 0.5 + j * 0.9);
  return mix(vec3(0.08, 0.2, 0.04), vec3(0.2, 0.34, 0.06), 0.5 + j * 0.8);
}
`

const VERT = /* glsl */ `
${ATMOS_GLSL}
${SPECIES_GLSL}
uniform vec4 uFarGrid;
${SHADOW_GLSL}
in vec4 aT0; // x, y, z, height
in vec4 aT1; // rotation, species, seed, grow
in vec3 leaf; // a broadleaf leaf's disc coordinates + its tint (0 0 0 elsewhere)
out vec3 vLeaf;
out float vFol;
out vec3 vObj;
out vec3 vObjN;
out vec3 vWorld;
out vec3 vN;
out vec3 vAlb;
out float vAo;
out float vSun;
out float vSpecies;
out float vH;

void main() {
  float H = aT0.w * aT1.w;
  float species = aT1.y;
  vec3 p = position;
  float fol = color.g;
  // a snag: the trunk alone (thicker), the foliage collapsed away
  if (species > 1.5 && species < 2.5) { p = fol > 0.5 ? vec3(0.0) : vec3(p.x * 1.6, p.y * 0.85, p.z * 1.6); }
  // a broadleaf's own crown: its base raised a little (0.31 → up to 0.4 of the height, the top kept) and its width
  // ×0.85–1.15, from the tree's seed (one geometry, every tree a different outline)
  if (species > 2.5 && leaf.z > 0.5) {
    float lift = 0.09 * fract(aT1.z * 5.31), wide = 0.85 + 0.3 * fract(aT1.z * 13.7);
    p.y = 0.97 - (0.97 - p.y) * (0.66 - lift) / 0.66;
    p.xz *= wide;
  }
  float c = cos(aT1.x), s = sin(aT1.x);
  vec3 q = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c) * H;
  vec3 n = normal;
  n = vec3(n.x * c - n.z * s, n.y, n.x * s + n.z * c);
  // wind: the crown sways, more toward the top
  float h01 = color.b;
  float sw = sin(uTime * 1.1 + aT1.z * 31.0) * 0.6 + sin(uTime * 2.3 + aT1.z * 17.0) * 0.25;
  q.xz += vec2(0.8, 0.35) * sw * 0.012 * H * h01 * h01;
  vWorld = aT0.xyz + q;
  vN = n;
  vLeaf = leaf;
  vFol = fol;
  vObj = position;
  vObjN = normal;
  vAo = color.r;
  vH = h01;
  vSpecies = species;
  // the species' colour, a little different per tree
  vAlb = treeAlbedo(species, fol, fract(aT1.z * 7.31) - 0.5);
  // the light where it stands: terrain + tree shadow at the root for the lower crown, open sky toward the top
  float rootSun = sunVisibility(aT0.xz);
  vSun = mix(rootSun, sunVisibilityTerrain(aT0.xz), smoothstep(0.25, 0.85, h01));
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
${SPECIES_GLSL}
${LEAF_GLSL}
in vec3 vLeaf;
in float vFol;
in vec3 vObj;
in vec3 vObjN;
in vec3 vWorld;
in vec3 vN;
in vec3 vAlb;
in float vAo;
in float vSun;
in float vSpecies;
in float vH;

void main() {
  vec3 N = normalize(vN);
  float under = gl_FrontFacing ? 1.0 : 0.62; // a frond's underside
  if (!gl_FrontFacing) N.y = -abs(N.y) * 0.4;
  vec3 V = normalize(uCamPos - vWorld);
  // tips light, the inside of the crown dark; the top of the tree a touch lighter
  // (a larch's needles are thin and let light through: its inside is less dark than a spruce's)
  float aoMin = vSpecies > 2.5 ? 0.3 : vSpecies > 0.5 ? 0.42 : 0.22; // (larch: thin needles let the light in)
  vec3 albedo = vAlb * mix(aoMin, 1.15, vAo) * under * (0.9 + 0.18 * vH);
  // broadleaf: each LEAF a round disc, its own tone, one in ten still yellow-green
  // a broadleaf LEAF CARD: tiny separate leaves, the gaps between them cut out (the sky shows through)
  float alpha = 1.0;
  if (vLeaf.z > 0.5) {
    vec4 lt = leafCard(vLeaf.xy, vLeaf.z);
#ifdef A2C
    alpha = clamp((lt.a - 0.35) / 0.3, 0.0, 1.0);
    if (alpha < 0.02) discard;
#else
    if (lt.a < 0.5) discard;
#endif
    albedo = leafTone(albedo, fract(vLeaf.z) / 0.9, vSpecies) * (0.55 + 0.6 * lt.r) * (0.62 + 0.38 * lt.g);
  }
  if (vSpecies < 2.5 && vFol > 0.95) {
    // the conifer's NEEDLE FRINGE: the outer edge of every tier cut into fine needles (a soft, feathery edge)
    float nd = fract(atan(vObj.z, vObj.x) * (150.0 / 6.2832) + vObj.y * 9.0);
    if (vLeaf.x > 0.62 && vLeaf.x > 1.0 - 0.3 * abs(nd - 0.5) * 2.0) discard;
    if (vSpecies < 1.5) albedo = needles(albedo, vObj);
  }
  vec3 c = shade(albedo, N, V, 0.85, 0.03, mix(0.55, 1.0, vAo), vSun, 0.3);
  c += headlight(albedo, N, vWorld);
  // back-lit by a low sun the needles glow (the larch most)
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  c += albedo * uSunColor * back * (vSpecies > 0.5 ? 0.55 : 0.25) * vAo * vSun;
  gl_FragColor = vec4(applyAtmos(c, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

// IMPOSTOR BAKE: the near LOD, unlit — albedo × AO (sqrt-encoded) and the tree-space normal, two targets at once.
const BAKE_VERT = /* glsl */ `
uniform sampler2D uNoise;
${SPECIES_GLSL}
uniform float uSpecies;
in vec3 leaf;
out vec3 vLeaf;
out float vFol;
out vec3 vP;
out vec3 vN;
out vec3 vAlb;
out float vAo;
out float vH;
void main() {
  vN = normal;
  vP = position;
  vLeaf = leaf;
  vFol = color.g;
  vAo = color.r;
  vH = color.b;
  vAlb = treeAlbedo(uSpecies, color.g, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const BAKE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
${SPECIES_GLSL}
${LEAF_GLSL}
uniform float uSpecies;
layout(location = 0) out highp vec4 gAlbedo;
layout(location = 1) out highp vec4 gNormal;
in vec3 vLeaf;
in float vFol;
in vec3 vP;
in vec3 vN;
in vec3 vAlb;
in float vAo;
in float vH;
void main() {
  vec3 N = normalize(vN);
  float under = gl_FrontFacing ? 1.0 : 0.62;
  if (!gl_FrontFacing) N.y = -abs(N.y) * 0.4;
  vec3 albedo = vAlb * mix(uSpecies > 0.5 ? 0.42 : 0.22, 1.15, vAo) * under * (0.9 + 0.18 * vH);
  if (vLeaf.z > 0.5) {
    vec4 lt = leafCard(vLeaf.xy, vLeaf.z);
    if (lt.a < 0.5) discard;
    albedo = leafTone(albedo, fract(vLeaf.z) / 0.9, uSpecies) * (0.55 + 0.6 * lt.r) * (0.62 + 0.38 * lt.g);
  }
  if (uSpecies < 2.5 && vFol > 0.95) {
    float nd = fract(atan(vP.z, vP.x) * (150.0 / 6.2832) + vP.y * 9.0);
    if (vLeaf.x > 0.62 && vLeaf.x > 1.0 - 0.3 * abs(nd - 0.5) * 2.0) discard;
    if (uSpecies < 1.5) albedo = needles(albedo, vP);
  }
  gAlbedo = vec4(sqrt(clamp(albedo, 0.0, 1.0)), 1.0);
  gNormal = vec4(normalize(N) * 0.5 + 0.5, vAo);
}
`

// IMPOSTOR: a camera-facing quad showing the baked view nearest this tree's own (its rotation and the camera's
// direction from it), relit with the sun from the baked normal.
const IMP_VERT = /* glsl */ `
${ATMOS_GLSL}
uniform vec4 uFarGrid;
${SHADOW_GLSL}
in vec4 aT0; // x, y, z, height
in vec4 aT1; // rotation, species, seed, grow
out vec2 vUv;
out vec3 vWorld;
out float vSun;
out float vRot;
out float vSpecies;
out float vTint;
void main() {
  float H = aT0.w * aT1.w;
  vec3 center = aT0.xyz + vec3(0.0, IMP_CY * H, 0.0);
  vec3 toCam = normalize(uCamPos - center);
  float c = cos(aT1.x), s = sin(aT1.x);
  vec3 dl = vec3(toCam.x * c + toCam.z * s, toCam.y, -toCam.x * s + toCam.z * c); // into the tree's own frame
  float az = atan(dl.x, dl.z);
  if (az < 0.0) az += 6.2831853;
  float ia = mod(floor(az / 6.2831853 * IMP_NA + 0.5), IMP_NA);
  float el = asin(clamp(dl.y, -1.0, 1.0));
  float ie = el < IMP_E1 ? 0.0 : el < IMP_E2 ? 1.0 : 2.0;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 upv = cross(toCam, right);
  vec3 p = center + right * (position.x * IMP_FW * H) + upv * ((position.y - 0.5) * IMP_FH * H);
  float row = (aT1.y < 1.5 ? aT1.y : aT1.y - 1.0) * 3.0 + ie; // (IMP_SPECIES order: 0 1 3 4 5)
  vUv = vec2((ia + position.x + 0.5) / IMP_NA, (row + position.y) / IMP_ROWS);
  vWorld = p;
  vRot = aT1.x;
  vSpecies = aT1.y;
  vTint = 0.92 + 0.16 * fract(aT1.z * 7.31);
  vSun = mix(sunVisibility(aT0.xz), sunVisibilityTerrain(aT0.xz), position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`
const IMP_FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
uniform sampler2D uImpAlb;
uniform sampler2D uImpNor;
uniform vec2 uImpSize;
in vec2 vUv;
in vec3 vWorld;
in float vSun;
in float vRot;
in float vSpecies;
in float vTint;
void main() {
  vec4 a = texture(uImpAlb, vUv);
  // alpha test, corrected by the mip level (mips average the alpha down: far trees would thin out and shimmer)
  vec2 px = vUv * uImpSize;
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px)))));
  float alpha = clamp((a.a * (1.0 + 0.45 * lod) - 0.35) / 0.3, 0.0, 1.0);
  if (alpha < 0.02) discard;
  vec4 nn = texture(uImpNor, vUv);
  vec3 n = normalize(nn.rgb * 2.0 - 1.0);
  float c = cos(vRot), s = sin(vRot);
  vec3 N = normalize(vec3(n.x * c - n.z * s, n.y, n.x * s + n.z * c));
  vec3 V = normalize(uCamPos - vWorld);
  // (the edge texels mix in the background's meaningless normal: lean them to the crown's silhouette normal —
  //  toward the camera and up — so the outline never darkens)
  N = normalize(mix(normalize(V + vec3(0.0, 1.0, 0.0)), N, smoothstep(0.5, 0.95, a.a)));
  vec3 albedo = a.rgb * a.rgb * vTint;
  vec3 col = shade(albedo, N, V, 0.85, 0.03, mix(0.55, 1.0, nn.a), vSun, 0.3);
  col += headlight(albedo, N, vWorld);
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  col += albedo * uSunColor * back * (vSpecies > 0.5 ? 0.55 : 0.25) * nn.a * vSun;
  gl_FragColor = vec4(applyAtmos(col, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
