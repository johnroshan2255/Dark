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
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = skyColor(d);
          float s = dot(d, uSunDir);
          if (uNight < 0.5) {
            // the SUN: a big bright disc (~1.6°) with a hot halo round it — the bloom pass spreads it into a glare
            c += uSunDisc * (3.2 * smoothstep(0.99955, 0.99975, s) + 0.35 * pow(max(s, 0.0), 900.0) + 0.06 * pow(max(s, 0.0), 60.0));
          } else {
            // the MOON: a pale disc with a soft halo
            c += vec3(0.75, 0.82, 1.0) * (1.4 * smoothstep(0.99975, 0.99988, s) + 0.08 * pow(max(s, 0.0), 300.0)) * uNight;
          }
          // STARS at night: a hashed grid on the sky, twinkling a little, fading toward the horizon haze
          if (uNight > 0.01 && d.y > 0.0) {
            vec3 g = d * 260.0;
            vec3 cell = floor(g);
            float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            vec3 f = fract(g) - 0.5;
            float star = step(0.985, h) * smoothstep(0.18, 0.02, length(f));
            float tw = 0.7 + 0.3 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
            c += vec3(0.9, 0.93, 1.0) * star * tw * uNight * smoothstep(0.02, 0.25, d.y) * (0.6 + 2.0 * fract(h * 97.0));
          }
          // alpha 0 marks the SKY for the god rays (Post): everything else writes 1
          gl_FragColor = vec4(c, uSkyAlpha);
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
