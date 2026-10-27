import * as THREE from 'three'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'

/** The SKY: a dome round the camera drawn last, on the far plane, its colour from the shared skyColor() + the sun's disc. */
export class Sky {
  readonly mesh: THREE.Mesh

  /** markSky: write alpha 0 (Post's god rays find the sky by it) — only when drawing into Post's target; straight
   *  to the canvas (LOW) the sky stays opaque. */
  constructor(atmos: Atmosphere, markSky = false) {
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...atmos.uniforms, uSkyAlpha: { value: markSky ? 0 : 1 } },
      vertexShader: /* glsl */ `
        out vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
          // on the far plane (reversed-Z: depth 0)
          #ifdef USE_REVERSED_DEPTH_BUFFER
          gl_Position = vec4(p.xy, 0.0, p.w);
          #else
          gl_Position = p.xyww;
          #endif
        }`,
      fragmentShader: /* glsl */ `
        ${FRAG_OUT}
        ${ATMOS_GLSL}
        in vec3 vDir;
        uniform float uSkyAlpha;
        // cloud density on the sky plane: three octaves of the paint noise
        float cloudN(vec2 p) {
          // (two octaves: the third — 11 % of the shape — was 2 of the 6 reads a sky pixel paid)
          return texture(uNoise, p * 0.11).r * 0.66 + texture(uNoise, p * 0.29 + 0.37).g * 0.34;
        }
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = skyColor(d);
          float s = dot(d, uSunDir);
          // CLOUDS (2026-10-27): soft painted cumulus on a plane overhead, drifting with the wind — their cover the
          // weather's (a few puffs → a heavy grey sky in the rain); lit from the sun's side in three soft VALUE BANDS
          // (as the headlights are painted), their shade the sky's own blue-grey, melting into the haze at the horizon
          float cl = 0.0;
          vec3 cc = vec3(0.0);
          if (d.y > 0.0) {
            vec2 p = d.xz / (d.y + 0.12) + uWind * (uTime * 0.0035);
            float n = cloudN(p);
            float th = mix(0.68, 0.34, uCloud);
            cl = smoothstep(th, th + 0.13, n) * smoothstep(0.0, 0.14, d.y);
            float lit = clamp(0.55 + (n - cloudN(p + normalize(uSunDir.xz + 1e-4) * 0.07)) * 4.5, 0.0, 1.0);
            lit = (floor(lit * 3.0) + smoothstep(0.25, 0.75, fract(lit * 3.0))) / 3.0;
            vec3 shadeC = mix(uSkyZenith, uSkyHorizon, 0.5) * 0.92 + uAmbSky * 0.25;
            vec3 litC = uSkyHorizon * 0.7 + uSunDisc * 0.3 * (1.0 - uNight);
            cc = mix(shadeC, litC, lit);
            float g = dot(cc, vec3(0.2126, 0.7152, 0.0722));
            cc = mix(cc, vec3(g) * 0.82, smoothstep(0.5, 1.0, uCloud) * 0.7);
            c = mix(c, cc, cl * 0.94);
          }
          if (uNight < 0.5) {
            // the SUN: a big bright disc (~1.6°) with a hot halo round it — the bloom pass spreads it into a glare
            c += uSunDisc * (3.2 * smoothstep(0.99955, 0.99975, s) + 0.35 * pow(max(s, 0.0), 900.0) + 0.06 * pow(max(s, 0.0), 60.0)) * (1.0 - cl * 0.92);
            // (no post pass: the bloom's halo, painted — a bright rim round the disc, a wide soft glow)
            c += uSunDisc * uGlow * (0.9 * pow(max(s, 0.0), 2200.0) + 0.22 * pow(max(s, 0.0), 160.0) + 0.04 * pow(max(s, 0.0), 18.0)) * (1.0 - cl * 0.8);
          } else {
            // the MOON: a pale disc with a soft halo
            c += vec3(0.75, 0.82, 1.0) * (1.4 * smoothstep(0.99975, 0.99988, s) + 0.08 * pow(max(s, 0.0), 300.0)) * uNight * (1.0 - cl * 0.9);
          }
          // STARS at night: a hashed grid on the sky, twinkling a little, fading toward the horizon haze
          if (uNight > 0.01 && d.y > 0.0) {
            vec3 g = d * 260.0;
            vec3 cell = floor(g);
            float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            vec3 f = fract(g) - 0.5;
            float star = step(0.985, h) * smoothstep(0.18, 0.02, length(f));
            float tw = 0.7 + 0.3 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
            c += vec3(0.9, 0.93, 1.0) * star * tw * uNight * smoothstep(0.02, 0.25, d.y) * (0.6 + 2.0 * fract(h * 97.0)) * (1.0 - cl);
          }
          // alpha 0 marks the SKY for the god rays (Post): everything else writes 1 — a cloud mostly (rays through gaps)
          // (a hair of dither: the post pass did it — without it the sky's long gradients band in 8 bits)
          c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * (1.5 / 255.0) * uGlow;
          gl_FragColor = vec4(c, mix(uSkyAlpha, 1.0, cl * 0.85));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
    })
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 100 // last: only where nothing else wrote depth (no overdraw)
  }
}
