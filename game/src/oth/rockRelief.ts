/**
 * ROCK RELIEF (HIGH / ULTRA on PCs and laptops — `tier.rockRelief`): the user's reference — a rock's surface CRUMPLED
 * into small sharp creases and chipped facets that the sun picks out; only the light changes, the rock keeps its
 * colour. A world-space height field from the PAINT noise (noiseTex.ts) — ridged blotches (the creases, ~1.7 m), finer
 * creases between them (~0.6 m) and a faint chipping (the cells, ~0.45 m) — projected three ways (a face at any angle
 * takes it, no stretching), turned into the surface's true world-space slope by forward differences one pixel right
 * and one up (Mikkelsen's surface gradient), and the creases' faint occlusion. The grain fades as it shrinks under a
 * pixel, the whole relief by ~5 texels a pixel (far rock skips it: a branch round all the fetches).
 *
 * Cost where it shows: 3 height samples × the projections in use (1–2 typically) × 2 fetches. Shared by the terrain's
 * rock and scree (Terrain.ts) and the boulders (Rocks.ts); needs ATMOS_GLSL (uNoise) before it.
 */
export const ROCK_RELIEF_GLSL = /* glsl */ `
#ifdef OTH_ROCK_RELIEF
// how much of the relief shows on a pixel px metres across: 1 near … 0 once its creases shrink under a pixel (~0.2 →
// ~0.9 m). The rock's PAINTED colour breakup (paint.ts, Rocks.ts) — the fake relief from before — fades in only as
// this fades out (the user: "we don't need that colour now, we have real noise there")
float reliefShow(float px) { return 1.0 - smoothstep(3.0, 5.0, log2(max(px * (256.0 / 7.0), 1e-4))); }
// the relief's height (0 … ~1.1) at p; w = the three projections' weights, lod1 / lod2 = the two fetches' mip levels,
// fine = the grain's share (fading as it shrinks under a pixel)
float reliefH(vec3 p, vec3 w, float lod1, float lod2, float fine) {
  float h = 0.0;
  for (int i = 0; i < 3; i++) {
    float wi = i == 0 ? w.x : i == 1 ? w.y : w.z;
    if (wi < 0.03) continue;
    vec2 uv = i == 0 ? p.zy : i == 1 ? p.xz : p.xy;
    // (read a mip or so blurrier than the pixel needs: the noise's finest octaves drop out — clean creases between
    //  smooth faces, not a busy grain)
    vec4 a = textureLod(uNoise, uv * (1.0 / 7.0) + float(i) * 0.31, lod1 + 1.5);
    float g = textureLod(uNoise, uv * (1.0 / 2.3) + vec2(0.37, 0.61) + float(i) * 0.17, lod2 + 1.0).g;
    // ridged blotches: sharp crease lines where the noise crosses its middle; finer creases between them; the cells
    // a faint chipping
    h += wi * (0.6 * (1.0 - abs(a.r * 2.0 - 1.0)) + 0.3 * fine * (1.0 - abs(g * 2.0 - 1.0)) + 0.12 * (1.0 - a.a));
  }
  return h;
}
// the surface normal N bent by the relief at p, strength k (0 … 1); dpx / dpy = dFdx / dFdy of p (taken outside any
// branch); cav = out: the creases' occlusion (≈ 0.9 in a crease … 1)
vec3 rockRelief(vec3 p, vec3 N, float k, vec3 dpx, vec3 dpy, out float cav) {
  cav = 1.0;
  float px = max(length(dpx), length(dpy));
  float lod1 = log2(max(px * (256.0 / 7.0), 1e-4)), lod2 = log2(max(px * (256.0 / 2.3), 1e-4));
  float fade = k * reliefShow(px);
  if (fade < 0.01) return N;
  float fine = 1.0 - smoothstep(0.5, 2.5, lod2);
  lod1 = max(lod1, 0.0); lod2 = max(lod2, 0.0);
  vec3 w = pow(abs(N), vec3(4.0));
  w /= w.x + w.y + w.z;
  float h0 = reliefH(p, w, lod1, lod2, fine);
  float hx = reliefH(p + dpx, w, lod1, lod2, fine);
  float hy = reliefH(p + dpy, w, lod1, lod2, fine);
  // the height in metres (peak to crease ≈ 0.15 m): its differences along the pixel's two steps → the slope
  vec2 dB = vec2(hx - h0, hy - h0) * (0.15 * fade);
  vec3 R1 = cross(dpy, N), R2 = cross(N, dpx);
  float det = dot(dpx, R1);
  vec3 grad = sign(det) * (dB.x * R1 + dB.y * R2);
  cav = mix(1.0, 0.9 + 0.1 * smoothstep(0.3, 0.8, h0), fade);
  return normalize(abs(det) * N - grad);
}
#endif
`
