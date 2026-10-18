import * as THREE from 'three'
import { CHUNK_SIZE } from '../../world/constants'
import { TREE_STRIDE } from '../../world/types'
import type { WorldManager } from '../../world/WorldManager'
import { treeBox } from '../impostors/Impostors'
import { globalUniforms } from '../shaders/uniforms'

/**
 * IMAGE TREE SHADOWS (the LOW, MEDIUM and HIGH shadow levels — phones, iGPU laptops): no sun shadow map; tree shade comes from IMAGES (a dappled crown
 * texture + the trunk), the standard mobile fake (three.js manual "fake shadows"; blob / decal shadows —
 * skills/shadows), drawn into a top-down SHADE MAP instead of onto the ground, so everything standing under a tree
 * is shaded, not just the soil under the grass:
 *
 *  1. every tree within RADIUS of the player → one quad (≤ MAX, one instanced draw) placed in the vertex shader
 *     AWAY FROM THE SUN: the crown's shade lands crown-height / tan(elevation) off the trunk, stretched
 *     1 / sin(elevation) along the light (clamped for a low sun); the trunk's shade joins it;
 *  2. the quads are rendered top-down into a SIZE² R8-in-RGBA target covering 2·RADIUS m round the player, MAX-blended
 *     (overlapping crowns never go darker than one) — only after the player moved REBUILD m or the sun turned;
 *  3. the ground, grass, rocks and the player (stylize `treeShade`) read it at their world xz and dim their DIRECT
 *     light by it × strength (the sun's brightness: faint moonlight, dim overcast, none in a cave) — like a real
 *     shadow: the sky fill stays.
 * Not shaded: the trees themselves (their own baked shading), the car. Cost: 1 offscreen draw of ≤ 700 quads every few
 * seconds (~0.05 ms), 1 texture fetch per receiving fragment, 4 MB (1024²); CPU ~0.1 ms per rebuild.
 */
const RADIUS = 72
const SIZE = 1024
const MAX = 700
const REBUILD = 4

/** The dappled crown image: ~70 soft leaf clusters in a disc, light through the gaps (1 = full shade). */
function dappleTexture(): THREE.DataTexture {
  const S = 128
  const a = new Float32Array(S * S)
  let seed = 12345
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
  for (let k = 0; k < 70; k++) {
    const r = Math.sqrt(rnd()) * 0.82, t = rnd() * Math.PI * 2
    const cx = 0.5 + Math.cos(t) * r * 0.5, cy = 0.5 + Math.sin(t) * r * 0.5, rad = 0.05 + 0.07 * rnd()
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x / S - cx, y / S - cy) / rad
        if (d < 1) a[y * S + x] = Math.max(a[y * S + x], 1 - d * d)
      }
    }
  }
  const data = new Uint8Array(S * S * 4)
  for (let i = 0; i < S * S; i++) {
    const x = (i % S) / S - 0.5, y = Math.floor(i / S) / S - 0.5
    const edge = Math.max(0, 1 - Math.hypot(x, y) * 2) // the crown's round outline
    const v = Math.round(Math.min(1, a[i] * 1.6) * Math.min(1, edge * 3) * 255)
    data.set([v, v, v, 255], i * 4)
  }
  const tex = new THREE.DataTexture(data, S, S)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

const VERT = /* glsl */ `
attribute vec4 aBase;   // world x, y, z, trunk half-width
attribute vec4 aCrown;  // crown-centre height above the base, crown radius
uniform vec3 uSun;      // toward the sun (unit)
uniform vec4 uRect;     // minX, minZ, 1/size
varying vec2 vST;       // along the shade (m from the trunk), across it
varying vec4 vP;        // crown-shade offset, semi-major, radius, trunk half-width
void main() {
  float e = clamp(uSun.y, 0.3, 1.0);
  vec2 d = length(uSun.xz) > 1e-3 ? -normalize(uSun.xz) : vec2(0.0, 1.0);
  vec2 n = vec2(-d.y, d.x);
  float cy = aCrown.x, R = aCrown.y;
  float off = min(cy * sqrt(1.0 - e * e) / e, cy * 2.5);
  float maj = R / e;
  float s = mix(-R * 0.7, off + maj, position.z * 0.5 + 0.5), t = position.x * R;
  vec2 xz = aBase.xz + d * s + n * t;
  vST = vec2(s, t);
  vP = vec4(off, maj, R, aBase.w);
  gl_Position = vec4((xz - uRect.xy) * uRect.z * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = /* glsl */ `
uniform sampler2D uDapple;
varying vec2 vST;
varying vec4 vP;
void main() {
  // crown: the dappled image on an ellipse round the offset point (u along the light, v across)
  vec2 q = vec2((vST.x - vP.x) / vP.y, vST.y / vP.z);
  float crown = dot(q, q) < 1.0 ? texture2D(uDapple, q * 0.5 + 0.5).r : 0.0;
  // trunk: a strip from the foot to the crown's shade
  float trunk = (1.0 - smoothstep(vP.w * 0.6, vP.w, abs(vST.y))) * step(0.0, vST.x) * (1.0 - smoothstep(vP.x * 0.7, vP.x + 0.01, vST.x)) * 0.85;
  gl_FragColor = vec4(max(crown, trunk), 0.0, 0.0, 1.0);
}`

export class TreeShadows {
  private readonly mesh: THREE.InstancedMesh
  private readonly scene = new THREE.Scene()
  private readonly cam = new THREE.Camera()
  private readonly target: THREE.WebGLRenderTarget
  private readonly base: THREE.InstancedBufferAttribute
  private readonly crown: THREE.InstancedBufferAttribute
  private readonly uniforms = {
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uRect: { value: new THREE.Vector4() },
    uDapple: { value: dappleTexture() },
  }
  /** Per species id: crown-centre height, crown radius, trunk half-width (instance scale 1). */
  private species: Float32Array | null = null
  private lastX = Infinity
  private lastZ = Infinity
  private lastChunks = -1
  private readonly drawnSun = new THREE.Vector3()
  private dirty = true
  enabled = false

  constructor() {
    const g = new THREE.InstancedBufferGeometry()
    // A unit quad: x across (−1…1), z along (−1…1); the vertex shader places it.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3))
    g.setIndex([0, 2, 1, 0, 3, 2])
    this.base = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4)
    this.crown = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4)
    this.base.setUsage(THREE.DynamicDrawUsage)
    this.crown.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aBase', this.base)
    g.setAttribute('aCrown', this.crown)
    const mat = new THREE.ShaderMaterial({
      name: 'TreeShadows',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      // MAX: overlapping crowns are one shade, never black
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
    })
    this.mesh = new THREE.InstancedMesh(g, mat, MAX)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: false, type: THREE.UnsignedByteType, generateMipmaps: false })
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.LinearFilter
    globalUniforms.uTreeShade.value = this.target.texture
  }

  /** @param sunDir toward the key light (unit); `strength` 0..1 (its brightness × cloud × cave). */
  update(renderer: THREE.WebGLRenderer | null, world: WorldManager, eye: THREE.Vector3, sunDir: THREE.Vector3, strength: number): void {
    const on = this.enabled && strength > 0.02 && !!renderer
    globalUniforms.uTreeShadeOn.value = on ? 1 : 0
    if (!on) return
    globalUniforms.uTreeShadeRect.value.w = strength
    if (!this.species) this.species = speciesTable(world)
    if (Math.hypot(eye.x - this.lastX, eye.z - this.lastZ) > REBUILD || world.chunks.size !== this.lastChunks) {
      this.lastX = eye.x; this.lastZ = eye.z; this.lastChunks = world.chunks.size
      this.rebuild(world, eye)
      this.dirty = true
    }
    // the sun turns slowly: redraw when it moved ~0.6°
    if (this.dirty || this.drawnSun.dot(sunDir) < 0.99995) {
      this.drawnSun.copy(sunDir)
      this.uniforms.uSun.value.copy(sunDir)
      this.draw(renderer!)
      this.dirty = false
    }
  }

  private rebuild(world: WorldManager, eye: THREE.Vector3): void {
    const sp = this.species!
    // The map's rect, snapped to its texel grid (the shade doesn't crawl as the player moves).
    const texel = (RADIUS * 2) / SIZE
    const x0 = Math.floor((eye.x - RADIUS) / texel) * texel, z0 = Math.floor((eye.z - RADIUS) / texel) * texel
    this.uniforms.uRect.value.set(x0, z0, 1 / (RADIUS * 2), 0)
    const B = this.base.array as Float32Array, C = this.crown.array as Float32Array
    let n = 0
    const r2 = RADIUS * RADIUS
    for (const ch of world.chunks.values()) {
      const d = ch.data
      const ox = d.cx * CHUNK_SIZE, oz = d.cz * CHUNK_SIZE
      // (chunk entirely out of range)
      const nx = Math.max(ox, Math.min(eye.x, ox + CHUNK_SIZE)), nz = Math.max(oz, Math.min(eye.z, oz + CHUNK_SIZE))
      if ((nx - eye.x) ** 2 + (nz - eye.z) ** 2 > r2) continue
      const t = d.trees
      for (let o = 0; o < t.length && n < MAX; o += TREE_STRIDE) {
        const x = ox + t[o], z = oz + t[o + 2]
        if ((x - eye.x) ** 2 + (z - eye.z) ** 2 > r2) continue
        const s = t[o + 4], k = (t[o + 5] | 0) * 3
        if (!(sp[k + 1] > 0)) continue
        B[n * 4] = x; B[n * 4 + 1] = t[o + 1]; B[n * 4 + 2] = z; B[n * 4 + 3] = sp[k + 2] * s
        C[n * 4] = sp[k] * s; C[n * 4 + 1] = sp[k + 1] * s; C[n * 4 + 2] = 0; C[n * 4 + 3] = 0
        n++
      }
    }
    this.mesh.count = n
    this.base.needsUpdate = true
    this.crown.needsUpdate = true
  }

  private draw(renderer: THREE.WebGLRenderer): void {
    const r = this.uniforms.uRect.value
    globalUniforms.uTreeShadeRect.value.set(r.x, r.y, r.z, globalUniforms.uTreeShadeRect.value.w)
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.autoUpdate
    const prevClear = renderer.getClearColor(_c), prevAlpha = renderer.getClearAlpha()
    renderer.autoClear = false
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 1)
    renderer.clear(true, false, false)
    renderer.render(this.scene, this.cam)
    renderer.setRenderTarget(prevRT)
    renderer.setClearColor(prevClear, prevAlpha)
    renderer.autoClear = prevAuto
    renderer.shadowMap.autoUpdate = prevShadow
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.uniforms.uDapple.value.dispose()
    this.target.dispose()
    globalUniforms.uTreeShade.value = null
    globalUniforms.uTreeShadeOn.value = 0
  }
}
const _c = new THREE.Color()

/** Crown-centre height, crown radius and trunk half-width per species id, from each species' full-detail model. */
function speciesTable(world: WorldManager): Float32Array {
  const out = new Float32Array(32 * 3)
  for (const s of world.treeSpecies) {
    const b = treeBox(s.levels[0])
    out[s.id * 3] = b.x
    out[s.id * 3 + 1] = b.z * 0.85 // (the tufts' outer reach is soft: the shade sits a little inside it)
    out[s.id * 3 + 2] = Math.max(0.15, s.trunkRadius)
  }
  return out
}
