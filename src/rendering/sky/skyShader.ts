import * as THREE from 'three'

/**
 * The sky as a function of world direction, shared by the sky dome AND the fog of every world material.
 * Fully fogged geometry therefore shows exactly the sky behind it — gradient, sun/moon glow, the sunset band
 * and the mountain ridges — so distant hills and tree lines dissolve into the sky instead of hiding the
 * mountains and low sun behind a flat fog-coloured wall (refer/roads hero composition).
 * `full` adds the parts only the dome needs (stars, clouds).
 */
export const skyUniforms = {
  uSkyHorizon: { value: new THREE.Color() },
  uSkyZenith: { value: new THREE.Color() },
  uSkySunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSkySunColor: { value: new THREE.Color() },
  uSkySunVis: { value: 1 },
  uSkyMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uSkyMoonColor: { value: new THREE.Color() },
  uSkyMoonVis: { value: 0 },
  uSkyStars: { value: 0 },
  /** 1 while the sky is drawn into the low-res target (SkyDome.prepare): stars are added at full res instead. */
  uSkyLowRes: { value: 0 },
  uSkyClouds: { value: 0.4 },
  /** 0 = painted violet/gold clouds (dusk), 1 = Genshin white cumulus with soft blue-grey shading (day). */
  uSkyCloudWhite: { value: 0 },
  /** Storm 0..1: clouds become a dark grey overcast lid (weather). */
  uSkyStorm: { value: 0 },
  uSkyTime: { value: 0 },
  /** Lightning: direction to the bolt and its flash (clouds around it light up from inside). */
  uSkyBoltDir: { value: new THREE.Vector3(0, 1, 0) },
  uSkyBolt: { value: 0 },
  uSkyBoltColor: { value: new THREE.Color(1, 0.3, 0.4) },
  /** Aerial-perspective haze: x = max amount (0..1), y = distance scale (m). */
  uSkyHaze: { value: new THREE.Vector2(0.4, 110) },
  /** Horizon → zenith falloff exponent (smaller = the deep zenith colour starts lower: Genshin's azure sky). */
  uSkyCurve: { value: 0.45 },
  /** Genshin cumulus (1): round puffy white clouds with sunlit tops and soft blue-grey bellies; 0 = painted streaks. */
  uSkyCumulus: { value: 0 },
  /** Cloud edge softness: wider when the sky is drawn at low resolution (LOW: 0.25×) so edges never stair-step. */
  uSkyEdge: { value: 0.07 },
  /** Volumetric ground MIST (exponential height fog): x density at the base, y base height (m), z falloff (1/m), w camera height. */
  uSkyMist: { value: new THREE.Vector4(0, -2, 0.09, 0) },
}

/**
 * VOLUMETRIC MIST, analytic: fog density ρ(y) = ρ0·exp(−(y − y0)·f) integrated in closed form along the view
 * ray from the camera to a point `dist` away — real height-dependent fog (pools in valleys and over lakes, thins
 * up the hills, a clear view from a summit) for ~10 ALU per fragment on every tier, no march. Shared by every
 * world material (stylize), the sky dome, the water and the shafts pass (which adds the drifting banks on top).
 */
export const MIST_GLSL = /* glsl */ `
uniform vec4 uSkyMist;
float mistAmount(vec3 dir, float dist) {
  if (uSkyMist.x <= 0.0) return 0.0;
  float f = uSkyMist.z;
  float dy = dir.y;
  float d0 = uSkyMist.x * exp(-(uSkyMist.w - uSkyMist.y) * f);
  // ∫₀ᴸ ρ0·e^(−(camY + dy·t − y0)·f) dt = d0·(1 − e^(−dy·f·L)) / (dy·f)   (→ d0·L as dy → 0)
  float e = min(-dy * f * dist, 40.0);
  float t = abs(dy) > 1e-3 ? (1.0 - exp(e)) / (dy * f) : dist;
  return 1.0 - exp(-d0 * max(t, 0.0));
}`

export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyHorizon, uSkyZenith, uSkySunDir, uSkySunColor, uSkyMoonDir, uSkyMoonColor;
uniform float uSkySunVis, uSkyMoonVis, uSkyStars, uSkyClouds, uSkyTime, uSkyBolt, uSkyCloudWhite, uSkyStorm, uSkyLowRes, uSkyEdge;
uniform vec3 uSkyBoltDir, uSkyBoltColor;
uniform vec2 uSkyHaze;
uniform float uSkyCurve;
uniform float uSkyCumulus;
// Layered depth haze on top of the distance fog (refer/roads: trees 40–150 m soften into blue-violet air).
float skyHaze(float d) { return uSkyHaze.x * (1.0 - exp(-max(d - 12.0, 0.0) / uSkyHaze.y)); }

float sky_h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sky_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sky_h2(i), sky_h2(i + vec2(1, 0)), f.x), mix(sky_h2(i + vec2(0, 1)), sky_h2(i + vec2(1, 1)), f.x), f.y);
}
float sky_h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

float angDist(float a, float c) { return atan(sin(a - c), cos(a - c)); }
float ridgeFar(float az) {
  float h = 0.1 + 0.03 * sin(az * 3.0 + 1.3) + 0.02 * sin(az * 7.0 + 0.4) + 0.008 * sin(az * 19.0 + 2.1);
  float dm = angDist(az, 2.42);
  float m = exp(-dm * dm / (0.55 * 0.55));
  // Jagged cliff skyline: stacked sawtooth peaks + fine crags.
  h += m * (0.33 + 0.06 * sin(az * 23.0) + 0.09 * abs(fract(az * 4.3) - 0.5) + 0.05 * abs(fract(az * 11.0 + 0.3) - 0.5) + 0.02 * sky_noise(vec2(az * 120.0, 7.0)));
  float dl = angDist(az, 1.1);
  h += exp(-dl * dl / 0.25) * 0.08;                                     // secondary range left of the sun
  float ds = angDist(az, 2.0);
  h = mix(0.075 + 0.01 * sin(az * 30.0), h, smoothstep(0.06, 0.3, abs(ds))); // low hazy hill under the sunset
  return h;
}
float ridgeNear(float az) {
  float h = 0.045 + 0.02 * sin(az * 5.0 + 2.0) + 0.012 * sin(az * 13.0 + 1.1);
  h += 0.006 * sky_noise(vec2(az * 260.0, 3.0)) + 0.003 * sky_noise(vec2(az * 900.0, 1.0)); // treeline serration
  return h * mix(0.7, 1.0, smoothstep(0.05, 0.3, abs(angDist(az, 2.0))));
}

vec3 skyColor(vec3 d, bool full) {
  float up = max(d.y, 0.0);
  vec3 dh = normalize(vec3(d.x, 0.0, d.z) + 1e-5);
  vec3 sh = normalize(vec3(uSkySunDir.x, 0.0, uSkySunDir.z) + 1e-5);
  // Directional horizon (refer/roads hero): warm peach toward a low sun, cool blue-violet away from it.
  float sunward = pow(max(dot(dh, sh), 0.0), 2.0) * uSkySunVis * (1.0 - smoothstep(0.15, 0.6, uSkySunDir.y));
  // Warm = the sun's own orange/peach (not a blend with the cool horizon — that goes pink).
  vec3 warm = uSkySunColor * vec3(1.0, 0.82, 0.62) * 1.05;
  vec3 horizon = mix(uSkyHorizon, warm, sunward);
  vec3 col = mix(horizon, uSkyZenith, pow(up, uSkyCurve));
  col = mix(horizon, col, smoothstep(-0.02, 0.06, d.y));
  // Genshin: a thin, bright, almost white HORIZON GLOW band (the sky seen through the most air) under the azure —
  // distant ranges melt into it.
  if (uSkyCumulus > 0.5) col = mix(col, mix(horizon, vec3(1.0), 0.45), exp(-up * 16.0) * 0.6 * uSkySunVis);

  // Sun: crisp pale-gold disc + small halo (no wide wash — the reference sun is a clean disc).
  float s = max(dot(d, uSkySunDir), 0.0);
  vec3 sunDisc = mix(uSkySunColor, vec3(1.0, 0.95, 0.8), 0.6);
  // The hard disc only on the dome (full): fog/reflections use the soft glow (safe to evaluate per vertex).
  // (Genshin: a tighter glow — the wide one washed a quarter of the sky to pale grey-blue.)
  float wideGlow = uSkyCumulus > 0.5 ? pow(s, 160.0) * 0.12 : pow(s, 40.0) * 0.18;
  col += uSkySunVis * ((full ? sunDisc * smoothstep(0.99935, 0.9996, s) * 6.0 : vec3(0.0)) + uSkySunColor * (pow(s, 600.0) * 1.2 + wideGlow));

  // Moon disc + halo.
  float m = max(dot(d, uSkyMoonDir), 0.0);
  float disc = smoothstep(0.99955, 0.9998, m);
  col += uSkyMoonColor * uSkyMoonVis * (disc * 3.2 * (0.75 + 0.25 * sky_h3(floor(d * 900.0))) + pow(m, 300.0) * 0.5 + pow(m, 18.0) * 0.08);

  vec3 keyDir = uSkySunVis > 0.01 ? uSkySunDir : uSkyMoonDir;
  vec3 keyCol = uSkySunVis > 0.01 ? uSkySunColor * uSkySunVis : uSkyMoonColor * uSkyMoonVis * 0.4;

  if (full) {
    if (uSkyStars > 0.001 && uSkyLowRes < 0.5) {
      float h = sky_h3(floor(d * 420.0));
      float star = step(0.9984, h) * smoothstep(0.02, 0.25, d.y) * (0.6 + 0.4 * sin(uSkyTime * (1.5 + h * 4.0) + h * 40.0));
      // Never over a bright sky: on a pale dawn/evening gradient twinkling stars read as blinking white specks.
      float dark = 1.0 - smoothstep(0.035, 0.14, dot(col, vec3(0.3, 0.59, 0.11)));
      col += vec3(0.75, 0.82, 1.0) * star * uSkyStars * dark * (0.7 + 1.2 * fract(h * 97.0)) * (1.0 - disc);
    }
    if (uSkyClouds > 0.01 && d.y > 0.0) {
      vec2 p = d.xz / (d.y + 0.12) * 1.6 + vec2(uSkyTime * 0.004, uSkyTime * 0.0015);
      float n = sky_noise(p) * 0.55 + sky_noise(p * 2.3 + 3.1) * 0.3 + sky_noise(p * 5.1 + 7.7) * 0.15;
      float cov = smoothstep(1.0 - uSkyClouds, 1.0 - uSkyClouds + 0.28, n) * smoothstep(0.0, 0.18, d.y);
      float toward = pow(max(dot(d, keyDir), 0.0), 3.0);
      // Painted clouds: violet bodies, gold/orange undersides toward the sun.
      vec3 cloud = mix(uSkyZenith * 1.1, horizon, 0.35) + keyCol * (0.15 + 1.1 * toward) * (0.6 + 0.4 * (1.0 - n));
      // Day: puffy white cumulus — bright sunlit tops, soft lavender-blue shaded bellies, silver lining toward the sun.
      float body = smoothstep(1.0 - uSkyClouds, 1.0, n);
      vec3 white = mix(vec3(0.62, 0.7, 0.88), vec3(1.08, 1.06, 1.02), smoothstep(0.1, 0.75, body + 0.25 * (n - sky_noise(p * 2.3 + vec2(0.4, 0.9)))));
      white += uSkySunColor * toward * 0.35;
      if (uSkyCumulus > 0.5) {
        // GENSHIN CUMULUS: big rounded puffs (low-frequency weighted, a narrow soft edge → defined but soft outlines),
        // lit from the sun's side (a second sample offset toward the sun: brighter where the puff faces it), bright
        // white tops over soft blue-grey bellies, a silver rim toward the sun.
        vec2 q = p * 0.95;
        float b = sky_noise(q) * 0.62 + sky_noise(q * 2.1 + 5.3) * 0.26 + sky_noise(q * 4.7 + 1.7) * 0.12;
        // Clouds pile up LOW over the horizon (big banks there, a few puffs overhead) as in Genshin's skies.
        float heap = uSkyClouds * mix(1.45, 0.75, smoothstep(0.05, 0.55, d.y));
        cov = smoothstep(1.0 - heap, 1.0 - heap + uSkyEdge, b) * smoothstep(0.02, 0.1, d.y);
        vec2 sd = normalize(keyDir.xz + 1e-4) * 0.09;
        vec2 qs = q + sd;
        float bs = sky_noise(qs) * 0.62 + sky_noise(qs * 2.1 + 5.3) * 0.26 + sky_noise(qs * 4.7 + 1.7) * 0.12;
        float lit = clamp(0.55 + (bs - b) * 6.0 + smoothstep(1.0 - uSkyClouds, 1.0, b) * 0.3, 0.0, 1.0);
        white = mix(vec3(0.66, 0.74, 0.88), vec3(1.12, 1.11, 1.08), lit) + uSkySunColor * toward * 0.25;
      }
      cloud = mix(cloud, white, uSkyCloudWhite);
      // Storm: a heavy grey lid — dark bellies, ragged lighter edges, coverage pushed toward total.
      if (uSkyStorm > 0.01) {
        vec3 lid = mix(vec3(0.34, 0.36, 0.4), vec3(0.16, 0.17, 0.2), smoothstep(0.2, 0.9, n)) * (0.85 + 0.3 * sky_noise(p * 3.7 + 1.3));
        cloud = mix(cloud, lid * (0.5 + 0.5 * uSkyHorizon.g / max(uSkyHorizon.g, 0.02)), uSkyStorm);
        cov = max(cov, uSkyStorm * smoothstep(0.05, 0.5, n + 0.35 * uSkyStorm) * smoothstep(0.0, 0.12, d.y));
      }
      col = mix(col, cloud, cov * mix(0.9, 0.97, uSkyCloudWhite));
      // Lightning inside the clouds: bright where they are thick and near the bolt, dim far from it.
      float near = pow(max(dot(d, uSkyBoltDir), 0.0), 6.0);
      col += uSkyBoltColor * uSkyBolt * (0.15 + cov * 2.2) * (0.1 + 1.8 * near) * smoothstep(0.0, 0.1, d.y);
    }
  }

  // Mountains (refer/roads hero): a rocky CLIFF MASSIF to the right of the sunset, a low hazy hill the sun
  // sits on, rolling ranges elsewhere, and dark forested foothills in front. Faces turned toward the sun are
  // lit warm, the others cool; vertical rock streaks; haze thickens toward each range's base.
  float az = atan(d.z, d.x);
  float sunAz = atan(uSkySunDir.z, uSkySunDir.x);
  // Real hills/mountains now come from the horizon terrain; the painted ranges are only the farthest backdrop.
  float hFar = ridgeFar(az) * 0.65;
  float slope = (ridgeFar(az + 0.12) - ridgeFar(az - 0.12)) * 0.65; // very wide stencil → whole mountain faces, no crag stripes
  float towardSun = sign(atan(sin(az - sunAz), cos(az - sunAz)));
  float litFace = smoothstep(-0.01, 0.06, slope * towardSun) * uSkySunVis;
  // Distant ranges read as LAND seen through air (Genshin): hazy blue-green-grey, darker than the sky,
  // broad soft light/shadow faces (no fine vertical streaks — they read as white stripes).
  vec3 cool = mix(uSkyZenith, uSkyHorizon, 0.55) * vec3(0.5, 0.62, 0.66);
  if (d.y < hFar) {
    float streak = sky_noise(vec2(az * 22.0, d.y * 5.0)) * 0.7 + sky_noise(vec2(az * 60.0, d.y * 12.0)) * 0.3;
    vec3 rock = cool * (0.8 + 0.2 * streak);
    // Sun-facing faces: a little warmer/lighter, never white (the sun colour is HDR — keep its share small).
    vec3 lit = rock * 1.18 + uSkySunColor * 0.035;
    vec3 mc = mix(rock, lit, litFace * 0.6);
    mc += keyCol * smoothstep(hFar - 0.006, hFar, d.y) * 0.06 * (0.4 + litFace);   // soft rim on the ridge line
    float haze = exp(-max(d.y, 0.0) / max(hFar, 1e-3) * 3.2);
    col = mix(mc, horizon, haze * 0.45);
  }
  float hNear = ridgeNear(az) * 0.6;
  if (d.y < hNear) {
    vec3 mc = mix(uSkyZenith, horizon, 0.4) * vec3(0.36, 0.5, 0.44);                  // dark green-teal forested hills
    mc += keyCol * smoothstep(hNear - 0.004, hNear, d.y) * 0.15;
    col = mix(mc, horizon, exp(-max(d.y, 0.0) / max(hNear, 1e-3) * 2.2) * 0.4);
  }
  return col;
}
`
