import * as THREE from 'three'
import type { Atmosphere } from './Atmosphere'
import type { Tier } from './quality'

/**
 * RAIN (2026-10-27, OTH has weather): thin painted streaks falling in a 44 × 26 × 44 m box that follows the camera
 * (each streak wraps round it in the vertex shader — no CPU per drop), slanted by the wind, fading near the lens and
 * into the distance. ONE instanced draw of `tier.rain` streaks (LOW 1 600 … ULTRA 4 000), only while it rains; their
 * colour follows the sky (pale by day, dim at night, lit warm in the headlights' beams). ≈ 0.05–0.15 ms GPU.
 */
export class Rain {
  readonly mesh: THREE.Mesh

  constructor(private readonly atmos: Atmosphere, tier: Tier) {
    const n = tier.rain
    const g = new THREE.InstancedBufferGeometry()
    // one streak: a quad along y (0 bottom … 1 top), x across (−1 … 1)
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3))
    g.setIndex([0, 1, 2, 0, 2, 3])
    const seed = new Float32Array(n * 4)
    let h = 0x9e3779b9
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296
    for (let i = 0; i < n; i++) { seed[i * 4] = rnd(); seed[i * 4 + 1] = rnd(); seed[i * 4 + 2] = rnd(); seed[i * 4 + 3] = rnd() }
    g.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 4))
    g.instanceCount = n
    const u = atmos.uniforms
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCamPos: u.uCamPos, uTime: u.uTime, uRain: u.uRain, uWind: u.uWind, uAmbSky: u.uAmbSky, uSunColor: u.uSunColor, uHeadL: u.uHeadL, uHeadR: u.uHeadR, uHeadDir: u.uHeadDir },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform vec3 uCamPos;
        uniform float uTime;
        uniform vec2 uWind;
        varying float vFade;
        varying float vV;
        varying vec3 vWorld;
        const vec3 BOX = vec3(44.0, 26.0, 44.0);
        void main() {
          float speed = 9.0 + seed.w * 3.0;
          vec3 vel = vec3(uWind.x * 0.6, -speed, uWind.y * 0.6);
          // wrapped round the camera: each streak's place in the box, moved by its fall
          vec3 p = seed.xyz * BOX + vel * uTime;
          p = mod(p - uCamPos + BOX * 0.5, BOX) - BOX * 0.5 + uCamPos;
          vec3 dir = normalize(vel);
          float len = 0.8 + seed.w * 0.6;
          vec3 toCam = normalize(uCamPos - p);
          // (≥ ~1.5 px wide at any distance: a 2 cm streak vanished past a few metres)
          float d0 = length(p - uCamPos);
          vec3 side = normalize(cross(dir, toCam)) * max(0.018, d0 * 0.0016);
          vec3 w = p + side * position.x - dir * len * position.y;
          vWorld = w;
          vV = position.y;
          float d = d0;
          vFade = smoothstep(1.5, 4.0, d) * (1.0 - smoothstep(14.0, 21.0, d));
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uRain;
        uniform vec3 uAmbSky;
        uniform vec3 uSunColor;
        uniform vec4 uHeadL;
        uniform vec3 uHeadR;
        uniform vec3 uHeadDir;
        varying float vFade;
        varying float vV;
        varying vec3 vWorld;
        void main() {
          // the streak's colour: the sky's light on water (+ the headlights' beam where it crosses it)
          vec3 c = uAmbSky * 1.6 + uSunColor * 0.12 + vec3(0.06, 0.07, 0.08);
          if (uHeadL.w > 0.5) {
            vec3 v = vWorld - (uHeadL.xyz + uHeadR) * 0.5;
            float a = dot(v, uHeadDir);
            float r = length(v - a * uHeadDir) / max(a, 0.5);
            c += vec3(1.0, 0.88, 0.66) * 0.9 * step(0.0, a) * (1.0 - smoothstep(0.25, 0.45, r)) * (1.0 - smoothstep(8.0, 22.0, a));
          }
          float alpha = 0.5 * uRain * vFade * sin(vV * 3.14159);
          gl_FragColor = vec4(c * alpha, alpha);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // (the billboard's winding faces away from the camera: culled, the rain was invisible)
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      // (the sky mark for the god rays — alpha — is left as it was: rain doesn't hide the sky)
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    })
    this.mesh = new THREE.Mesh(g, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 50
    this.mesh.visible = false
  }

  update(): void {
    this.mesh.visible = this.atmos.uniforms.uRain.value > 0.01
  }
}
