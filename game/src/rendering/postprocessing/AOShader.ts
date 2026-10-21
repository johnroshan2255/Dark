import * as THREE from 'three'

/**
 * SCREEN-SPACE AMBIENT OCCLUSION (QualitySettings.ao) — the raster stand-in for ray-traced AO: soft contact
 * shadows where the trunk meets the ground, under rocks, in creases of the terrain, around the truck's wheels.
 *
 *   AO pass   (scene depth → R8 target at `ao.scale` × scene RT): view-space position from depth, normal from
 *             the neighbouring depths (smallest-difference pairs → crisp at silhouettes), `samples` hemisphere
 *             taps on a golden-angle spiral rotated per pixel (4×4 interleaved pattern), range-checked so
 *             distant geometry behind an edge never darkens it. Fades out by ~70 m (fog owns the distance).
 *   blur pass 4×4 depth-aware box at the same resolution — removes the 4×4 rotation pattern exactly.
 *   The grading pass multiplies the scene by it (ambient-weighted: lit highlights keep most of their light).
 *
 * Cost (M4, 1280×720 → ½-res, 14 taps): see skills/art-direction §5. Off = both passes skipped.
 */
export const AO_MAX_SAMPLES = 16

export function createAOMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'SSAO',
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tDepth: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uSamples: { value: 12 },
      uRadius: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDepth; uniform mat4 uProj, uInvProj; uniform vec2 uTexel; uniform int uSamples; uniform float uRadius;
      varying vec2 vUv;
      vec3 viewPos(vec2 uv) {
        float z = texture2D(tDepth, uv).x;
        vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
        return p.xyz / p.w;
      }
      void main() {
        float z0 = texture2D(tDepth, vUv).x;
        if (z0 >= 0.9999) { gl_FragColor = vec4(1.0); return; } // sky
        vec3 P = viewPos(vUv);
        float dist = -P.z;
        if (dist > 70.0) { gl_FragColor = vec4(1.0); return; }
        // Normal from the neighbour pairs with the smaller depth step (no halo across silhouettes).
        vec3 L = viewPos(vUv - vec2(uTexel.x, 0.0)), R = viewPos(vUv + vec2(uTexel.x, 0.0));
        vec3 D = viewPos(vUv - vec2(0.0, uTexel.y)), U = viewPos(vUv + vec2(0.0, uTexel.y));
        vec3 dx = abs(R.z - P.z) < abs(P.z - L.z) ? R - P : P - L;
        vec3 dy = abs(U.z - P.z) < abs(P.z - D.z) ? U - P : P - D;
        vec3 N = normalize(cross(dx, dy));
        // Per-pixel rotation from a 4×4 interleaved pattern (the blur pass averages exactly that footprint).
        vec2 pix = mod(floor(gl_FragCoord.xy), 4.0);
        float rot = (pix.x * 4.0 + pix.y) / 16.0 * 6.2831853 + fract(pix.y * 0.618) * 0.5;
        vec3 helper = abs(N.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 T = normalize(cross(helper, N)), B = cross(N, T);
        float occ = 0.0;
        float n = float(uSamples);
        for (int i = 0; i < ${AO_MAX_SAMPLES}; i++) {
          if (i >= uSamples) break;
          float fi = float(i) + 0.5;
          float a = fi * 2.3999632 + rot;
          float r = sqrt(fi / n);                       // disc radius (uniform)
          float h = sqrt(max(0.0, 1.0 - r * r));       // lift onto the hemisphere
          float s = mix(0.15, 1.0, (fi / n) * (fi / n)); // more taps close to the point
          vec3 dir = T * (cos(a) * r) + B * (sin(a) * r) + N * h;
          vec3 S = P + dir * uRadius * s;
          vec4 c = uProj * vec4(S, 1.0);
          vec2 suv = c.xy / c.w * 0.5 + 0.5;
          if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;
          float sz = viewPos(suv).z;
          float range = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sz), 1e-3));
          occ += step(S.z + 0.03 + dist * 0.002, sz) * range;
        }
        float ao = 1.0 - occ / n;
        ao = mix(ao, 1.0, smoothstep(40.0, 70.0, dist));
        gl_FragColor = vec4(vec3(ao), 1.0);
      }`,
  })
}

export function createAOBlurMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'SSAOBlur',
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tAO: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D tAO, tDepth; uniform vec2 uTexel; uniform float uNear, uFar;
      varying vec2 vUv;
      float vz(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
      void main() {
        float z0 = vz(vUv);
        float sum = 0.0, wsum = 0.0;
        for (int j = -2; j < 2; j++) for (int i = -2; i < 2; i++) {
          vec2 uv = vUv + (vec2(float(i), float(j)) + 0.5) * uTexel;
          float w = 1.0 / (1e-3 + abs(vz(uv) - z0) / max(z0 * 0.05, 0.05));
          w = min(w, 1.0);
          sum += texture2D(tAO, uv).r * w;
          wsum += w;
        }
        gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
      }`,
  })
}
