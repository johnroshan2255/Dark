import * as THREE from 'three'

/**
 * PAINTERLY filter — Kuwahara (4 overlapping 2×2 quadrants of a 3×3 kernel at 2× stride, 9 fetches —
 * was 5×5/25 fetches, the largest single GPU cost measured on HIGH).
 * Each pixel takes the mean colour of its least-varying quadrant: flat colour areas become smooth brush-like
 * patches, edges stay sharp but lose their rendered crispness. This is what makes the frame read as the
 * painted concept art of refer/ instead of clean CG. `uStride` scales the brush size (pixels between taps).
 * Variance is measured on compressed colour (c / (1 + c)) so HDR highlights don't dominate.
 */
export function createPaintMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'PaintPass',
    depthTest: false,
    depthWrite: false,
    uniforms: { tScene: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uStride: { value: 1.5 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene; uniform vec2 uTexel; uniform float uStride;
      varying vec2 vUv;
      void main() {
        vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
        vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
        vec3 h0 = vec3(0.0), h1 = vec3(0.0), h2 = vec3(0.0), h3 = vec3(0.0);
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec3 c = texture2D(tScene, vUv + vec2(float(i), float(j)) * uTexel * uStride * 2.0).rgb;
            vec3 q = c / (1.0 + c);
            if (i <= 0 && j <= 0) { m0 += c; s0 += q; h0 += q * q; }
            if (i >= 0 && j <= 0) { m1 += c; s1 += q; h1 += q * q; }
            if (i <= 0 && j >= 0) { m2 += c; s2 += q; h2 += q * q; }
            if (i >= 0 && j >= 0) { m3 += c; s3 += q; h3 += q * q; }
          }
        }
        const float n = 4.0;
        vec3 v0 = h0 / n - (s0 / n) * (s0 / n);
        vec3 v1 = h1 / n - (s1 / n) * (s1 / n);
        vec3 v2 = h2 / n - (s2 / n) * (s2 / n);
        vec3 v3 = h3 / n - (s3 / n) * (s3 / n);
        float e0 = v0.r + v0.g + v0.b, e1 = v1.r + v1.g + v1.b, e2 = v2.r + v2.g + v2.b, e3 = v3.r + v3.g + v3.b;
        vec3 col = m0; float e = e0;
        if (e1 < e) { e = e1; col = m1; }
        if (e2 < e) { e = e2; col = m2; }
        if (e3 < e) { e = e3; col = m3; }
        gl_FragColor = vec4(col / n, 1.0);
      }`,
  })
}

/** Bloom: bright-pass downsample (4 taps) and a separable 9-tap blur, all at 1/4 resolution. */
export function createBloomMaterials(): { bright: THREE.ShaderMaterial; blur: THREE.ShaderMaterial } {
  const vs = /* glsl */ `varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`
  const bright = new THREE.ShaderMaterial({
    name: 'BloomBright',
    depthTest: false,
    depthWrite: false,
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uThreshold: { value: 1.4 } },
    vertexShader: vs,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; varying vec2 vUv;
      void main() {
        vec3 c = 0.25 * (texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
                       + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float k = smoothstep(uThreshold, uThreshold * 2.0, l);
        gl_FragColor = vec4(min(c * k, vec3(8.0)), 1.0);
      }`,
  })
  const blur = new THREE.ShaderMaterial({
    name: 'BloomBlur',
    depthTest: false,
    depthWrite: false,
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) } },
    vertexShader: vs,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 0.2270;
        c += (texture2D(tSrc, vUv + uDir * 1.3846).rgb + texture2D(tSrc, vUv - uDir * 1.3846).rgb) * 0.3162;
        c += (texture2D(tSrc, vUv + uDir * 3.2308).rgb + texture2D(tSrc, vUv - uDir * 3.2308).rgb) * 0.0703;
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
  return { bright, blur }
}
