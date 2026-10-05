import { isOverland } from '../artStyle'
import * as THREE from 'three'
import type { TimeOfDay } from '../lighting/TimeOfDay'
import { MIST_GLSL, SKY_GLSL, skyUniforms } from './skyShader'

/**
 * Procedural sky: gradient (horizon == fog colour), sun disc + glow, moon disc + halo, stars, and a
 * drifting stylized cloud layer (3-octave value noise on a plane projection) lit by the key light —
 * orange-rimmed at sunset like refer/roads/forest-road-evening-hero.png.
 * One draw call, fragment-only work, drawn first with depthWrite off (so the god-ray pass sees
 * sky as depth = 1). Follows the camera; radius stays inside the far plane.
 * Output is linear HDR — the sun core is > 1 so tone mapping + god rays read it as a light source.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'SkyDome',
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // on the far plane
        }
      `,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        ${MIST_GLSL}
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyColor(d, true);
          // Ground mist seen against the sky: full below the horizon, thinning with elevation (integral to infinity).
          float mist = mistAmount(vec3(d.x, max(d.y, 0.004), d.z), 1.0e5);
          gl_FragColor = vec4(mix(col, skyColor(d, false) * 1.06, mist * 0.9), 1.0);
        }
      `,
    })
    const geo = new THREE.IcosahedronGeometry(1, 3)
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.name = 'sky'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1000
    this.mesh.matrixAutoUpdate = false
    // LOW-RES SKY: the full sky shader (gradient, clouds, sun/moon, mist — the most expensive pixels on screen,
    // measured 2.4 ms of 16 at 8 MP on LOW) runs into a small HalfFloat target; the dome in the scene just samples
    // it by screen position. The sky is smooth, so ¼–½ resolution is invisible; cost ÷ 4–16.
    this.fullMesh = new THREE.Mesh(geo, this.material)
    this.fullMesh.frustumCulled = false
    this.fullMesh.matrixAutoUpdate = false
    this.skyScene.add(this.fullMesh)
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.target.texture.name = 'skyLowRes'
    this.lowMat = new THREE.ShaderMaterial({
      name: 'SkyLowRes', side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { ...skyUniforms, tSky: { value: this.target.texture }, uInvSize: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
      // Stars stay crisp: single-pixel points don't survive the upscale, so they are added here at full resolution
      // (same hash as the full shader — the low-res pass leaves them out).
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        uniform sampler2D tSky; uniform vec2 uInvSize; varying vec3 vDir;
        void main() {
          vec3 col = texture2D(tSky, gl_FragCoord.xy * uInvSize).rgb;
          if (uSkyStars > 0.001) {
            vec3 d = normalize(vDir);
            float h = sky_h3(floor(d * 420.0));
            float star = step(0.9984, h) * smoothstep(0.02, 0.25, d.y) * (0.6 + 0.4 * sin(uSkyTime * (1.5 + h * 4.0) + h * 40.0));
            float dark = 1.0 - smoothstep(0.035, 0.14, dot(col, vec3(0.3, 0.59, 0.11)));
            float disc = smoothstep(0.99955, 0.9998, max(dot(d, uSkyMoonDir), 0.0));
            col += vec3(0.75, 0.82, 1.0) * star * uSkyStars * dark * (0.7 + 1.2 * fract(h * 97.0)) * (1.0 - disc);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  }

  private readonly fullMesh: THREE.Mesh
  private readonly skyScene = new THREE.Scene()
  private readonly target: THREE.WebGLRenderTarget
  private readonly lowMat: THREE.ShaderMaterial
  private lowRes = false

  /**
   * Before the scene render: draw the sky at `scale` × the scene target (w × h) and point the dome at it; scale ≥ 1
   * draws it directly at full resolution as before. Call `full()` around any other camera's render (reflections).
   */
  prepare(renderer: THREE.WebGLRenderer, camera: THREE.Camera, w: number, h: number, scale: number): void {
    this.lowRes = scale < 0.99
    if (!this.lowRes) {
      this.mesh.material = this.material
      return
    }
    const tw = Math.max(32, Math.round(w * scale)), th = Math.max(32, Math.round(h * scale))
    if (this.target.width !== tw || this.target.height !== th) this.target.setSize(tw, th)
    const prev = renderer.getRenderTarget()
    skyUniforms.uSkyLowRes.value = 1
    renderer.setRenderTarget(this.target)
    renderer.render(this.skyScene, camera)
    renderer.setRenderTarget(prev)
    skyUniforms.uSkyLowRes.value = 0
    ;(this.lowMat.uniforms.uInvSize.value as THREE.Vector2).set(1 / w, 1 / h)
    this.mesh.material = this.lowMat
  }

  /** The full-resolution sky shader on the dome (for a different camera / target, e.g. the water reflection). */
  full(): void {
    this.mesh.material = this.material
  }
  /** Back to the low-res sky after `full()`. */
  restore(): void {
    if (this.lowRes) this.mesh.material = this.lowMat
  }

  update(tod: TimeOfDay, camera: THREE.PerspectiveCamera, time: number): void {
    const u = skyUniforms
    const p = tod.current
    u.uSkyHorizon.value.copy(p.fogColor)
    u.uSkyZenith.value.copy(p.skyZenith)
    u.uSkySunDir.value.copy(tod.sunDir)
    u.uSkyMoonDir.value.copy(tod.moonDir)
    u.uSkySunColor.value.copy(p.sunColor)
    u.uSkyMoonColor.value.copy(p.moonColor)
    u.uSkySunVis.value = THREE.MathUtils.smoothstep(tod.sunDir.y, -0.06, 0.02) * (1 - tod.nightmare * 0.3)
    u.uSkyMoonVis.value = THREE.MathUtils.smoothstep(tod.moonDir.y, -0.04, 0.05) * (1 - 0.7 * THREE.MathUtils.smoothstep(tod.sunDir.y, -0.1, 0.1))
    u.uSkyStars.value = p.stars
    u.uSkyClouds.value = p.clouds
    u.uSkyCloudWhite.value = p.cloudWhite
    u.uSkyStorm.value = p.storm
    u.uSkyHaze.value.set(p.haze, isOverland() ? 380 : 110) // overland: the haze builds over a longer distance — near field stays crisp
    u.uSkyTime.value = time
    // Follow the camera; scale inside the far plane (the vertex shader pins depth to far anyway).
    const r = camera.far * 0.9
    this.mesh.matrix.makeScale(r, r, r).setPosition(camera.position)
    this.mesh.matrixWorld.copy(this.mesh.matrix)
    this.fullMesh.matrix.copy(this.mesh.matrix)
    this.fullMesh.matrixWorld.copy(this.mesh.matrix)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.lowMat.dispose()
    this.target.dispose()
  }
}
