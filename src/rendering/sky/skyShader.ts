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
  uSkyClouds: { value: 0.4 },
  /** 0 = painted violet/gold clouds (dusk), 1 = Genshin white cumulus with soft blue-grey shading (day). */
  uSkyCloudWhite: { value: 0 },
  uSkyTime: { value: 0 },
  /** Lightning: direction to the bolt and its flash (clouds around it light up from inside). */
  uSkyBoltDir: { value: new THREE.Vector3(0, 1, 0) },
  uSkyBolt: { value: 0 },
  uSkyBoltColor: { value: new THREE.Color(1, 0.3, 0.4) },
  /** Aerial-perspective haze: x = max amount (0..1), y = distance scale (m). */
  uSkyHaze: { value: new THREE.Vector2(0.4, 110) },
}

export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyHorizon, uSkyZenith, uSkySunDir, uSkySunColor, uSkyMoonDir, uSkyMoonColor;
uniform float uSkySunVis, uSkyMoonVis, uSkyStars, uSkyClouds, uSkyTime, uSkyBolt, uSkyCloudWhite;
uniform vec3 uSkyBoltDir, uSkyBoltColor;
uniform vec2 uSkyHaze;
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
  vec3 col = mix(horizon, uSkyZenith, pow(up, 0.45));
  col = mix(horizon, col, smoothstep(-0.02, 0.06, d.y));

  // Sun: crisp pale-gold disc + small halo (no wide wash — the reference sun is a clean disc).
  float s = max(dot(d, uSkySunDir), 0.0);
  vec3 sunDisc = mix(uSkySunColor, vec3(1.0, 0.95, 0.8), 0.6);
  // The hard disc only on the dome (full): fog/reflections use the soft glow (safe to evaluate per vertex).
  col += uSkySunVis * ((full ? sunDisc * smoothstep(0.99935, 0.9996, s) * 6.0 : vec3(0.0)) + uSkySunColor * (pow(s, 600.0) * 1.2 + pow(s, 40.0) * 0.18));

  // Moon disc + halo.
  float m = max(dot(d, uSkyMoonDir), 0.0);
  float disc = smoothstep(0.99955, 0.9998, m);
  col += uSkyMoonColor * uSkyMoonVis * (disc * 3.2 * (0.75 + 0.25 * sky_h3(floor(d * 900.0))) + pow(m, 300.0) * 0.5 + pow(m, 18.0) * 0.08);

  vec3 keyDir = uSkySunVis > 0.01 ? uSkySunDir : uSkyMoonDir;
  vec3 keyCol = uSkySunVis > 0.01 ? uSkySunColor * uSkySunVis : uSkyMoonColor * uSkyMoonVis * 0.4;

  if (full) {
    if (uSkyStars > 0.001) {
      float h = sky_h3(floor(d * 420.0));
      float star = step(0.9984, h) * smoothstep(0.02, 0.25, d.y) * (0.6 + 0.4 * sin(uSkyTime * (1.5 + h * 4.0) + h * 40.0));
      col += vec3(0.75, 0.82, 1.0) * star * uSkyStars * (0.7 + 1.2 * fract(h * 97.0)) * (1.0 - disc);
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
      cloud = mix(cloud, white, uSkyCloudWhite);
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
  float slope = (ridgeFar(az + 0.03) - ridgeFar(az - 0.03)) * 0.65; // wide stencil → broad faces, not stripes
  float towardSun = sign(atan(sin(az - sunAz), cos(az - sunAz)));
  float litFace = smoothstep(-0.004, 0.02, slope * towardSun) * uSkySunVis;
  vec3 cool = mix(uSkyZenith, uSkyHorizon, 0.5) * vec3(0.7, 0.72, 0.95);
  if (d.y < hFar) {
    float streak = sky_noise(vec2(az * 160.0, d.y * 22.0)) * 0.6 + sky_noise(vec2(az * 420.0, d.y * 60.0)) * 0.4;
    vec3 rock = cool * (0.72 + 0.22 * streak);
    vec3 lit = rock * 0.75 + uSkySunColor * 0.22;
    vec3 mc = mix(rock, lit, litFace * 0.7);
    mc += keyCol * smoothstep(hFar - 0.008, hFar, d.y) * 0.25 * (0.4 + litFace);   // bright ridge line
    float haze = exp(-max(d.y, 0.0) / max(hFar, 1e-3) * 3.2);
    col = mix(mc, horizon, haze * 0.6);
  }
  float hNear = ridgeNear(az) * 0.6;
  if (d.y < hNear) {
    vec3 mc = mix(uSkyZenith, horizon, 0.35) * vec3(0.42, 0.5, 0.56);                 // dark blue-teal forested hills
    mc += keyCol * smoothstep(hNear - 0.004, hNear, d.y) * 0.15;
    col = mix(mc, horizon, exp(-max(d.y, 0.0) / max(hNear, 1e-3) * 2.2) * 0.55);
  }
  return col;
}
`
