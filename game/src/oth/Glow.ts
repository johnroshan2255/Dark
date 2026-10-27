import * as THREE from 'three'
import type { Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'

/**
 * THE GLOW WITHOUT A POST PASS (2026-10-27, the user: "remove the post-processing, even on the laptop — but give the
 * exact look of ULTRA, the god rays and all, cheaper"; ~400 fps on the laptop so a small phone holds 60+): the scene
 * draws straight to the canvas (its own MSAA: on a phone's tile GPU resolved on-chip), and what the bloom and the god
 * rays gave is painted in the same pass, forward, from a few sprites —
 *   SUN GLARE   one camera-facing sprite on the sun: the bloom's wide warm spill over whatever stands in front of it
 *               (a ridge, a crown) and a SUNBURST of soft streaks — fading as the sun drops behind the terrain's
 *               horizon (a 32-step march over the height grid along the sun's bearing, on the CPU) or the clouds;
 *   LIGHT SHAFTS soft beams of light standing in the air among the trees round the camera, along the sun's rays, when
 *               the sun is low and in front of you (OTH's golden-hour forests) — 28 instanced cards, re-placed as the
 *               camera moves 12 m;
 *   VIGNETTE    a CSS gradient over the canvas, darkening the corners (the page's compositor blends it: no GL cost);
 * plus, in the sky / haze shaders (Atmosphere `uGlow`), the wider halo round the sun's disc and the warmer haze toward
 * it. Everything is additive or multiplied over the frame — no render target, no blit. ≈ 0.05 ms CPU, the GPU a few
 * soft quads.
 */
const SHAFTS = 28

export class Glow {
  readonly group = new THREE.Group()
  private readonly glare: THREE.Mesh
  private readonly glareMat: THREE.ShaderMaterial
  private readonly shafts: THREE.Mesh
  private readonly shaftAttr: THREE.InstancedBufferAttribute
  private readonly shaftMat: THREE.ShaderMaterial
  private readonly vignette: THREE.Mesh
  private readonly lastPlace = new THREE.Vector3(1e9, 0, 0)
  private vis = 1
  private near = 1
  private readonly v = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()

  constructor(private readonly map: MapData, private readonly atmos: Atmosphere) {
    const u = atmos.uniforms
    // THE SUN GLARE
    this.glareMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uK: { value: 0 }, uSkirt: { value: 0 }, uTime: u.uTime, uRays: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uK;
        uniform float uSkirt;
        uniform float uTime;
        uniform float uRays;
        varying vec2 vUv;
        float n1(float x) { float i = floor(x), f = fract(x); float a = fract(sin(i * 91.7) * 43758.5), b = fract(sin((i + 1.0) * 91.7) * 43758.5); return mix(a, b, f * f * (3.0 - 2.0 * f)); }
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          // the bloom's spill: a hot core (the sun seen), a wide soft skirt (also while it's just behind a ridge: the
          // bright sky round it still glows over the silhouettes)
          float core = exp(-r * 9.0) * 0.9 * uK;
          float skirt = (exp(-r * 2.4) * 0.55 + (1.0 - r) * (1.0 - r) * 0.14) * uSkirt;
          // the god rays' hint: faint soft streaks round it, slowly turning, near the core
          float a = atan(vUv.y, vUv.x) * 6.0 / 3.14159;
          float st = n1(a * 4.0 + uTime * 0.03) * 0.6 + n1(a * 9.0 - uTime * 0.05) * 0.4;
          float rays = smoothstep(0.5, 0.95, st) * pow(1.0 - r, 3.0) * 0.16 * uRays * uK;
          // (eased to nothing at the rim: no ring on a dark slope)
          gl_FragColor = vec4(uColor * (core + skirt + rays) * (1.0 - smoothstep(0.6, 1.0, r)), 1.0);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.glare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.glareMat)
    this.glare.frustumCulled = false
    this.glare.renderOrder = 900
    // THE LIGHT SHAFTS: a unit card (x across −1 … 1, y along 0 … 1), instanced: centre xyz + seed
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3))
    g.setIndex([0, 1, 2, 0, 2, 3])
    this.shaftAttr = new THREE.InstancedBufferAttribute(new Float32Array(SHAFTS * 4), 4).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aC', this.shaftAttr)
    g.instanceCount = SHAFTS
    this.shaftMat = new THREE.ShaderMaterial({
      uniforms: { uSunDir: u.uSunDir, uCamPos: u.uCamPos, uColor: { value: new THREE.Color() }, uK: { value: 0 }, uTime: u.uTime },
      vertexShader: /* glsl */ `
        attribute vec4 aC;
        uniform vec3 uSunDir;
        uniform vec3 uCamPos;
        uniform float uTime;
        varying vec2 vUv;
        varying float vA;
        void main() {
          // the beam runs down along the sunlight from 22 m up; it turns about that axis to face the camera
          vec3 ax = -uSunDir;
          float L = 26.0 + aC.w * 14.0, w = 1.2 + aC.w * 2.2;
          vec3 top = aC.xyz - ax * L * 0.55;
          vec3 mid = top + ax * L * 0.5;
          vec3 side = normalize(cross(ax, normalize(uCamPos - mid))) * w;
          vec3 p = top + ax * L * position.y + side * position.x;
          vUv = vec2(position.x, position.y);
          float d = length(mid - uCamPos);
          // (gone near the lens and far off; a slow breathing per beam)
          vA = smoothstep(4.0, 14.0, d) * (1.0 - smoothstep(55.0, 80.0, d)) * (0.65 + 0.35 * sin(uTime * 0.35 + aC.w * 40.0));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uK;
        varying vec2 vUv;
        varying float vA;
        void main() {
          float across = 1.0 - smoothstep(0.0, 1.0, abs(vUv.x));
          float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          gl_FragColor = vec4(uColor * across * across * along * vA * uK, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.shafts = new THREE.Mesh(g, this.shaftMat)
    this.shafts.frustumCulled = false
    this.shafts.renderOrder = 800
    // THE VIGNETTE: a full-screen triangle, the corners multiplied darker
    const vg = new THREE.BufferGeometry()
    vg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    this.vignette = new THREE.Mesh(vg, new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `varying vec2 vP; void main() { vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `varying vec2 vP; void main() { float k = 1.0 - 0.16 * smoothstep(0.55, 1.45, length(vP * vec2(0.85, 1.0))); gl_FragColor = vec4(vec3(k), 1.0); }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      toneMapped: false,
    }))
    this.vignette.frustumCulled = false
    this.vignette.renderOrder = 1000
    this.group.add(this.shafts, this.glare)
    // (the VIGNETTE is a CSS gradient over the canvas — the page's compositor blends it with the frame for free; drawn
    //  in WebGL it was a full-screen blend over every MSAA sample: 0.11 ms at 1080p. The WebGL one stays for ?vignette=gl)
    if (new URLSearchParams(location.search).get('vignette') === 'gl') this.group.add(this.vignette)
    else {
      const v = document.createElement('div')
      v.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1;background:radial-gradient(ellipse 85% 100% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.16) 100%)'
      document.body.appendChild(v)
    }
  }

  update(camera: THREE.PerspectiveCamera, dt: number): void {
    const u = this.atmos.uniforms, sun = u.uSunDir.value, night = u.uNight.value, cloud = u.uCloud.value
    const day = (1 - night) * THREE.MathUtils.smoothstep(sun.y, -0.03, 0.03)
    const clear = 1 - THREE.MathUtils.smoothstep(cloud, 0.45, 0.9)
    // the sun above the terrain's horizon from here? (32 steps along its bearing, 8 m … 3 km)
    const c = camera.position, hl = Math.hypot(sun.x, sun.z) || 1, ux = sun.x / hl, uz = sun.z / hl, el = sun.y / hl
    let hor = -1
    for (let i = 0, d = 8; i < 32; i++, d *= 1.18) hor = Math.max(hor, (this.map.height(c.x + ux * d, c.z + uz * d) - c.y) / d)
    const target = THREE.MathUtils.smoothstep(el - hor, -0.01, 0.025)
    this.vis += (target - this.vis) * Math.min(1, dt * 6)
    // (the skirt: still there while the sun is a few degrees behind the ridge — its glowing sky)
    const near = THREE.MathUtils.smoothstep(el - hor, -0.15, 0.0)
    this.near += (near - this.near) * Math.min(1, dt * 6)
    camera.getWorldDirection(this.dir)
    const facing = THREE.MathUtils.smoothstep(this.dir.dot(sun), 0.1, 0.6)
    // GLARE: the sun's own colour (vivid, warm at golden hour), stronger low in the sky
    const low = 1 - THREE.MathUtils.smoothstep(sun.y, 0.25, 0.7)
    const k = day * clear * this.vis * (0.55 + 0.45 * low), skirt = day * clear * Math.max(this.vis, this.near * 0.7) * (0.55 + 0.45 * low)
    this.glare.visible = skirt > 0.01 && this.dir.dot(sun) > -0.2
    if (this.glare.visible) {
      const D = Math.min(camera.far * 0.8, 2000), size = D * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9
      this.glare.position.copy(c).addScaledVector(sun, D)
      this.glare.quaternion.copy(camera.quaternion)
      this.glare.scale.setScalar(size)
      this.glareMat.uniforms.uK.value = k
      this.glareMat.uniforms.uSkirt.value = skirt
      this.glareMat.uniforms.uRays.value = 0.5 + 0.5 * low
      ;(this.glareMat.uniforms.uColor.value as THREE.Color).copy(u.uSunDisc.value).multiplyScalar(0.26)
    }
    // SHAFTS: a low sun ahead, clear sky, day
    const sk = day * clear * facing * (1 - THREE.MathUtils.smoothstep(sun.y, 0.18, 0.45)) * (0.4 + 0.6 * this.vis)
    this.shafts.visible = sk > 0.01
    if (this.shafts.visible) {
      this.shaftMat.uniforms.uK.value = sk
      ;(this.shaftMat.uniforms.uColor.value as THREE.Color).copy(u.uSunDisc.value).multiplyScalar(0.05)
      if (this.lastPlace.distanceToSquared(c) > 144) { this.lastPlace.copy(c); this.place(c, sun) }
    }
  }

  /** Re-place the beams: among the trees in front of the camera toward the sun (12–70 m), where the woods are. */
  private place(c: THREE.Vector3, sun: THREE.Vector3): void {
    const a = this.shaftAttr.array as Float32Array, mk: [number, number, number, number] = [0, 0, 0, 0]
    const base = Math.atan2(sun.x, sun.z)
    let n = 0
    for (let tries = 0; tries < 120 && n < SHAFTS; tries++) {
      const h = Math.sin((Math.floor(c.x / 12) * 73.1 + Math.floor(c.z / 12) * 19.7 + tries * 7.3) * 12.9898) * 43758.5453
      const r1 = h - Math.floor(h), r2 = (h * 7.13) % 1, r3 = (h * 3.71) % 1
      const ang = base + (r1 - 0.5) * 1.6, dist = 12 + r2 * 58
      const x = c.x + Math.sin(ang) * dist, z = c.z + Math.cos(ang) * dist
      // (where there are trees about: the woods' mask, else only a few in the open)
      if (this.map.maskAt(x, z, mk)[3] < 0.25 && r3 > 0.25) continue
      a[n * 4] = x; a[n * 4 + 1] = this.map.height(x, z); a[n * 4 + 2] = z; a[n * 4 + 3] = r3
      n++
    }
    for (let i = n; i < SHAFTS; i++) { a[i * 4] = 1e6; a[i * 4 + 1] = 0; a[i * 4 + 2] = 1e6; a[i * 4 + 3] = 0 }
    this.shaftAttr.needsUpdate = true
    this.v.set(0, 0, 0)
  }
}
