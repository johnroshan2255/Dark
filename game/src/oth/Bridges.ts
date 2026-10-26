import * as THREE from 'three'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { Bridge, MapData } from './MapData'
import type { Tier } from './quality'
import { SHADOW_GLSL, type TerrainShadow } from './TerrainShadow'

/**
 * BRIDGES — Over-the-Hill plank bridges where the tracks cross the river (scripts/oth/terrain.py places them, the
 * track ramps up to each deck): weathered PLANKS laid across three long STRINGERS, each plank its own length, tone and
 * a slight skew; log POSTS standing in the water every ~6 m with a cap beam across, a low CURB log along each edge and
 * a log RAIL on the posts. All the bridges are one merged mesh (one draw, ~10 k vertices), flat-shaded wood in this
 * world's light (the terrain's baked sun shadow, the headlights). The physics (Physics.ts) gives each a deck, curbs
 * and rails to drive on.
 */
export class Bridges {
  readonly group = new THREE.Group()

  constructor(map: MapData, atmos: Atmosphere, shadow: TerrainShadow, tier: Tier, farGrid: THREE.Vector4) {
    const list = map.meta.bridges ?? []
    if (!list.length) return
    const b = new Builder(0x1b0a7d)
    for (const br of list) b.bridge(br, map)
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...atmos.uniforms, ...shadow.uniforms, uFarGrid: { value: farGrid } },
      defines: tier.spec ? { OTH_SPEC: '' } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
    })
    const mesh = new THREE.Mesh(b.geometry(), mat)
    this.group.add(mesh)
  }
}

/** Collects boxes and logs (flat normals, a colour each) into one geometry. */
class Builder {
  private readonly pos: number[] = []
  private readonly nor: number[] = []
  private readonly col: number[] = []
  private readonly idx: number[] = []
  private s: number

  constructor(seed: number) { this.s = seed >>> 0 }

  rnd(): number {
    this.s = (Math.imul(this.s ^ (this.s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0
    return this.s / 4294967296
  }

  /** Weathered wood: warm brown, some planks greyer, every piece its own tone. */
  wood(dark = 1): [number, number, number] {
    const k = (0.82 + 0.36 * this.rnd()) * dark, grey = this.rnd() * 0.45
    const r = 0.34 * (1 - grey) + 0.29 * grey, g = 0.235 * (1 - grey) + 0.255 * grey, b = 0.15 * (1 - grey) + 0.215 * grey
    return [r * k, g * k, b * k]
  }

  /** A box: centre c, unit axes u (half size hu), v (hv), w (hw). */
  box(c: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, w: THREE.Vector3, hu: number, hv: number, hw: number, color: [number, number, number]): void {
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3, number, number, number][] = [
      [u, v, w, hu, hv, hw], [u.clone().negate(), w, v, hu, hw, hv],
      [v, w, u, hv, hw, hu], [v.clone().negate(), u, w, hv, hu, hw],
      [w, u, v, hw, hu, hv], [w.clone().negate(), v, u, hw, hv, hu],
    ]
    for (const [n, a, bb, hn, ha, hb] of faces) {
      const base = this.pos.length / 3
      const fc = c.clone().addScaledVector(n, hn)
      for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = fc.clone().addScaledVector(a, sa * ha).addScaledVector(bb, sb * hb)
        this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.col.push(...color)
      }
      // (wound to face n: a × b = n for the first face; the rest are built the same way)
      const cross = new THREE.Vector3().crossVectors(a, bb).dot(n) > 0
      if (cross) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
  }

  /** A log from a to b, radius r, 6 sides, flat-shaded, capped. */
  log(a: THREE.Vector3, b: THREE.Vector3, r: number, color: [number, number, number]): void {
    const axis = new THREE.Vector3().subVectors(b, a).normalize()
    const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize()
    const w = new THREE.Vector3().crossVectors(axis, u)
    const S = 6
    const ring = (c: THREE.Vector3, k: number) => {
      const t = ((k % S) / S) * Math.PI * 2 + 0.3
      return c.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(w, Math.sin(t) * r)
    }
    for (let k = 0; k < S; k++) {
      const p0 = ring(a, k), p1 = ring(a, k + 1), p2 = ring(b, k + 1), p3 = ring(b, k)
      const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p3, p0)).normalize()
      const base = this.pos.length / 3
      const shade = 0.92 + 0.12 * this.rnd()
      for (const p of [p0, p1, p2, p3]) { this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.col.push(color[0] * shade, color[1] * shade, color[2] * shade) }
      // (outward: flip if the normal points at the axis)
      const mid = new THREE.Vector3().addVectors(p0, p2).multiplyScalar(0.5)
      const toAxis = new THREE.Vector3().subVectors(a, mid).addScaledVector(axis, -new THREE.Vector3().subVectors(a, mid).dot(axis))
      if (n.dot(toAxis) > 0) { for (let q = 0; q < 4; q++) { const o = (base + q) * 3; this.nor[o] *= -1; this.nor[o + 1] *= -1; this.nor[o + 2] *= -1 } this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2) }
      else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    // end caps (a lighter cut face)
    for (const [c, s] of [[a, -1], [b, 1]] as const) {
      const n = axis.clone().multiplyScalar(s), base = this.pos.length / 3
      this.pos.push(c.x, c.y, c.z); this.nor.push(n.x, n.y, n.z); this.col.push(color[0] * 1.35, color[1] * 1.3, color[2] * 1.2)
      for (let k = 0; k < S; k++) { const p = ring(c, k); this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.col.push(color[0] * 1.35, color[1] * 1.3, color[2] * 1.2) }
      for (let k = 0; k < S; k++) {
        const i1 = base + 1 + k, i2 = base + 1 + ((k + 1) % S)
        if (s > 0) this.idx.push(base, i1, i2); else this.idx.push(base, i2, i1)
      }
    }
  }

  bridge(br: Bridge, map: MapData): void {
    const a = new THREE.Vector3(br.x0, br.y, br.z0), b = new THREE.Vector3(br.x1, br.y, br.z1)
    const L = a.distanceTo(b), along = new THREE.Vector3().subVectors(b, a).normalize()
    const up = new THREE.Vector3(0, 1, 0), across = new THREE.Vector3().crossVectors(up, along).normalize()
    const half = br.w / 2
    // PLANKS: across the bridge, ~0.26 m wide with a thin gap, each a little longer / shorter, skewed, its own tone
    const P = 0.29, n = Math.floor((L + 0.6) / P)
    for (let i = 0; i < n; i++) {
      const t = -0.3 + (i + 0.5) * ((L + 0.6) / n)
      const skew = (this.rnd() - 0.5) * 0.05
      const ax = across.clone().applyAxisAngle(up, skew), al = along.clone().applyAxisAngle(up, skew)
      const c = a.clone().addScaledVector(along, t).addScaledVector(across, (this.rnd() - 0.5) * 0.14)
      c.y += -0.055 + (this.rnd() - 0.5) * 0.025
      this.box(c, ax, up, al, half + (this.rnd() - 0.5) * 0.22, 0.055, 0.125, this.wood())
    }
    // STRINGERS under the planks
    for (const o of [-half + 0.45, 0, half - 0.45]) {
      const c = a.clone().addScaledVector(along, L / 2).addScaledVector(across, o)
      c.y -= 0.11 + 0.14
      this.box(c, across, up, along, 0.13, 0.14, L / 2 + 0.4, this.wood(0.75))
    }
    // POSTS every ~6 m (and at both ends), a cap beam across each pair; the RAIL logs on top, a CURB log each edge
    const k = Math.max(2, Math.round(L / 6) + 1)
    for (let i = 0; i < k; i++) {
      const t = (i / (k - 1)) * L
      const c = a.clone().addScaledVector(along, t)
      for (const sd of [-1, 1]) {
        const p = c.clone().addScaledVector(across, sd * (half + 0.18))
        const ground = map.height(p.x, p.z)
        this.log(new THREE.Vector3(p.x, Math.min(ground, br.y - 1) - 0.6, p.z), new THREE.Vector3(p.x, br.y + 0.95, p.z), 0.15, this.wood(0.8))
      }
      const cap = c.clone(); cap.y -= 0.11 + 0.28 + 0.13
      this.box(cap, across, up, along, half + 0.35, 0.13, 0.16, this.wood(0.7))
    }
    for (const sd of [-1, 1]) {
      const e0 = a.clone().addScaledVector(across, sd * (half + 0.18)), e1 = b.clone().addScaledVector(across, sd * (half + 0.18))
      this.log(e0.clone().setY(br.y + 0.82), e1.clone().setY(br.y + 0.82), 0.1, this.wood(0.9))
      const c0 = a.clone().addScaledVector(across, sd * (half - 0.14)).addScaledVector(along, -0.2), c1 = b.clone().addScaledVector(across, sd * (half - 0.14)).addScaledVector(along, 0.2)
      this.log(c0.setY(br.y + 0.1), c1.setY(br.y + 0.1), 0.12, this.wood(0.85))
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}

const VERT = /* glsl */ `
in vec3 color;
out vec3 vWorld;
out vec3 vN;
out vec3 vCol;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vCol = color;
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
in vec3 vCol;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vWorld);
  // the grain: soft streaks along the wood (the paint noise, stretched)
  float grain = texture(uNoise, vec2(dot(vWorld.xz, vec2(0.7, 0.7)) * 0.9, vWorld.y * 0.6 + dot(vWorld.xz, vec2(-0.7, 0.7)) * 0.08)).b;
  vec3 albedo = vCol * (0.86 + 0.28 * grain);
  float sun = sunVisibility(vWorld.xz);
  vec3 c = shade(albedo, N, V, 0.85, 0.03, 1.0, sun, 0.2);
  c += headlight(albedo, N, vWorld);
  gl_FragColor = vec4(applyAtmos(c, vWorld), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
