/**
 * SURFACE ROUGHNESS — real procedural noise for the near field (2026-10-24, every map and style).
 *
 * The recipe of procedural rock / ground shading (Gustavson & McEwan, "GPU procedural shading"; Ebert et al.,
 * "Texturing & Modeling"): a HEIGHT FIELD built from 3D SIMPLEX NOISE with ANALYTIC DERIVATIVES (fBm for grit and
 * lumps, RIDGED multifractal for ledges), WORLEY (cellular) noise for fractures and pebbles, and the summed gradient
 * TILTING THE NORMAL — the light itself shows the roughness, at any angle, with no texture image and no seam (3D,
 * world space: no tri-planar projection). Simplex noise has no lattice / grid look, unlike the old value noise.
 *
 * One PROFILE per kind of place — they must not feel the same:
 *   ROCK   (boulders, tors, pillars): soft 2 m lumps, granular grit down to ~5 cm, fine fractures (Worley edges)
 *   CLIFF  (cliff faces, formations, crag walls): horizontal BEDS as ridged ledges, vertical weathering flutes,
 *          blocky jointing (big Worley cells), grit
 *   GROUND (soil, banks, dry ground): crumbly soil clods + loose GRAVEL (two Worley pebble layers, domed, each its
 *          own tone, contact-shadowed) — denser on bare ground and banks
 *   ROAD   (dirt tracks): packed fine grit, smoother in the wheel ruts, loose small stones on the shoulders
 * Each returns an albedo factor and sets `surfBump` (world-space normal offset). Detail fades out with distance
 * (no aliasing, no cost far away); LOW (uSurfaceDetail = 0) skips it.
 *
 * Cost (fragment, inside the near band): rock ≈ 6 simplex + 1 Worley 3D; cliff ≈ 7 simplex + 1 Worley 3D; ground ≈ 3
 * simplex + 2 Worley 2D; road ≈ 2 simplex + 1 Worley 2D. Simplex 3D ≈ 90 ALU, Worley 3D (27 cells) ≈ 300 ALU.
 */
export const SURFACE_NOISE_GLSL = /* glsl */ `
// (SN_DETAIL_K: × the stones' and grit's own colour contrast and the loose stones' domes — the grit relief stays; a material may bind it to a uniform
//  before this block: the PlayCanvas terrain's look, uDetailK)
#ifndef SN_DETAIL_K
#define SN_DETAIL_K 1.0
#endif
// ---- 3D simplex noise with analytic gradient (Ashima Arts / Stefan Gustavson, MIT licence: webgl-noise noise3Dgrad)
vec3 sn_m289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 sn_m289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 sn_perm(vec4 x) { return sn_m289(((x * 34.0) + 10.0) * x); }
float snoise3(vec3 v, out vec3 gradient) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = sn_m289(i);
  vec4 p = sn_perm(sn_perm(sn_perm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 temp = m2 * m * pdotx;
  gradient = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
  gradient += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  gradient *= 105.0;
  return 105.0 * dot(m4, pdotx);
}
// fBm: value (≈ −1..1) and its gradient d/dp (each octave rotated off the lattice by an offset)
float sn_fbm(vec3 p, int oct, float lac, float gain, out vec3 g) {
  float a = 1.0, f = 1.0, s = 0.0, w = 0.0; vec3 gi; g = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    s += a * snoise3(p * f + float(i) * vec3(17.31, 9.77, 23.13), gi);
    g += a * f * gi; w += a;
    f *= lac; a *= gain;
  }
  g /= w;
  return s / w;
}
// Ridged multifractal: sharp crests (1 − |n|)², the next octave weighted by the last (ledges, not bumps). 0..1.
float sn_ridged(vec3 p, int oct, out vec3 g) {
  float a = 0.5, f = 1.0, s = 0.0, prev = 1.0; vec3 gi; g = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    if (i >= oct) break;
    float n = snoise3(p * f + float(i) * vec3(31.7, 13.1, 7.9), gi);
    float r = 1.0 - abs(n);
    s += a * prev * r * r;
    g += a * prev * 2.0 * r * (-sign(n)) * gi * f;
    prev = clamp(r * r, 0.0, 1.0);
    f *= 2.1; a *= 0.5;
  }
  return s;
}
vec3 sn_hash3(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
vec2 sn_hash2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
// Worley 3D: x = F1, y = F2 (cell units); e1 / e2 = from the nearest / second feature point to p
vec2 sn_worley3(vec3 p, out vec3 e1, out vec3 e2) {
  vec3 ip = floor(p), fp = fract(p);
  float f1 = 9.0, f2 = 9.0; e1 = vec3(0.0); e2 = vec3(0.0);
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 c = vec3(float(i), float(j), float(k));
    vec3 d = fp - c - sn_hash3(ip + c);
    float dd = dot(d, d);
    if (dd < f1) { f2 = f1; e2 = e1; f1 = dd; e1 = d; } else if (dd < f2) { f2 = dd; e2 = d; }
  }
  return sqrt(vec2(f1, f2));
}
// Worley 2D: x = F1 (cell units), y = the nearest cell's hash; e = from its feature point to p
vec2 sn_worley2(vec2 p, out vec2 e) {
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 9.0, id = 0.0; e = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = vec2(float(i), float(j));
    vec2 hp = sn_hash2(ip + c);
    vec2 d = fp - c - hp;
    float dd = dot(d, d);
    if (dd < f1) { f1 = dd; e = d; id = fract(hp.x * 7.13 + hp.y * 3.71); }
  }
  return vec2(sqrt(f1), id);
}
// A FRACTURE groove along the Worley cell edges: height (≤ 0) and its gradient; w = width (cell units)
// Real joints are not a paving pattern: the cell edges are WARPED (wiggling, uneven), most of them MASKED out (a crack
// runs, stops, branches) and their width varies along them.
float sn_fracture(vec3 q, float w, out vec3 g) {
  vec3 gw, gm;
  vec3 wq = q + vec3(snoise3(q * 0.7 + 4.1, gw), snoise3(q * 0.7 + 9.7, gw), snoise3(q * 0.7 + 2.3, gw)) * 0.1;
  float mask = smoothstep(0.05, 0.45, snoise3(q * 0.45 + 7.7, gm));
  g = vec3(0.0);
  if (mask <= 0.0) return 0.0;
  vec3 e1, e2;
  vec2 f = sn_worley3(wq, e1, e2);
  float wv = w * (0.5 + mask);
  float t = clamp((f.y - f.x) / wv, 0.0, 1.0);
  float s = (1.0 - t * t * (3.0 - 2.0 * t)) * mask;
  vec3 ge = e2 / max(f.y, 1e-4) - e1 / max(f.x, 1e-4); // ∇(F2 − F1)
  g = (t > 0.0 && t < 1.0 ? 6.0 * t * (1.0 - t) / wv : 0.0) * ge * mask; // −d(−s)/dq
  return -s;
}

vec3 surfBump = vec3(0.0);
// tangent part of a world gradient, as a normal offset (height h over the surface → n' = n − ∇h_t)
vec3 sn_tilt(vec3 G, vec3 n) { return -(G - dot(G, n) * n); }

// ---- ROCK: weathered stone (boulders, tors, pillars)
vec3 surfRock(vec3 c, vec3 wp, vec3 n, float dist) {
  surfBump = vec3(0.0);
  vec3 g0;
  float wea = snoise3(wp * 0.12, g0); // ~8 m weathering patches (every tier, every distance)
  float k = 1.0 + 0.1 * wea;
  float near = uSurfaceDetail > 0.5 ? 1.0 - smoothstep(30.0, 80.0, dist) : 0.0;
  if (near > 0.0) {
    vec3 gL, gG, gF;
    float lumps = sn_fbm(wp * 0.5, 2, 2.2, 0.5, gL);             // ~2 m soft lumps
    float grit = sn_fbm(wp * 4.0, 3, 2.3, 0.55, gG);             // 25 cm → 5 cm grain
    float fr = dist < 30.0 ? sn_fracture(wp * 0.8, 0.05, gF) : 0.0; // ~1.2 m cracks
    if (dist >= 30.0) gF = vec3(0.0);
    vec3 G = gL * (0.5 * 0.12) + gG * (4.0 * 0.016) + gF * (0.8 * 0.035) * (1.0 - smoothstep(20.0, 30.0, dist));
    surfBump = sn_tilt(G, n) * near;
    k *= 1.0 + (0.12 * lumps + 0.1 * grit + 0.3 * fr) * near * SN_DETAIL_K;
  }
  return c * k;
}

// ---- CLIFF: big rock faces (terrain cliffs, formations, crag walls)
vec3 surfCliff(vec3 c, vec3 wp, vec3 n, float dist) {
  surfBump = vec3(0.0);
  vec3 gW, gB, gM;
  // a strong warp so the beds break, wander and pinch out instead of running as even stripes
  float warp = snoise3(wp * vec3(0.03, 0.06, 0.03), gW);
  vec3 q = wp + vec3(warp * 6.0, warp * 3.5, -warp * 6.0);
  float beds = sn_ridged(q * vec3(0.05, 0.16, 0.05), 2, gB);    // ~6 m beds, broken: faint ledges
  // irregular rock MASSES (≈ 4 m → 2 m bulges): the face is lumpy stone, not a sheet
  float mass = sn_fbm(wp * 0.25, 2, 2.1, 0.5, gM);
  float k = 0.9 + 0.12 * beds + 0.12 * mass;
  float near = uSurfaceDetail > 0.5 ? 1.0 - smoothstep(60.0, 160.0, dist) : 0.0;
  if (near > 0.0) {
    vec3 gFl, gG, gJ;
    float flutes = sn_fbm(wp * vec3(0.4, 0.07, 0.4), 2, 2.0, 0.5, gFl); // vertical weathering runnels
    vec3 G = gB * vec3(0.05, 0.16, 0.05) * 0.5 + gM * 0.25 * 0.7 + gFl * vec3(0.4, 0.07, 0.4) * 0.15;
    float close = 1.0 - smoothstep(35.0, 60.0, dist);
    if (close > 0.0) {
      float grit = sn_fbm(wp * 3.0, 3, 2.3, 0.55, gG);          // 33 cm → 6 cm grit
      float joint = sn_fracture(wp * 0.35, 0.05, gJ);           // ~3 m blocky jointing
      G += (gG * 3.0 * 0.05 + gJ * 0.35 * 0.15) * close;
      k *= 1.0 + (0.1 * grit + 0.3 * joint) * close * SN_DETAIL_K;
    }
    surfBump = sn_tilt(G, n) * near;
    k *= 1.0 + 0.08 * flutes * near;
  }
  return c * k;
}

// ---- GROUND: soil clods + loose gravel; bare = how much bare earth shows (0 lush grass … 1 bare / bank)
vec3 surfGround(vec3 c, vec3 wp, vec3 n, float dist, float bare) {
  surfBump = vec3(0.0);
  float near = uSurfaceDetail > 0.5 ? (1.0 - smoothstep(16.0, 42.0, dist)) * bare : 0.0;
  if (near <= 0.0) return c;
  vec3 gS;
  float soil = sn_fbm(wp * 1.4, 3, 2.4, 0.5, gS);             // 70 cm → 12 cm clods
  vec3 G = gS * 1.4 * 0.03;
  float k = 1.0 + 0.16 * soil * SN_DETAIL_K;
  // GRAVEL: two Worley layers (≈ 38 cm and 14 cm cells); a kept cell holds one domed stone of its own size and tone
  for (int s = 0; s < 2; s++) {
    float sc = s == 0 ? 2.6 : 7.0;
    vec2 e;
    vec2 w = sn_worley2(wp.xz * sc + float(s) * 41.7, e);
    float keep = step(s == 0 ? 0.62 : 0.45, w.y) * smoothstep(0.55, 0.85, bare); // (stones only on really bare earth)
    float r = 0.26 + 0.16 * fract(w.y * 13.7);
    float dd = w.x / r;
    if (keep > 0.0 && dd < 1.0) {
      float dome = sqrt(max(1.0 - dd * dd, 0.02));
      vec2 sl = -e / (r * r * dome) * 0.55 * r / sc;              // ∂h/∂xz of a 0.55-flat dome, in metres
      G += vec3(sl.x, 0.0, sl.y) * sc * keep * SN_DETAIL_K;
      vec3 stone = mix(vec3(0.44, 0.41, 0.37), c * 1.3, 0.3) * (0.72 + 0.5 * fract(w.y * 29.3));
      c = mix(c, stone * (0.75 + 0.3 * dome), keep * smoothstep(1.0, 0.85, dd) * SN_DETAIL_K);
    } else if (keep > 0.0) {
      k *= 1.0 - 0.22 * keep * (1.0 - smoothstep(1.0, 1.35, dd)) * SN_DETAIL_K; // contact shadow round it
    }
  }
  surfBump = sn_tilt(G, n) * near;
  return c * mix(1.0, k, near);
}

// ---- TURF: natural ground relief — a small version of the rock's (surfRock) (2026-10-25, the user: "no white dots
// and lines, just natural noise in the ground like the snow, or a small version of the rock"): soft ~2 m swells,
// ~60 cm lumps and ~10 cm grit, all smooth simplex fBm (no cells, no terraces, no stones), tilting the normal so the
// light picks it out, with a faint matching light / dark. bare (0 lush … 1 bare earth) makes it a little rougher.
vec3 surfTurf(vec3 c, vec3 wp, vec3 n, float dist, float bare) {
  surfBump = vec3(0.0);
  float near = uSurfaceDetail > 0.5 ? 1.0 - smoothstep(30.0, 70.0, dist) : 0.0;
  if (near <= 0.0) return c;
  vec3 gS, gL, gG;
  float swell = sn_fbm(wp * 0.45, 2, 2.1, 0.5, gS);             // ~2 m soft swells
  float lumps = sn_fbm(wp * 1.6 + 7.0, 2, 2.2, 0.5, gL);        // ~60 cm → 30 cm lumps
  vec3 G = gS * 0.45 * 0.12 + gL * 1.6 * (0.026 + 0.01 * bare);
  float k = 1.0 + 0.06 * swell + 0.09 * lumps;
  float close = 1.0 - smoothstep(10.0, 24.0, dist);
  if (close > 0.0) {
    float grit = sn_fbm(wp * 6.0 + 2.0, 2, 2.3, 0.5, gG);       // ~16 cm → 7 cm grit
    G += gG * 6.0 * (0.0055 + 0.003 * bare) * close;
    k *= 1.0 + 0.08 * grit * close * SN_DETAIL_K;
  }
  surfBump = sn_tilt(G, n) * near;
  return c * mix(1.0, k, near);
}

// ---- ROAD: dirt track — packed fine grit (smoother in the ruts), loose small stones toward the shoulders
vec3 surfRoad(vec3 c, vec3 wp, vec3 n, float dist, float rut) {
  surfBump = vec3(0.0);
  float near = uSurfaceDetail > 0.5 ? 1.0 - smoothstep(14.0, 40.0, dist) : 0.0;
  if (near <= 0.0) return c;
  vec3 gP;
  float packed = sn_fbm(wp * 6.0, 2, 2.5, 0.5, gP);           // 16 cm → 6 cm packed grit
  vec3 G = gP * 6.0 * (0.008 + 0.012 * (1.0 - rut));
  float k = 1.0 + 0.1 * packed * SN_DETAIL_K;
  vec2 e;
  vec2 w = sn_worley2(wp.xz * 9.0 + 7.3, e);                  // ~11 cm loose stones, few in the ruts
  float keep = step(0.74 + 0.22 * rut, w.y);
  float r = 0.3 + 0.12 * fract(w.y * 11.1), dd = w.x / r;
  if (keep > 0.0 && dd < 1.0) {
    float dome = sqrt(max(1.0 - dd * dd, 0.02));
    vec2 sl = -e / (r * r * dome) * 0.5 * r / 9.0;
    G += vec3(sl.x, 0.0, sl.y) * 9.0 * SN_DETAIL_K;
    c = mix(c, mix(vec3(0.4, 0.37, 0.33), c * 1.15, 0.45) * (0.75 + 0.35 * fract(w.y * 17.3)) * (0.8 + 0.25 * dome), smoothstep(1.0, 0.8, dd) * SN_DETAIL_K);
  }
  surfBump = sn_tilt(G, n) * near;
  return c * mix(1.0, k, near);
}
// SNOW (2026-10-24, the user: "real snow like noise in road and ground, not a white colour"): real snowfields are never one
// white — WIND DRIFTS swell and hollow over 6–25 m (lighter crests, blue-grey hollows: the sky fills the shade), SASTRUGI
// (wind-carved ripples ~0.5–1.5 m, stretched across the wind) and a fine CRUST catch the low light, THIN patches let dark
// grass tufts and earth show through on the slopes. On a ROAD (road = 1) the snow is PACKED: flatter, grey-blue and
// polished in the tyre ruts (rut = 1), dirty slush with grit and gravel in them, ridges of loose snow between.
// Macro drifts at any distance (one fBm), the relief within ~60 m.
vec3 surfSnow(vec3 c, vec3 wp, vec3 n, float dist, float road, float rut) {
  surfBump = vec3(0.0);
  vec3 gD;
  float drift = sn_fbm(vec3(wp.x * 0.06, 0.0, wp.z * 0.06), 2, 2.3, 0.5, gD);   // −1..1, 8–25 m swells
  float crest = smoothstep(-0.2, 0.7, drift);
  c *= mix(vec3(0.84, 0.89, 1.0), vec3(1.04, 1.04, 1.02), crest);            // blue-grey hollows, bright crests
  vec3 G = gD * 0.06 * 0.9 * (1.0 - 0.8 * road);
  float near = uSurfaceDetail > 0.5 ? 1.0 - smoothstep(25.0, 65.0, dist) : 0.0;
  if (near > 0.0) {
    // sastrugi: ripples stretched across a fixed wind (from the north-west), sharpened
    vec3 gR;
    vec3 q = vec3((wp.x * 0.8 + wp.z * 0.6) * 0.9, 0.0, (wp.z * 0.8 - wp.x * 0.6) * 3.2);
    float rip = sn_fbm(q, 2, 2.2, 0.45, gR);
    vec3 gRw = vec3(gR.x * 0.9 * 0.8 - gR.z * 3.2 * 0.6, 0.0, gR.x * 0.9 * 0.6 + gR.z * 3.2 * 0.8);
    G += gRw * 0.035 * (1.0 - 0.85 * road) * near;
    // crust grain (≈ 10–30 cm)
    vec3 gC;
    float crust = sn_fbm(wp * 3.5, 2, 2.4, 0.5, gC);
    G += gC * 3.5 * 0.006 * near;
    c *= 1.0 + (0.05 * rip + 0.035 * crust) * near;
    // thin snow: dark grass tufts and earth showing through on drift hollows of slopes (never on the road)
    vec2 e;
    vec2 w = sn_worley2(wp.xz * 1.6 + 5.1, e);
    float thin = smoothstep(0.15, -0.45, drift) * smoothstep(0.5, 0.95, w.y) * smoothstep(0.55, 0.25, w.x) * (1.0 - road);
    c = mix(c, mix(vec3(0.07, 0.09, 0.05), vec3(0.16, 0.14, 0.1), fract(w.y * 7.3)) * (0.8 + 0.4 * crust), thin * 0.85 * near);
  }
  if (road > 0.0) {
    // packed: grey-blue and smoother overall; the ruts polished, dirty slush and grit in them
    vec3 gS;
    float sl = sn_fbm(vec3(wp.x * 1.3, 0.0, wp.z * 1.3) + 9.0, 2, 2.3, 0.5, gS);
    vec3 packedC = c * vec3(0.86, 0.9, 0.96);
    vec3 slush = mix(vec3(0.42, 0.42, 0.44), vec3(0.3, 0.27, 0.23), smoothstep(-0.2, 0.6, sl));
    packedC = mix(packedC, slush, rut * smoothstep(-0.35, 0.45, sl) * 0.75);
    vec2 e2;
    vec2 g2 = sn_worley2(wp.xz * 8.0 + 3.3, e2);                                 // grit / gravel in the slush
    float grit = step(0.7, g2.y) * smoothstep(0.35, 0.15, g2.x) * rut * near;
    packedC = mix(packedC, vec3(0.2, 0.19, 0.18), grit * 0.8);
    c = mix(c, packedC, road);
    G += gS * 1.3 * 0.012 * road * near;
  }
  surfBump = sn_tilt(G, n);
  return c;
}
`
