import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * POST (MEDIUM+): the scene renders linear HDR into a half-float target (MSAA on the tier's word), then one composite
 * to the screen — a soft BLOOM (dual-filter mip chain from the bright parts: the sun, the glowing sky round it, its
 * glare on water), GOD RAYS, the faintest vignette, tone map + sRGB, and a dither (no banding in the sky).
 * LOW draws straight to the screen with the same tone map (the materials apply it) — no bloom, the rest identical.
 *
 * GOD RAYS (screen-space light scattering, at a quarter of the resolution): the sky's pixels (the sky writes alpha 0,
 * everything else 1; a leaf card's edge, alpha-to-coverage, lets part through) near the sun's place on the screen are
 * kept as the light's source, then blurred RADIALLY toward the sun in two passes (12 taps each, the second 13× longer:
 * 144 evenly spaced samples, fading with distance) — the light streams out round every trunk, crown, rock and ridge
 * standing against the bright sky, and is added to the scene tinted as that sky is. Off when the sun is behind the
 * camera (the passes are skipped). Cost ≈ 3 quarter-resolution passes (~0.1–0.2 ms on a phone).
 */
export class Post {
  private readonly scene: THREE.WebGLRenderTarget
  private readonly mips: THREE.WebGLRenderTarget[] = []
  private readonly quad = new FullScreenQuad()
  private readonly down: THREE.ShaderMaterial
  private readonly up: THREE.ShaderMaterial
  private readonly comp: THREE.ShaderMaterial
  private readonly rays: THREE.WebGLRenderTarget[] = []
  private readonly rayMask: THREE.ShaderMaterial
  private readonly rayBlur: THREE.ShaderMaterial
  private readonly sunClip = new THREE.Vector4()
  private readonly camDir = new THREE.Vector3()

  constructor(private readonly levels: number, samples: number, readonly strength = 0.14, readonly rayStrength = 0.5) {
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter }
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true })
    for (let i = 0; i < levels; i++) this.mips.push(new THREE.WebGLRenderTarget(1, 1, opts))
    for (let i = 0; i < 2; i++) this.rays.push(new THREE.WebGLRenderTarget(1, 1, { ...opts, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping }))
    const vert = /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
    this.down = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        layout(location = 0) out highp vec4 outColor;
        uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uPrefilter;
        in vec2 vUv;
        // a SOFT KNEE from 1.0: the sun, the glowing sky round it, the sunset horizon, glints on the water bloom — the
        // lit ground and leaves don't (no haze over the colours)
        vec3 pre(vec3 c) { float l = max(c.r, max(c.g, c.b)); float k = clamp((l - 1.0) / 1.2, 0.0, 1.0); return c * k * k; }
        void main() {
          vec3 c = texture(tSrc, vUv).rgb * 4.0;
          c += texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
          c += texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
          c /= 8.0;
          if (uPrefilter > 0.5) c = pre(c);
          outColor = vec4(min(c, vec3(16.0)), 1.0); // (no fireflies from a single glinting blade)
        }`,
      depthTest: false, depthWrite: false,
    })
    this.up = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        layout(location = 0) out highp vec4 outColor;
        uniform sampler2D tSrc; uniform vec2 uTexel;
        in vec2 vUv;
        void main() {
          vec3 c = vec3(0.0);
          c += texture(tSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb + texture(tSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb;
          c += texture(tSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb + texture(tSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb;
          c += (texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
              + texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb) * 2.0;
          outColor = vec4(c / 12.0, 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    })
    // god rays 1: the light's source — the sky's pixels near the sun, brighter the closer (4 bilinear taps = the 4 × 4
    // full-resolution pixels under each quarter-resolution one)
    this.rayMask = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        layout(location = 0) out highp vec4 outColor;
        uniform sampler2D tSrc; uniform vec2 uTexel; uniform vec2 uSun; uniform float uAspect;
        in vec2 vUv;
        vec3 sky(vec2 uv) { vec4 s = texture(tSrc, uv); return min(s.rgb, vec3(12.0)) * (1.0 - s.a); }
        void main() {
          vec3 c = (sky(vUv + uTexel * vec2(-1.0, -1.0)) + sky(vUv + uTexel * vec2(1.0, -1.0))
                  + sky(vUv + uTexel * vec2(-1.0, 1.0)) + sky(vUv + uTexel * vec2(1.0, 1.0))) * 0.25;
          // the source: the bright sky round the sun (the disc, its glow) — a tight one, so the streaks have contrast
          float d = length((vUv - uSun) * vec2(uAspect, 1.0));
          float near = 1.0 - smoothstep(0.0, 0.5, d);
          outColor = vec4(max(c - 0.6, 0.0) * near * near * near, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    })
    // god rays 2: the radial blur toward the sun (12 taps over uSpan of the way there, each a little weaker)
    this.rayBlur = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uSpan: { value: 0.06 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        layout(location = 0) out highp vec4 outColor;
        uniform sampler2D tSrc; uniform vec2 uSun; uniform float uSpan;
        in vec2 vUv;
        void main() {
          vec2 step = (uSun - vUv) * (uSpan / 12.0);
          vec2 uv = vUv;
          vec3 c = vec3(0.0);
          float w = 1.0, sum = 0.0;
          for (int i = 0; i < 12; i++) {
            c += texture(tSrc, uv).rgb * w;
            sum += w;
            w *= 0.94;
            uv += step;
          }
          outColor = vec4(c / sum, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    })
    this.comp = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uBloom: { value: strength }, uRes: { value: new THREE.Vector2() }, tRays: { value: null }, uRays: { value: 0 } },
      vertexShader: vert,
      fragmentShader: /* glsl */ `
        layout(location = 0) out highp vec4 pc_fragColor;
        #define gl_FragColor pc_fragColor
        uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uBloom; uniform vec2 uRes;
        uniform sampler2D tRays; uniform float uRays;
        in vec2 vUv;
        void main() {
          vec3 c = texture(tScene, vUv).rgb;
          c += texture(tBloom, vUv).rgb * uBloom;
          if (uRays > 0.0) c += texture(tRays, vUv).rgb * uRays;
          if (uRays < 0.0) c = texture(tRays, vUv).rgb * -uRays; // (?rays=-k: the rays alone, to tune them)
          // vignette: the faintest darkening of the corners (no tint: the colours stay pure)
          vec2 q = vUv - 0.5;
          c *= 1.0 - dot(q, q) * 0.22;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          // dither ±0.5 / 255
          float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          gl_FragColor.rgb += (n - 0.5) / 255.0;
        }`,
      depthTest: false, depthWrite: false,
    })
  }

  setSize(w: number, h: number): void {
    this.scene.setSize(w, h)
    let mw = w, mh = h
    for (const m of this.mips) { mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); m.setSize(mw, mh) }
    for (const r of this.rays) r.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2))
    ;(this.comp.uniforms.uRes.value as THREE.Vector2).set(w, h)
  }

  /** One frame. sunDir: toward the sun (or the moon) — its place on the screen for the god rays. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sunDir?: THREE.Vector3): void {
    renderer.setRenderTarget(this.scene)
    renderer.render(scene, camera)
    this.godRays(renderer, camera, sunDir)
    // bloom: down the chain (the first step keeps only the bright), then back up, adding each level
    let src: THREE.Texture = this.scene.texture
    let sw = this.scene.width, sh = this.scene.height
    for (let i = 0; i < this.levels; i++) {
      this.down.uniforms.tSrc.value = src
      ;(this.down.uniforms.uTexel.value as THREE.Vector2).set(0.5 / sw, 0.5 / sh)
      this.down.uniforms.uPrefilter.value = i === 0 ? 1 : 0
      this.quad.material = this.down
      renderer.setRenderTarget(this.mips[i])
      this.quad.render(renderer)
      src = this.mips[i].texture
      sw = this.mips[i].width; sh = this.mips[i].height
    }
    renderer.autoClear = false
    for (let i = this.levels - 1; i > 0; i--) {
      this.up.uniforms.tSrc.value = this.mips[i].texture
      ;(this.up.uniforms.uTexel.value as THREE.Vector2).set(0.5 / this.mips[i].width, 0.5 / this.mips[i].height)
      this.quad.material = this.up
      renderer.setRenderTarget(this.mips[i - 1])
      this.quad.render(renderer)
    }
    renderer.autoClear = true
    this.comp.uniforms.tScene.value = this.scene.texture
    this.comp.uniforms.tBloom.value = this.mips[0].texture
    this.comp.uniforms.tRays.value = this.rays[0].texture
    this.quad.material = this.comp
    renderer.setRenderTarget(null)
    this.quad.render(renderer)
  }

  private godRays(renderer: THREE.WebGLRenderer, camera: THREE.Camera, sunDir?: THREE.Vector3): void {
    this.comp.uniforms.uRays.value = 0
    if (!sunDir || this.rayStrength === 0) return
    // the sun's place on the screen (a point far along its direction); behind the camera → no rays
    camera.getWorldDirection(this.camDir)
    const facing = THREE.MathUtils.smoothstep(this.camDir.dot(sunDir), 0.05, 0.45)
    if (facing <= 0) return
    const c = this.sunClip.set(camera.position.x + sunDir.x * 1000, camera.position.y + sunDir.y * 1000, camera.position.z + sunDir.z * 1000, 1)
    c.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix)
    if (c.w <= 0) return
    const sx = c.x / c.w * 0.5 + 0.5, sy = c.y / c.w * 0.5 + 0.5
    const r0 = this.rays[0], r1 = this.rays[1]
    const mask = this.rayMask.uniforms
    mask.tSrc.value = this.scene.texture
    ;(mask.uTexel.value as THREE.Vector2).set(1 / this.scene.width, 1 / this.scene.height)
    ;(mask.uSun.value as THREE.Vector2).set(sx, sy)
    mask.uAspect.value = this.scene.width / this.scene.height
    this.quad.material = this.rayMask
    renderer.setRenderTarget(r0)
    this.quad.render(renderer)
    const blur = this.rayBlur.uniforms
    ;(blur.uSun.value as THREE.Vector2).set(sx, sy)
    this.quad.material = this.rayBlur
    blur.tSrc.value = r0.texture; blur.uSpan.value = 0.065
    renderer.setRenderTarget(r1)
    this.quad.render(renderer)
    blur.tSrc.value = r1.texture; blur.uSpan.value = 0.85
    renderer.setRenderTarget(r0)
    this.quad.render(renderer)
    this.comp.uniforms.uRays.value = this.rayStrength * facing
  }
}
