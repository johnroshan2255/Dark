import * as THREE from 'three'
import { MIST_GLSL } from '../sky/skyShader'

/**
 * Light-shaft pass, rendered at 1/4–1/6 resolution into one RT:
 *
 *  G — VOLUMETRIC shafts (the "real" god rays): each pixel marches from the camera toward the scene depth
 *      and accumulates in-scattered key light wherever the point is NOT in the sun/moon shadow map. Trunks and
 *      canopies cast visible beams through the fog from any view direction, day (sun) or night (moon).
 *      Cost ∝ pixels × steps (e.g. HIGH 720×405 × 24 ≈ 7 M hardware-PCF lookups ≈ 0.4–0.8 ms desktop).
 *      Range is limited to the shadow frustum (±26–36 m) — beyond it the march stops (fog takes over).
 *  A — FOG BANKS: the same march accumulates the height-fog density modulated by drifting 3D value noise
 *      (2 octaves) — the analytic mist in every material is the average; this adds the denser, slowly moving
 *      patches (and it brightens the shafts where the air is thick). Tier flag `fog.banks`.
 *  R — SCREEN-SPACE glare streaks toward the light when it is on/near screen (radial march over scene
 *      depth; sky emits, geometry occludes, fogged geometry partly transmits). Catches far silhouettes the
 *      shadow map doesn't cover (tree line against a sunset).
 *
 * Both marches start at an interleaved-gradient jitter so low step counts become fine noise, which the
 * bilinear upsample in the grading pass smooths. See skills/postprocessing.
 */
export const GOD_RAYS_MAX_SAMPLES = 32
export const VOLUME_MAX_STEPS = 32

export function createGodRaysMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'GodRays',
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tDepth: { value: null },
      tShadow: { value: null },
      uHasShadow: { value: 0 },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightUv: { value: new THREE.Vector2(0.5, 0.5) },
      uRadial: { value: 0 },
      uSamples: { value: 24 },
      uSteps: { value: 16 },
      uMaxDist: { value: 40 },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
      uFog: { value: new THREE.Vector2(50, 200) },
      uAspect: { value: 1 },
      uSkyMist: { value: new THREE.Vector4(0, -2, 0.09, 0) },
      /** x noise scale (1/m), y bank strength, z/w drift offset (m). */
      uMistNoise: { value: new THREE.Vector4(0.045, 3.0, 0, 0) },
      uBanks: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D tDepth;
      uniform sampler2DShadow tShadow;
      uniform float uHasShadow, uRadial, uMaxDist, uNear, uFar, uAspect;
      uniform vec2 uFog; // near, far — same smoothstep curve as three's Fog
      uniform mat4 uShadowMatrix, uInvProj, uCamWorld;
      uniform vec3 uLightDir;
      uniform vec2 uLightUv;
      uniform int uSamples, uSteps;
      uniform vec4 uMistNoise;
      uniform float uBanks;
      varying vec2 vUv;
      ${MIST_GLSL}
      float bh3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vn3(vec3 x) {
        vec3 i = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(bh3(i), bh3(i + vec3(1, 0, 0)), f.x), mix(bh3(i + vec3(0, 1, 0)), bh3(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(bh3(i + vec3(0, 0, 1)), bh3(i + vec3(1, 0, 1)), f.x), mix(bh3(i + vec3(0, 1, 1)), bh3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }

      float emit(vec2 uv) {
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
        float z = texture2D(tDepth, uv).x;
        if (z >= 0.9999) return 1.0;                        // sky
        float d = -perspectiveDepthToViewZ(z, uNear, uFar);
        return smoothstep(uFog.x, uFog.y, d) * 0.8;        // fogged geometry lets some light through
      }

      float lit(vec3 wp) {
        vec4 sc = uShadowMatrix * vec4(wp, 1.0);
        vec3 c = sc.xyz / sc.w;
        if (c.x <= 0.0 || c.y <= 0.0 || c.x >= 1.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
        return texture(tShadow, vec3(c.xy, c.z - 0.0015));
      }

      void main() {
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float radial = 0.0;
        if (uRadial > 0.001) {
          vec2 delta = vUv - uLightUv;
          vec2 stepUv = delta / float(uSamples) * 0.92;
          vec2 uv = vUv - stepUv * jitter;
          float w = 1.0, sum = 0.0, norm = 0.0;
          for (int i = 0; i < ${GOD_RAYS_MAX_SAMPLES}; i++) {
            if (i >= uSamples) break;
            sum += emit(uv) * w;
            norm += w;
            w *= 0.955;
            uv -= stepUv;
          }
          float r = length(delta * vec2(uAspect, 1.0));
          radial = sum / norm * (1.0 - smoothstep(0.05, 1.1, r));
        }

        // Depth code for the grading pass's depth-aware upsample (8-bit, more precision up close).
        float z = texture2D(tDepth, vUv).x;
        float code = z >= 0.9999 ? 1.0 : 1.0 - exp(-(-perspectiveDepthToViewZ(z, uNear, uFar)) / 25.0);
        float vol = 0.0;
        float banks = 0.0;
        bool doBanks = uBanks > 0.5 && uSkyMist.x > 0.0;
        if (uHasShadow > 0.5 || doBanks) {
          vec4 ndc = vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
          vec4 vp = uInvProj * ndc;
          vp /= vp.w;
          vec3 camPos = uCamWorld[3].xyz;
          vec3 wp = (uCamWorld * vp).xyz;
          vec3 ray = wp - camPos;
          float len = length(ray);
          vec3 dir = ray / len;
          float dist = min(len, uMaxDist);
          float stepLen = dist / float(uSteps);
          float sum = 0.0;
          for (int i = 0; i < ${VOLUME_MAX_STEPS}; i++) {
            if (i >= uSteps) break;
            float t = (float(i) + jitter) * stepLen;
            vec3 p = camPos + dir * t;
            float thick = 1.0;
            if (doBanks) {
              // Height-fog density here × drifting noise: only the denser-than-average part becomes a visible bank.
              float dens = uSkyMist.x * exp(-(p.y - uSkyMist.y) * uSkyMist.z);
              vec3 q = p * uMistNoise.x + vec3(uMistNoise.z, 0.0, uMistNoise.w);
              float n = vn3(q) * 0.65 + vn3(q * 2.7 + 5.0) * 0.35;
              banks += max(n - 0.42, 0.0) * uMistNoise.y * dens * stepLen;
              thick = 0.7 + n;
            }
            if (uHasShadow > 0.5) sum += lit(p) * (1.0 - smoothstep(uFog.x, uFog.y, t)) * thick; // lit & not yet fogged
          }
          // Forward-scattering phase (brightest looking toward the light) + a little isotropic haze.
          float cosT = dot(dir, uLightDir);
          // Mostly forward scattering; tiny isotropic term → shafts, not a milky wash over everything near.
          float phase = 0.04 + 0.96 * pow(max(cosT, 0.0), 6.0);
          vol = sum / float(uSteps) * (dist / uMaxDist) * phase;
          // Over open sky the march is fully lit → a flat glow the sky shader already has. Keep only a little
          // there; shafts show where canopy/trunk shadows break the march (their contrast is what reads).
          if (z >= 0.9999) vol *= 0.3;
        }
        gl_FragColor = vec4(radial, vol, code, 1.0 - exp(-banks));
      }
    `,
  })
}
