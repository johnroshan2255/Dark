import * as THREE from 'three'
import { globalUniforms } from '../shaders/uniforms'

/**
 * TRACKS IN SNOW AND SAND: a top-down R8 render target (SIZE m square, RES² texels ≈ 9 cm) centred on the player,
 * where feet and tyres STAMP their imprints each frame (instanced quads, MAX blending → overlapping tracks don't
 * add up). The terrain shader samples it (uTrailMap / uTrailRect): in the snow and on sand the ground is pressed
 * down there — darker, compacted, with lit rims from the imprint's gradient (shaders/stylize terrain).
 * The window re-centres in RECENTER steps by copying the old tracks across (ping-pong, one fullscreen copy);
 * tracks persist until they scroll out of the window (~±SIZE/2 behind you). Cost: ≤ 1 draw per frame while
 * something moves (+1 copy when re-centring), 2 × 256 KB targets.
 */
const SIZE = 48
const RES = 512
const RECENTER = 12
const MAX_STAMPS = 96

export class TrailMap {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private cur = 0
  // top/bottom swapped so texture v grows with world +z (u with +x) — the terrain samples (xz − min) / SIZE.
  private readonly cam = new THREE.OrthographicCamera(-SIZE / 2, SIZE / 2, -SIZE / 2, SIZE / 2, -10, 10)
  private readonly scene = new THREE.Scene()
  private readonly stamps: THREE.InstancedMesh
  private readonly stampData: Float32Array // per instance: x, z, dirX, dirZ
  private readonly stampSize: Float32Array // half length, half width, depth
  private readonly copyScene = new THREE.Scene()
  private readonly copyMat: THREE.ShaderMaterial
  private n = 0
  private cx = Number.NaN
  private cz = Number.NaN
  private cleared = false

  constructor() {
    const opts = { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false } as const
    this.targets = [new THREE.WebGLRenderTarget(RES, RES, opts), new THREE.WebGLRenderTarget(RES, RES, opts)]
    for (const t of this.targets) {
      t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter
      t.texture.name = 'trailMap'
    }
    // The camera looks straight down (local up = world −z; the swapped top/bottom flips it back to +z → v).
    this.cam.position.set(0, 5, 0)
    this.cam.up.set(0, 0, -1)
    this.cam.lookAt(0, 0, 0)
    this.cam.updateMatrixWorld()
    const g = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2)
    this.stampData = new Float32Array(MAX_STAMPS * 4)
    this.stampSize = new Float32Array(MAX_STAMPS * 3)
    g.setAttribute('stamp', new THREE.InstancedBufferAttribute(this.stampData, 4))
    g.setAttribute('stampSize', new THREE.InstancedBufferAttribute(this.stampSize, 3))
    const mat = new THREE.ShaderMaterial({
      name: 'TrailStamp', depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { uCentre: { value: new THREE.Vector2() } },
      vertexShader: /* glsl */ `
        attribute vec4 stamp; attribute vec3 stampSize; uniform vec2 uCentre; varying vec2 vL; varying float vDepth;
        void main() {
          vec2 dir = normalize(stamp.zw + vec2(1e-5, 0.0)), side = vec2(-dir.y, dir.x);
          vL = position.xz;                                         // −1..1 across the stamp
          vec2 w = stamp.xy - uCentre + dir * position.z * stampSize.x + side * position.x * stampSize.y;
          vDepth = stampSize.z;
          gl_Position = projectionMatrix * viewMatrix * vec4(w.x, 0.0, w.y, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vL; varying float vDepth;
        void main() {
          // Soft-edged imprint (rounded rectangle / oval).
          float d = length(max(abs(vL) - vec2(0.55, 0.7), 0.0)) / 0.45;
          float k = 1.0 - smoothstep(0.6, 1.0, max(d, length(vL) * 0.72));
          gl_FragColor = vec4(vec3(k * vDepth), 1.0);
        }`,
    })
    this.stamps = new THREE.InstancedMesh(g, mat, MAX_STAMPS)
    this.stamps.frustumCulled = false
    this.stamps.count = 0
    this.scene.add(this.stamps)
    // Copy pass: the previous window shifted by the re-centre offset.
    this.copyMat = new THREE.ShaderMaterial({
      name: 'TrailCopy', depthTest: false, depthWrite: false,
      uniforms: { tPrev: { value: null }, uShift: { value: new THREE.Vector2() } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tPrev; uniform vec2 uShift; varying vec2 vUv;
        void main() {
          vec2 uv = vUv + uShift;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          gl_FragColor = vec4(vec3(texture2D(tPrev, uv).r * inside), 1.0);
        }`,
    })
    const tri = new THREE.BufferGeometry()
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    const q = new THREE.Mesh(tri, this.copyMat)
    q.frustumCulled = false
    this.copyScene.add(q)
    globalUniforms.uTrailMap.value = this.targets[0].texture
  }

  /**
   * Queue an imprint at world (x, z), elongated along (dx, dz).
   * @param len half length (m) @param width half width (m) @param depth 0..1 how deep it presses
   */
  stamp(x: number, z: number, dx: number, dz: number, len: number, width: number, depth: number): void {
    if (this.n >= MAX_STAMPS) return
    const i = this.n++
    this.stampData.set([x, z, dx, dz], i * 4)
    this.stampSize.set([len, width, depth], i * 3)
  }

  /** Once per frame (before the scene render): re-centre on `focus` if needed, then draw the queued stamps. */
  render(renderer: THREE.WebGLRenderer, focus: THREE.Vector3): void {
    const prevTarget = renderer.getRenderTarget()
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    if (!this.cleared) {
      for (const t of this.targets) {
        renderer.setRenderTarget(t)
        renderer.setClearColor(0x000000, 1)
        renderer.clear()
      }
      this.cleared = true
    }
    if (!(Math.abs(focus.x - this.cx) < RECENTER && Math.abs(focus.z - this.cz) < RECENTER)) {
      const nx = Math.round(focus.x / 4) * 4, nz = Math.round(focus.z / 4) * 4
      const src = this.targets[this.cur], dst = this.targets[1 - this.cur]
      if (Number.isFinite(this.cx)) {
        this.copyMat.uniforms.tPrev.value = src.texture
        ;(this.copyMat.uniforms.uShift.value as THREE.Vector2).set((nx - this.cx) / SIZE, (nz - this.cz) / SIZE)
        renderer.setRenderTarget(dst)
        renderer.render(this.copyScene, this.cam)
      } else {
        renderer.setRenderTarget(dst)
        renderer.clear()
      }
      this.cur = 1 - this.cur
      this.cx = nx
      this.cz = nz
      globalUniforms.uTrailMap.value = this.targets[this.cur].texture
      globalUniforms.uTrailRect.value.set(nx - SIZE / 2, nz - SIZE / 2, 1 / SIZE, 1 / SIZE)
    }
    if (this.n > 0) {
      ;(this.stamps.material as THREE.ShaderMaterial).uniforms.uCentre.value.set(this.cx, this.cz)
      const g = this.stamps.geometry
      ;(g.getAttribute('stamp') as THREE.InstancedBufferAttribute).needsUpdate = true
      ;(g.getAttribute('stampSize') as THREE.InstancedBufferAttribute).needsUpdate = true
      this.stamps.count = this.n
      renderer.setRenderTarget(this.targets[this.cur])
      renderer.render(this.scene, this.cam)
      this.n = 0
    }
    renderer.setRenderTarget(prevTarget)
    renderer.autoClear = autoClear
  }

  dispose(): void {
    for (const t of this.targets) t.dispose()
    this.stamps.geometry.dispose()
    ;(this.stamps.material as THREE.Material).dispose()
    this.copyMat.dispose()
  }
}
