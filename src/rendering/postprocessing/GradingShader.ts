import * as THREE from 'three'

/**
 * The combined final pass (skills/postprocessing):
 *   scene (linear HDR) → [FXAA + sharpen | nightmare warp + chromatic split] → + god rays
 *   → exposure/tint/lift/saturation → tone mapping → sRGB → contrast, vignette, grain.
 *
 * FXAA (Lottes' PC variant, 9 fetches) runs at scene-RT resolution and its 4 corner fetches are
 * reused for a clamped unsharp-mask: that removes the soft look of bilinear upscaling when the
 * render scale is < 1 — the main source of "blur". Toggled by uniforms (no program variants).
 */
export function createGradingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'GradingPass',
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tScene: { value: null },
      tRays: { value: null },
      tBloom: { value: null },
      uBloom: { value: 0 },
      tDepth: { value: null },
      /** Ambient occlusion (AOShader.ts) and on/off. */
      tAO: { value: null },
      uAO: { value: 0 },
      /** Heat shimmer 0..1 (desert, sun high): distant ground wavers. */
      uHeat: { value: 0 },
      uNear: { value: 0.1 },
      uFar: { value: 300 },
      uFog: { value: new THREE.Vector2(50, 200) },
      uRaysColor: { value: new THREE.Color(0, 0, 0) },
      uVolColor: { value: new THREE.Color(0, 0, 0) },
      /** Fog-bank colour (the mist colour) — banks are composited before the shafts are added. */
      uMistColor: { value: new THREE.Color(0, 0, 0) },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uRaysTexel: { value: new THREE.Vector2(1, 1) },
      /** Shafts / fog banks rendered this frame (PostPipeline.raysActive): else their 5 fetches + 4 exp are skipped. */
      uRaysOn: { value: 0 },
      uFxaa: { value: 1 },
      uSharpen: { value: 0.25 },
      uExposure: { value: 1 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uLift: { value: new THREE.Color(0, 0, 0) },
      uSaturation: { value: 1 },
      uContrast: { value: 1 },
      uVignette: { value: 0.3 },
      uGrain: { value: 0.04 },
      uDistortion: { value: 0 },
      uTime: { value: 0 },
      uAspect: { value: 1 },
      uDebugView: { value: 0 },
      uSplit: { value: 0.5 },
      uFlash: { value: 0 },
      uPaintFx: { value: 0 },
      uDamage: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D tScene, tRays, tDepth, tBloom, tAO;
      uniform float uBloom, uAO, uHeat;
      uniform float uNear, uFar;
      uniform vec2 uFog;
      uniform vec3 uRaysColor, uVolColor, uMistColor, uTint, uLift;
      uniform vec2 uTexel, uRaysTexel;
      uniform float uFxaa, uSharpen, uRaysOn;
      uniform float uExposure, uSaturation, uContrast, uVignette, uGrain, uDistortion, uTime, uAspect;
      uniform int uDebugView;
      uniform float uSplit, uFlash, uDamage, uPaintFx;
      varying vec2 vUv;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      // Luma on a compressed scale so HDR highlights don't dominate edge detection.
      float luma(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return l / (1.0 + l); }

      vec3 antialias(vec2 uv) {
        vec3 rgbM = texture2D(tScene, uv).rgb;
        if (uFxaa < 0.5 && uSharpen < 0.001) return rgbM;
        vec3 rgbNW = texture2D(tScene, uv + vec2(-1.0, -1.0) * uTexel).rgb;
        vec3 rgbNE = texture2D(tScene, uv + vec2( 1.0, -1.0) * uTexel).rgb;
        vec3 rgbSW = texture2D(tScene, uv + vec2(-1.0,  1.0) * uTexel).rgb;
        vec3 rgbSE = texture2D(tScene, uv + vec2( 1.0,  1.0) * uTexel).rgb;
        vec3 col = rgbM;
        if (uFxaa > 0.5) {
          float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
          vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
          float reduce = max((lNW + lNE + lSW + lSE) * (0.25 * 0.125), 1.0 / 128.0);
          float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
          dir = clamp(dir * rcpMin, -8.0, 8.0) * uTexel;
          vec3 a = 0.5 * (texture2D(tScene, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tScene, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
          vec3 b = a * 0.5 + 0.25 * (texture2D(tScene, uv - dir * 0.5).rgb + texture2D(tScene, uv + dir * 0.5).rgb);
          float lB = luma(b);
          col = (lB < lMin || lB > lMax) ? a : b;
        }
        if (uSharpen > 0.001) {
          vec3 avg = 0.25 * (rgbNW + rgbNE + rgbSW + rgbSE);
          vec3 lo = min(rgbM, min(min(rgbNW, rgbNE), min(rgbSW, rgbSE)));
          vec3 hi = max(rgbM, max(max(rgbNW, rgbNE), max(rgbSW, rgbSE)));
          col = clamp(col + (rgbM - avg) * uSharpen * 1.5, lo, hi); // clamped → no halos
        }
        return col;
      }

      void main() {
        vec2 uv = vUv;
        vec3 col;
        // HEAT SHIMMER: distant (40–250 m) solid ground wavers in rising hot air; the sky and the near field don't.
        if (uHeat > 0.01) {
          float hz = texture2D(tDepth, uv).x;
          float hd = hz >= 0.9999 ? 0.0 : smoothstep(40.0, 160.0, -perspectiveDepthToViewZ(hz, uNear, uFar));
          vec2 wob = vec2(sin(uv.y * 260.0 + uTime * 5.0 + sin(uv.x * 40.0 + uTime) * 2.0), sin(uv.x * 190.0 - uTime * 3.7)) * vec2(0.0011, 0.0007);
          uv += wob * hd * uHeat;
        }
        if (uDistortion > 0.001) {
          vec2 d = uv - 0.5;
          float r2 = dot(d, d);
          uv += d * r2 * 0.12 * uDistortion;
          uv.x += sin(uv.y * 24.0 + uTime * 1.7) * 0.0018 * uDistortion;
          vec2 ca = d * 0.006 * uDistortion;
          col = vec3(texture2D(tScene, uv + ca).r, texture2D(tScene, uv).g, texture2D(tScene, uv - ca).b);
        } else {
          col = antialias(uv);
        }
        // Ambient occlusion: contact shadows in creases, under trees and rocks (before the light added on top).
        if (uAO > 0.5) col *= mix(1.0, texture2D(tAO, uv).r, 0.85);
        if (uDebugView == 2) { gl_FragColor = vec4(vec3(uAO > 0.5 ? texture2D(tAO, uv).r : 1.0), 1.0); return; } // AO buffer only
        // Shafts live in the air: full strength over sky / fogged distance, faded over nearby solid
        // geometry (otherwise a backlit tree gets striped by its own rays).
        // Per-pixel extras are uniform branches (one program): skipped when off — the LOW tier on phones runs this
        // pass at full canvas resolution, so every skipped fetch counts there.
        if (uRaysOn > 0.5) {
        float z = texture2D(tDepth, uv).x;
        float air = z >= 0.9999 ? 1.0 : mix(0.2, 1.0, smoothstep(uFog.x, uFog.y, -perspectiveDepthToViewZ(z, uNear, uFar)));
        // Depth-aware (joint bilateral) upsample of the low-res rays RT: 4 taps weighted by how close each
        // tap's stored depth code (B) is to this full-res pixel's → no blocky halos at silhouettes.
        float code0 = z >= 0.9999 ? 1.0 : 1.0 - exp(-(-perspectiveDepthToViewZ(z, uNear, uFar)) / 25.0);
        vec2 ro = uRaysTexel * 0.75;
        vec4 t0 = texture2D(tRays, uv + vec2(ro.x, ro.y));
        vec4 t1 = texture2D(tRays, uv + vec2(-ro.x, ro.y));
        vec4 t2 = texture2D(tRays, uv + vec2(ro.x, -ro.y));
        vec4 t3 = texture2D(tRays, uv - ro);
        vec4 w = vec4(exp(-abs(t0.b - code0) * 40.0), exp(-abs(t1.b - code0) * 40.0), exp(-abs(t2.b - code0) * 40.0), exp(-abs(t3.b - code0) * 40.0)) + 1e-4;
        vec3 rays = (t0.rga * w.x + t1.rga * w.y + t2.rga * w.z + t3.rga * w.w) / (w.x + w.y + w.z + w.w);
        col = mix(col, uMistColor, rays.b); // drifting fog banks (volumetric march), then the light shafts on top
        col += rays.r * uRaysColor * air + rays.g * uVolColor;
        }
        // Bloom: light bleeding around the sun, sky and lit edges (painted glow of the references).
        if (uBloom > 0.0) col += texture2D(tBloom, uv).rgb * uBloom;
        if (uDebugView == 1) { gl_FragColor = vec4(col, 1.0); return; } // raw linear, no grading

        // Lightning flash: the whole scene lights up blue-white for a few frames.
        col *= 1.0 + uFlash * 0.35; // slight exposure pop only — the light itself comes from the scene lights
        col *= uExposure * uTint;
        col += uLift;
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSaturation);

        gl_FragColor = vec4(max(col, 0.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>

        vec3 c = gl_FragColor.rgb;
        // Split toning (painterly): shadows lean blue-violet, highlights lean warm gold.
        float L = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(c, c * vec3(0.88, 0.96, 1.12) + vec3(0.0, 0.012, 0.03), (1.0 - L) * (1.0 - L) * uSplit); // teal-blue shadows
        c += vec3(0.07, 0.04, -0.02) * L * L * uSplit;
        c = (c - 0.5) * uContrast + 0.5;
        vec2 v = (vUv - 0.5) * vec2(uAspect, 1.0);
        c *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(v) * 1.35);
        // Damage: red pulse creeping in from the edges.
        float dv = smoothstep(0.2, 1.0, length(v) * 1.4) * uDamage;
        c = mix(c, vec3(0.55, 0.02, 0.02), dv * 0.8);
        // Painted canvas: static diagonal brush-streak texture in the midtones (not animated film grain).
        if (uPaintFx > 0.5) { // canvas texture + grain only with the painterly look (off = clean, Genshin-style)
          vec2 px = vUv / vec2(1.0, uAspect) * 900.0;
          float streak = hash(floor(vec2(px.x * 0.35 + px.y * 0.9, px.y * 0.35 - px.x * 0.2)));
          c += (streak - 0.5) * 0.03 * (1.0 - abs(L - 0.5) * 1.6);
          // STATIC grain (fixed per pixel): texture without the whole-screen shimmer animated grain caused.
          c += (hash(vUv * 1024.0) - 0.5) * uGrain * 0.35;
        }
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }
    `,
  })
}
