import * as THREE from 'three'
import type { Horizon } from './Horizon'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { Tier } from './quality'
import type { Rocks } from './Rocks'
import { LEAF_GLSL } from './leafTexture'
import { SHADOW_GLSL, type TerrainShadow } from './TerrainShadow'

/**
 * BUSHES — Over-the-Hill shrubs, built like the broadleaf crowns (the user: "make the bushes the same way as the
 * leaves"): a few low clumps of LEAF CARDS showing tiny separate leaves with gaps between them (leafTexture.ts),
 * a dark woody core, soft-shaded as one round volume, dark at the foot. Green shrubs,
 * dark junipers and a few autumn-red bushes, scattered over the slopes and meadows — thicker in the green hollows and
 * along the forest edges, never on a track, in water or on rock. Placed once (deterministic, a jittered 9 m grid).
 *
 * 2 LODs (one instanced draw each): 5 clumps × 6 cards near (`tier.bushNear`, 128 vertices), 3 × 3 bigger cards to
 * `tier.bushReach` (40); beyond, the ground's painted shrub dots take over.
 */
const TILE = 64
const STRIDE = 7 // x, y, z, size, rotation, kind, seed

export class Bushes {
  readonly group = new THREE.Group()
  readonly data: Float32Array
  readonly count: number
  private readonly tiles = new Map<number, number[]>()
  private readonly lods: { geo: THREE.InstancedBufferGeometry; a0: THREE.InstancedBufferAttribute; a1: THREE.InstancedBufferAttribute; max: number; n: number }[] = []
  private readonly frustum = new THREE.Frustum()
  private readonly pv = new THREE.Matrix4()
  private readonly box = new THREE.Box3()
  private readonly lastPos = new THREE.Vector3(1e9, 0, 0)
  private readonly lastDir = new THREE.Vector3()
  private readonly near: number
  private readonly reach: number
  drawn = [0, 0]

  constructor(private readonly map: MapData, atmos: Atmosphere, shadow: TerrainShadow, tier: Tier, rocks: Rocks, leafTex: THREE.Texture) {
    this.near = tier.bushNear
    this.reach = tier.bushReach
    this.data = this.place(rocks)
    this.count = this.data.length / STRIDE
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE, k = this.key(Math.floor(this.data[o] / TILE), Math.floor(this.data[o + 2] / TILE))
      let l = this.tiles.get(k)
      if (!l) this.tiles.set(k, (l = []))
      l.push(i)
    }
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...atmos.uniforms, ...shadow.uniforms, uFarGrid: { value: new THREE.Vector4(map.far.n, map.far.step, map.far.origin, 0) }, uLeafTex: { value: leafTex } },
      defines: { ...(tier.spec ? { OTH_SPEC: '' } : {}), ...(tier.msaa ? { A2C: '' } : {}) },
      vertexColors: true,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      alphaToCoverage: tier.msaa,
    })
    for (let l = 0; l < 2; l++) {
      const r0 = l ? this.near : 0, r1 = l ? this.reach : this.near
      const max = Math.min(30000, Math.ceil(Math.PI * (r1 * r1 - r0 * r0) / 40 * 0.6) + 64)
      const src = bushGeometry(l)
      const geo = new THREE.InstancedBufferGeometry()
      for (const n of ['position', 'normal', 'color', 'leaf']) geo.setAttribute(n, src.getAttribute(n))
      geo.setIndex(src.getIndex())
      const a0 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4), a1 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
      a0.setUsage(THREE.DynamicDrawUsage); a1.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aB0', a0); geo.setAttribute('aB1', a1)
      geo.instanceCount = 0
      const mesh = new THREE.Mesh(geo, mat)
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      this.group.add(mesh)
      this.lods.push({ geo, a0, a1, max, n: 0 })
    }
  }

  private key(i: number, j: number): number { return (i + 512) * 1024 + (j + 512) }

  private place(rocks: Rocks): Float32Array {
    const map = this.map, out: number[] = []
    const G = 9, half = map.half - 50
    let s = 0x1b873593
    const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
    const mk: [number, number, number, number] = [0, 0, 0, 0]
    const hw = map.meta.trails.hw, fp = rocks.footprint.image.data as Uint8Array, g = map.inner
    for (let gz = -half; gz < half; gz += G) {
      for (let gx = -half; gx < half; gx += G) {
        const x = gx + rnd() * G, z = gz + rnd() * G
        map.maskAt(x, z, mk)
        if (mk[2] > 0.8 || mk[0] > 0.4) continue
        const edge = Math.max(0, 1 - Math.abs(mk[3] - 0.3) / 0.25) // the forest's edge
        const green = 1 - Math.min(1, mk[1] / 0.6)
        // (+ thick along the river banks, lining the tracks and round the spawn — the user: "bushes near the river, near
        //  the trees")
        const td = map.trackDist(x, z), rd = map.riverDist(x, z), sd = Math.hypot(x - map.meta.spawn.x, z - map.meta.spawn.z)
        const p = 0.05 + 0.18 * green + 0.3 * edge + 0.12 * Math.min(1, mk[2] / 0.6) - 0.15 * Math.max(0, mk[3] - 0.6)
          + (rd > 11 && rd < 34 ? 0.45 : 0) + (td > hw + 1.5 && td < 12 ? 0.3 : 0) + (sd > 12 && sd < 150 ? 0.25 : 0)
        if (rnd() > p) continue
        if (map.trailDist(x, z) < hw + 1.2) continue
        const gi = Math.round((x - g.origin) / g.step), gj = Math.round((z - g.origin) / g.step)
        if (fp[gj * g.n + gi] > 60) continue
        const size = 0.7 + 1.4 * Math.pow(rnd(), 1.6)
        const r = rnd(), kind = r < 0.06 ? 2 : r < 0.3 ? 1 : 0
        out.push(x, map.height(x, z) - 0.12 * size, z, size, rnd() * Math.PI * 2, kind, rnd())
      }
    }
    return new Float32Array(out)
  }

  /** Terrain occlusion (main.ts sets it): tiles behind the hills are skipped. */
  horizon: Horizon | null = null
  private readonly tileTop = new Map<number, number>()

  update(camera: THREE.PerspectiveCamera): void {
    const dir = camera.getWorldDirection(new THREE.Vector3())
    if (camera.position.distanceToSquared(this.lastPos) < 9 && dir.dot(this.lastDir) > 0.999) return
    this.lastPos.copy(camera.position); this.lastDir.copy(dir)
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.pv)
    const cx = camera.position.x, cz = camera.position.z, R = this.reach, d = this.data
    for (const l of this.lods) l.n = 0
    const i0 = Math.floor((cx - R) / TILE), i1 = Math.floor((cx + R) / TILE), j0 = Math.floor((cz - R) / TILE), j1 = Math.floor((cz + R) / TILE)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const list = this.tiles.get(this.key(i, j))
      if (!list) continue
      const x0 = i * TILE, z0 = j * TILE, hc = this.map.height(x0 + TILE / 2, z0 + TILE / 2)
      this.box.min.set(x0 - 2, hc - 60, z0 - 2)
      this.box.max.set(x0 + TILE + 2, hc + 60, z0 + TILE + 2)
      if (!this.frustum.intersectsBox(this.box)) continue
      if (this.horizon) {
        let top = this.tileTop.get(this.key(i, j))
        if (top === undefined) { top = -1e9; for (const b of list) top = Math.max(top, d[b * STRIDE + 1] + d[b * STRIDE + 3] * 1.2); this.tileTop.set(this.key(i, j), top) }
        if (this.horizon.hidden(x0 - 2, z0 - 2, x0 + TILE + 2, z0 + TILE + 2, top)) continue // (behind a hill)
      }
      for (const b of list) {
        const o = b * STRIDE, dx = d[o] - cx, dz = d[o + 2] - cz, dist2 = dx * dx + dz * dz
        if (dist2 > R * R) continue
        const L = this.lods[dist2 < this.near * this.near ? 0 : 1]
        if (L.n >= L.max) continue
        const a = L.a0.array as Float32Array, c = L.a1.array as Float32Array, w = L.n * 4
        a[w] = d[o]; a[w + 1] = d[o + 1]; a[w + 2] = d[o + 2]; a[w + 3] = d[o + 3]
        c[w] = d[o + 4]; c[w + 1] = d[o + 5]; c[w + 2] = d[o + 6]; c[w + 3] = Math.sqrt(dist2) / R
        L.n++
      }
    }
    for (let l = 0; l < 2; l++) {
      const L = this.lods[l]
      L.geo.instanceCount = L.n
      L.a0.addUpdateRange(0, L.n * 4); L.a1.addUpdateRange(0, L.n * 4)
      L.a0.needsUpdate = L.a1.needsUpdate = true
      this.drawn[l] = L.n
    }
  }
}

/** A bush (unit size ≈ 1 m across, the base at y 0): low clumps of leaf cards round a dark woody core.
 *  Attributes: position, normal (the bush's soft volume), color (r AO, g 1, b height), leaf (card u v, 1 + tile + tint). */
function bushGeometry(lod: number): THREE.BufferGeometry {
  let s = 0x2468ace + lod * 97
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296)
  const clumps = lod === 0
    ? [[0, 0.42, 0, 0.3], [0.26, 0.3, 0.12, 0.24], [-0.24, 0.28, 0.14, 0.23], [0.04, 0.3, -0.27, 0.24], [-0.06, 0.62, -0.04, 0.22]]
    : [[0, 0.38, 0, 0.36], [0.22, 0.3, -0.1, 0.3], [-0.2, 0.32, 0.12, 0.3]]
  const per = lod === 0 ? 6 : 3
  const pos: number[] = [], nor: number[] = [], col: number[] = [], leaf: number[] = [], idx: number[] = []
  const centre = new THREE.Vector3(0, 0.3, 0)
  const uu = new THREE.Vector3(), vv = new THREE.Vector3(), tmp = new THREE.Vector3()
  for (const [bx, by, bz, br] of clumps) {
    const cc = new THREE.Vector3(bx, by, bz)
    for (let k = 0; k < per; k++) {
      const zz = 1 - (2 * (k + 0.5)) / per, rr = Math.sqrt(1 - zz * zz), ph = k * 2.39996 + rnd()
      const d = new THREE.Vector3(Math.cos(ph) * rr, zz * 0.8 + 0.2, Math.sin(ph) * rr).normalize()
      const c = cc.clone().addScaledVector(d, br * (0.35 + 0.25 * rnd()))
      const n = d.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.8)).normalize()
      if (Math.abs(n.y) > 0.62) { n.y = Math.sign(n.y) * 0.62; const l = Math.hypot(n.x, n.z) || 1; n.x *= 0.785 / l; n.z *= 0.785 / l }
      uu.crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize()
      vv.crossVectors(n, uu)
      const sp = rnd() * Math.PI * 2, cu = Math.cos(sp), su = Math.sin(sp)
      const a1 = uu.clone().multiplyScalar(cu).addScaledVector(vv, su), a2 = uu.clone().multiplyScalar(-su).addScaledVector(vv, cu)
      const h = br * (lod === 0 ? 1.0 : 1.15) * (0.85 + 0.3 * rnd())
      const o = new THREE.Vector3().subVectors(c, centre).normalize()
      const sn = o.clone().multiplyScalar(0.75).addScaledVector(n, 0.25).normalize()
      const ao = Math.min(1.1, (0.55 + 0.45 * Math.max(0, d.dot(o))) * (0.7 + 0.5 * Math.min(1, c.y / 0.6)))
      const lz = 1 + Math.floor(rnd() * 4) + rnd() * 0.9
      const base = pos.length / 3
      for (const [ua, vb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        tmp.copy(c).addScaledVector(a1, ua * h).addScaledVector(a2, vb * h)
        pos.push(tmp.x, Math.max(-0.05, tmp.y), tmp.z); nor.push(sn.x, sn.y, sn.z); col.push(ao, 1, Math.min(1, Math.max(0, tmp.y))); leaf.push(ua, vb, lz)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('leaf', new THREE.Float32BufferAttribute(leaf, 3))
  g.setIndex(idx)
  return g
}

const VERT = /* glsl */ `
${ATMOS_GLSL}
uniform vec4 uFarGrid;
${SHADOW_GLSL}
in vec4 aB0; // x, y, z, size
in vec4 aB1; // rotation, kind, seed, distance share
in vec3 leaf;
out vec3 vLeaf;
out vec3 vWorld;
out vec3 vN;
out vec3 vAlb;
out float vAo;
out float vSun;
void main() {
  float c = cos(aB1.x), s = sin(aB1.x), S = aB0.w;
  vec3 p = position;
  // (a touch wider than tall, each bush its own proportions)
  p.xz *= 1.0 + 0.25 * fract(aB1.z * 3.7);
  vec3 q = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c) * S;
  q.xz += vec2(0.8, 0.35) * sin(uTime * 1.7 + aB1.z * 40.0) * 0.03 * S * color.b;
  vWorld = aB0.xyz + q;
  vLeaf = leaf;
  vN = vec3(normal.x * c - normal.z * s, normal.y, normal.x * s + normal.z * c);
  vAo = color.r;
  float j = fract(aB1.z * 9.13) - 0.5;
  vec3 green = mix(vec3(0.035, 0.1, 0.03), vec3(0.12, 0.26, 0.06), 0.55 + j * 0.4);
  vec3 juniper = mix(vec3(0.02, 0.05, 0.03), vec3(0.06, 0.14, 0.07), 0.55 + j * 0.4);
  vec3 autumn = mix(vec3(0.35, 0.08, 0.02), vec3(0.7, 0.2, 0.04), 0.55 + j * 0.4);
  vAlb = aB1.y > 1.5 ? autumn : aB1.y > 0.5 ? juniper : green;
  vSun = sunVisibility(aB0.xz);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
${LEAF_GLSL}
in vec3 vLeaf;
in vec3 vWorld;
in vec3 vN;
in vec3 vAlb;
in float vAo;
in float vSun;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vWorld);
  // tiny separate leaves, the gaps cut out
  vec4 lt = leafCard(vLeaf.xy, vLeaf.z);
  float alpha = 1.0;
#ifdef A2C
  alpha = clamp((lt.a - 0.35) / 0.3, 0.0, 1.0);
  if (alpha < 0.02) discard;
#else
  if (lt.a < 0.5) discard;
#endif
  vec3 albedo = vAlb * mix(0.35, 1.1, vAo) * (0.55 + 0.6 * lt.r) * (0.62 + 0.38 * lt.g) * (0.85 + 0.3 * fract(vLeaf.z));
  vec3 c = shade(albedo, N, V, 0.9, 0.03, mix(0.5, 1.0, vAo), vSun, 0.45);
  c += headlight(albedo, N, vWorld);
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  c += albedo * uSunColor * back * 0.3 * vAo * vSun;
  gl_FragColor = vec4(applyAtmos(c, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
