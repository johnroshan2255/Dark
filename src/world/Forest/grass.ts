import * as THREE from 'three'
import { globalUniforms, GUST_GLSL } from '../../rendering/shaders/uniforms'

/**
 * Grass: a field of INDIVIDUAL blades, the same in every art style (the hue comes from the ground under it, so each
 * style's palette still shows through). Opaque geometry, no alpha: thin blades cover few pixels and keep early-z.
 *
 * One instance = one 1 m² PATCH on an exact 1 m grid (GrassField). Inside it the blade roots are a PERIODIC
 * BLUE-NOISE set (Mitchell's best candidate on a torus), so spacing stays even across patch borders — no clumps
 * with bare holes between them (measured on the old white-noise layout: 18–33 % of the ground > 15 cm from any
 * blade, holes up to 62 cm; blue noise: 0–10 %, ≤ 19 cm). The set is generated in RANK order (every prefix is
 * itself well spread), and a blade's rank is its thinning threshold — so a 40 % density or a distant thinned field
 * stays even instead of clumping. The repeating 1 m layout is hidden in the shader: every blade gets its own turn,
 * root jitter and height from a hash of its world root.
 *
 * Natural mix in the same draw (no extra triangles: they replace blades): ~6 % seed stalks (taller, thinner, seed
 * head at the tip), one low broadleaf weed rosette per patch, dry blades (more on golden / ochre ground), and a
 * flower (near layer only).
 *
 * Vertex attributes: position, `blade` (root x, root z, tip 0..1, rank 0..1), `bladeKind` (kind, face angle).
 * No `color` / `normal` attributes (normals are up for the whole field; the colour is the instance colour = ground).
 */
const KIND_BLADE = 0, KIND_FLOWER = 1, KIND_STALK = 2, KIND_WEED = 3

/** Periodic blue noise in [−0.5, 0.5)², in progressive (rank) order — Mitchell's best candidate on a torus. */
function blueNoise(n: number, seed: number): [number, number][] {
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    let bx = 0, bz = 0, best = -1
    const candidates = 8 + i * 8
    for (let c = 0; c < candidates; c++) {
      const x = rnd(), z = rnd()
      let dmin = Infinity
      for (const p of pts) {
        let dx = Math.abs(x - p[0]), dz = Math.abs(z - p[1])
        if (dx > 0.5) dx = 1 - dx
        if (dz > 0.5) dz = 1 - dz
        const d = dx * dx + dz * dz
        if (d < dmin) dmin = d
      }
      if (dmin > best) (best = dmin), (bx = x), (bz = z)
    }
    pts.push([bx, bz])
  }
  return pts.map(([x, z]) => [x - 0.5, z - 0.5])
}

export interface GrassGeometryOptions {
  /** Blade height / width multipliers (default 1). */
  tall?: number
  wide?: number
  /** Height spread (1 = 0.2–0.7 m × tall). */
  vary?: number
  /** Random lean multiplier. */
  lean?: number
  /** One flower per patch (near layer). */
  flowers?: boolean
  /** Seed stalks + a weed rosette in place of blades (near layer). */
  extras?: boolean
}

/**
 * @param count blades per 1 m² patch (the triangle budget: weeds replace blades 1 : 1 in triangles)
 * @param segments 1 → 1 triangle per blade (LOW), 2 → 3 triangles with a curved mid joint
 */
export function createGrassGeometry(count: number, segments: number, o: GrassGeometryOptions = {}): THREE.BufferGeometry {
  const tall = o.tall ?? 1, wide = o.wide ?? 1, vary = o.vary ?? 1, leanK = o.lean ?? 1
  const pos: number[] = [], blade: number[] = [], kindA: number[] = [], index: number[] = []
  let nv = 0
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const push = (p: [number, number, number], root: [number, number], t: number, rank: number, kind: number, face: number): number => {
    pos.push(p[0], p[1], p[2])
    blade.push(root[0], root[1], t, rank)
    kindA.push(kind, face)
    return nv++
  }
  // A weed rosette costs `weedTris` triangles and takes that many blades' worth of the budget.
  const weedTris = segments <= 1 ? 2 : 3
  const weed = o.extras && count >= 8
  const blades = weed ? count - Math.ceil(weedTris / (segments <= 1 ? 1 : 3)) : count
  const slots = blades + (weed ? 1 : 0)
  const roots = blueNoise(slots, 1013)
  const weedSlot = weed ? Math.floor(slots * 0.3) : -1 // appears from 30 % density up
  let b = 0
  for (let i = 0; i < slots; i++) {
    const [rx, rz] = roots[i]
    const rank = (i + 0.5) / slots
    const r: [number, number] = [rx, rz]
    if (i === weedSlot) {
      // Low broadleaf weed: `weedTris` flat leaves fanned round the root, lying just above the ground.
      const a0 = rnd() * Math.PI * 2
      for (let k = 0; k < weedTris; k++) {
        const a = a0 + (k / weedTris) * Math.PI * 2, len = 0.08 + rnd() * 0.04, hw = 0.025
        const ca = Math.cos(a), sa = Math.sin(a)
        const iL = push([rx - sa * hw, 0.01, rz + ca * hw], r, 0.1, rank, KIND_WEED, a)
        const iR = push([rx + sa * hw, 0.01, rz - ca * hw], r, 0.1, rank, KIND_WEED, a)
        const iT = push([rx + ca * len, 0.05 + rnd() * 0.03, rz + sa * len], r, 1, rank, KIND_WEED, a)
        index.push(iL, iR, iT)
      }
      continue
    }
    const stalk = !!o.extras && b % 16 === 9
    b++
    let h = (0.2 + Math.pow(rnd(), 0.8) * 0.5 * vary) * tall
    let w = (0.017 + rnd() * 0.013) * wide // half-width at the root: full blade 3.4–6 cm (was 5.6–9.2: flat triangles)
    let lean = (0.06 + rnd() * 0.16) * Math.min(1, tall) * leanK
    if (stalk) (h = Math.min(0.85, h * 1.35 + 0.1) * tall), (w *= 0.55), (lean *= 0.5)
    // A single-triangle blade (LOW, far layer) is a spike with half a ribbon's area: wider, so the field keeps its
    // coverage (≈ the old blade width — no more pixels than before).
    if (segments <= 1) w *= 1.6
    const face = rnd() * Math.PI
    // Lean across the blade face, either way (natural curl; blades cross each other).
    const la = face + (rnd() < 0.5 ? 1 : -1) * Math.PI / 2 + (rnd() - 0.5) * 1.8
    const px = Math.cos(face) * w, pz = Math.sin(face) * w
    const at = (t: number): [number, number, number] => [rx + Math.cos(la) * lean * t * t, h * t, rz + Math.sin(la) * lean * t * t]
    const kind = stalk ? KIND_STALK : KIND_BLADE
    const T = at(1)
    if (segments <= 1) {
      index.push(push([rx + px, 0, rz + pz], r, 0, rank, kind, face), push([rx - px, 0, rz - pz], r, 0, rank, kind, face), push(T, r, 1, rank, kind, face))
    } else {
      const m = at(0.55)
      const k = 0.78 // ribbon: stays wide past the middle, then tapers to the point
      const iL = push([rx + px, 0, rz + pz], r, 0, rank, kind, face), iR = push([rx - px, 0, rz - pz], r, 0, rank, kind, face)
      const iML = push([m[0] + px * k, m[1], m[2] + pz * k], r, 0.55, rank, kind, face), iMR = push([m[0] - px * k, m[1], m[2] - pz * k], r, 0.55, rank, kind, face)
      const iT = push(T, r, 1, rank, kind, face)
      index.push(iL, iR, iML, iR, iMR, iML, iML, iMR, iT)
    }
  }
  if (o.flowers) {
    // A small flower just above the blades, tilted ~40° to read from a low camera: a 4-petal diamond fan (4 tris;
    // 2 on 1-segment grass). The old 10-triangle daisy was half of LOW's grass triangles (shown on ~10 % of patches).
    const cx = rnd() * 0.6 - 0.3, cz = rnd() * 0.6 - 0.3, cy = 0.5 * tall, R = 0.045
    const tilt = 0.7, ct = Math.cos(tilt), st = Math.sin(tilt), rot = rnd() * Math.PI * 2
    const P = (a: number, rr: number): [number, number, number] => {
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr
      const y2 = z * st, z2 = z * ct
      return [cx + x * Math.cos(rot) - z2 * Math.sin(rot), cy + y2, cz + x * Math.sin(rot) + z2 * Math.cos(rot)]
    }
    const fr: [number, number] = [cx, cz]
    const tips = [0, 1, 2, 3].map((k) => push(P((k / 4) * Math.PI * 2, R), fr, 1, 0, KIND_FLOWER, 0))
    if (segments <= 1) index.push(tips[0], tips[1], tips[2], tips[0], tips[2], tips[3])
    else {
      const c0 = push([cx, cy, cz], fr, 0, 0, KIND_FLOWER, 0)
      for (let k = 0; k < 4; k++) index.push(c0, tips[k], tips[(k + 1) % 4])
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('blade', new THREE.Float32BufferAttribute(blade, 4))
  g.setAttribute('bladeKind', new THREE.Float32BufferAttribute(kindA, 2))
  g.setIndex(index)
  // Bounds of one patch including lean / height / pixel widening (the field mesh is not frustum-culled anyway).
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0), 1.2)
  g.name = `grass.n${count}x${segments}${o.flowers ? '.f' : ''}${o.extras ? '.x' : ''}`
  return g
}

/**
 * @param band this layer's distance band from the player (m): x→y the blades GROW in (far layer, crossfading from
 *   the near one), z→w they shrink away (the field's edge). Each blade uses its own random threshold inside the
 *   band, so the edge is ragged and the crossfade is a gradual thinning — no ring, no line, no pop.
 */
export function createGrassMaterial(band = { value: new THREE.Vector4(-2, -1, 1e4, 1e4 + 1) }, thin = { value: new THREE.Vector2(1e4, 1e4 + 1) }): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
  m.name = 'lib/grass'
  m.onBeforeCompile = (shader) => {
    const u = globalUniforms
    Object.assign(shader.uniforms, {
      uTime: u.uTime, uWind: u.uWind, uGrassBand: band, uGrassThin: thin, uCameraPos: u.uCameraPos, uPlayerPos: u.uPlayerPos,
      uKeyDirView: u.uKeyDirView, uKeyColor: u.uKeyColor, uGrassPx: u.uGrassPx,
    })
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime; uniform vec2 uWind; uniform vec4 uGrassBand; uniform vec2 uGrassThin; uniform vec3 uCameraPos; uniform vec3 uPlayerPos; uniform float uGrassPx;
attribute vec4 blade; attribute vec2 bladeKind; attribute float iDensity; attribute vec2 iSlope; varying float vTip;
${GUST_GLSL}
// Integer hash on a 1/64 m lattice: exact at any world position (a sin() hash loses precision kilometres from the
// origin on mobile GPUs and turns into stripes / flicker).
float gHash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p * 64.0)));
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return float(h) * (1.0 / 4294967296.0);
}
float gVN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y); }
// Large soft PATCHES over the field (≈ 25 m + 8 m octaves): taller / shorter grass, lighter / darker tips.
float gPatch(vec2 xz) { return gVN(xz * 0.04) * 0.65 + gVN(xz * 0.13 + 17.0) * 0.35; }
vec4 gBW; float gGust; float gLush; bool gCull;`,
      )
      // The whole field shades as one surface (up normals): no normal attribute needed.
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        gCull = false;
        #ifdef USE_INSTANCING
        {
          gBW = modelMatrix * instanceMatrix * vec4(blade.x, 0.0, blade.y, 1.0);
          // PATCH VIEW CULL: the field surrounds the player (one draw, no CPU culling), so ~⅔ of its patches are
          // outside the view. Test the patch's bounding sphere (r 1.3 m) against the view cone (half-diagonal of the
          // frustum, from the projection matrix); culled patches skip all the work below and collapse to a point.
          vec3 toP = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz + vec3(0.0, 0.35, 0.0) - cameraPosition;
          float dP = length(toP);
          vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
          float tY = 1.0 / projectionMatrix[1][1], tX = 1.0 / projectionMatrix[0][0];
          float cosD = inversesqrt(1.0 + tY * tY + tX * tX), sinD = sqrt(1.0 - cosD * cosD);
          float sm = min(1.0, 1.3 / max(dP, 1e-3)), cm = sqrt(1.0 - sm * sm);
          gCull = dP > 1.8 && dot(toP, fwd) < dP * (cosD * cm - sinD * sm);
          if (!gCull) {
            gGust = windGust(gBW.xz, uTime, uWind);
            vec2 bw = gBW.xz;
            // Ground colour (instance colour) decides how lush the spot is: golden / ochre ground → shorter, drier grass.
            vec3 gc = vColor.rgb;
            gLush = smoothstep(0.34, 0.42, gc.g / (gc.r + gc.g + gc.b + 1e-4));
            float kind = bladeKind.x, t = blade.z;
            float tn = sin(bw.x * 0.11 + sin(bw.y * 0.07) * 3.0) * 0.5 + 0.5;
            float bh = gHash(bw + 7.7);
            float dry = step(gHash(bw + 2.3), 0.05 + 0.3 * (1.0 - gLush));
            vec3 base = mix(gc, gc * vec3(1.3, 1.12, 0.62), dry);
            // Root → tip: shaded roots (deeper where the grass is dense) to a light warm / cool tip; the blade's mean
            // ≈ the ground colour, so the field and the painted ground beyond it read as one (no edge line).
            // (Measured, HIGH: SSAO darkens a dense field of thin blades by ~15 %, so the blades sit ~12 % above the bare
            // ground without AO and ≈ on it with AO; lime-yellow tips — the bright look.)
            vec3 tipHue = mix(vec3(1.0, 1.07, 0.85), vec3(1.24, 1.12, 0.66), tn) * (0.92 + 0.16 * bh) * (1.26 + 0.2 * (gPatch(bw) - 0.5));
            float root = 0.98 - 0.14 * iDensity;
            vColor.rgb = base * mix(vec3(root), tipHue, t);
            if (kind > 1.5 && kind < 2.5) vColor.rgb = mix(vColor.rgb, dot(gc, vec3(0.3, 0.59, 0.11)) * vec3(1.25, 1.05, 0.7), smoothstep(0.72, 0.95, t)); // seed head
            if (kind > 2.5) vColor.rgb = gc * vec3(0.8, 1.0, 0.76) * (0.82 + 0.25 * t); // broadleaf weed: darker, bluer green
            vColor.rgb *= 1.0 + gGust * 0.1 * t; // soft gust bands
            if (kind > 0.5 && kind < 1.5) { float fh = gHash(bw + 1.3); vColor.rgb = fh > 0.66 ? vec3(0.95, 0.92, 0.82) : fh > 0.33 ? vec3(0.95, 0.72, 0.12) : vec3(0.3, 0.75, 0.95); }
          }
        }
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vTip = blade.z;
        #ifdef USE_INSTANCING
        if (gCull) {
          transformed = vec3(0.0); // every vertex of the patch on one point → zero-area triangles, never rasterised
        } else {
          vec2 ax = normalize(instanceMatrix[0].xz), az = normalize(instanceMatrix[2].xz);
          vec2 bw = gBW.xz;
          // Distance from the PLAYER (the field is centred on them), not the camera: camera-relative thresholds swept
          // through the meadow as the third-person camera orbits and blades popped ("glitter").
          float dist = distance(bw, uPlayerPos.xz);
          // THINNING by the blade's blue-noise RANK: any prefix of the ranks is evenly spread, so a 40 % patch shows
          // an even 40 % (a random subset of random points clumps). All transitions shrink blades (no pop).
          float h = blade.w;
          float h2 = gHash(bw + 5.3);
          float fade = 1.0 - smoothstep(iDensity - 0.12, iDensity, h);
          // Band: grow in (far layer) and shrink out (edge), each blade at its own distance (±18 % of the band).
          float jit = (h2 - 0.5) * 0.36;
          fade *= smoothstep(uGrassBand.x, uGrassBand.y, dist + jit * (uGrassBand.y - uGrassBand.x));
          fade *= 1.0 - smoothstep(uGrassBand.z, uGrassBand.w, dist + jit * (uGrassBand.w - uGrassBand.z));
          // Distance thinning toward the edge (fewer blades rasterised far away), by rank → stays even.
          float keep = 1.0 - smoothstep(uGrassThin.x, uGrassThin.y, dist) * 0.6;
          fade *= 1.0 - smoothstep(keep - 0.15, keep, h);
          float kind = bladeKind.x;
          // Flowers come in DRIFTS (low-frequency clusters), not an even sprinkle.
          if (kind > 0.5 && kind < 1.5 && gHash(bw) > 0.06 + 0.5 * smoothstep(0.35, 0.8, sin(bw.x * 0.09 + sin(bw.y * 0.07) * 2.0) * sin(bw.y * 0.11 - bw.x * 0.03) * 0.5 + 0.5)) fade = 0.0;
          vec2 rootL = blade.xy;
          vec3 rel = transformed - vec3(rootL.x, 0.0, rootL.y);
          // OWN TURN per blade (hides the repeating 1 m layout), clamped so no blade is closer than 25° to edge-on
          // from the camera: an edge-on ribbon is a sub-pixel line that rasterises as a dotted streak.
          float ang = (gHash(bw + 9.1) - 0.5) * 2.4;
          if (kind < 0.5 || (kind > 1.5 && kind < 2.5)) { // upright blades and stalks (flowers / weeds lie flat)
            vec2 c = uCameraPos.xz - bw;
            float d = bladeKind.y + ang + 1.5708 - atan(c.y, c.x + 1e-5);
            d -= 3.14159265 * floor(d / 3.14159265 + 0.5); // facing error, wrapped to ±90° (two-sided blade)
            ang += clamp(d, -1.13, 1.13) - d;
          }
          float cs = cos(ang), sn = sin(ang);
          rel.xz = vec2(cs * rel.x - sn * rel.z, sn * rel.x + cs * rel.z);
          rel *= fade;
          // Height: per blade, the big soft patches, and the ground's lushness (dry patches are shorter).
          rel.y *= (0.72 + 0.5 * gHash(bw + 3.1)) * (0.8 + 0.4 * gPatch(bw)) * (0.72 + 0.28 * gLush);
          // PIXEL-AWARE WIDTH: never thinner than ~1.2 px (sub-pixel blades shimmer as the camera pans), but no wider
          // than the blade really is — the old fixed +8 %/m widening drew 2–3× fat far blades on every screen.
          rel.xz *= max(1.0, 0.6 * distance(gBW.xyz, uCameraPos) * uGrassPx / 0.024);
          vec2 jt = (vec2(gHash(bw + 1.7), gHash(bw + 4.9)) - 0.5) * 0.06; // ±3 cm root jitter
          transformed = vec3(rootL.x + jt.x, 0.0, rootL.y + jt.y) + rel;
          // ON THE SLOPE: each blade's root sits on the terrain under it (the patch's height gradient, GrassField).
          transformed.y += dot(iSlope, rootL + jt);
          float t2 = blade.z * blade.z;
          float gust = gGust;
          float phase = dot(bw, vec2(0.37, 0.29));
          float sway = (sin(uTime * 2.1 + phase) * 0.4 + sin(uTime * 4.7 + phase * 1.9) * 0.12) * (0.5 + 0.7 * gust) + gust * 0.35;
          transformed.xz += vec2(dot(uWind, ax), dot(uWind, az)) * sway * t2 * 0.036;
          // Parting around the player (~1.2 m).
          vec2 dp = bw - uPlayerPos.xz;
          float pd = length(dp);
          float push = (1.0 - smoothstep(0.3, 1.2, pd)) * step(abs(gBW.y - uPlayerPos.y), 2.0);
          vec2 pl = pd > 1e-3 ? dp / pd : vec2(0.0);
          transformed.xz += vec2(dot(pl, ax), dot(pl, az)) * push * t2 * 0.4;
          transformed.y *= 1.0 - push * 0.5;
        }
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uKeyDirView; uniform vec3 uKeyColor; varying float vTip;')
      // Spot lights (the flashlight) at 30 % on the blades: a full-strength pool sweeping over thousands of thin
      // blades as the camera turns read as glitter; the ground under the grass still shows the beam.
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('getSpotLightInfo( spotLight, geometryPosition, directLight );', 'getSpotLightInfo( spotLight, geometryPosition, directLight );\n\t\tdirectLight.color *= 0.3;'))
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `float back = pow(max(dot(normalize(-vViewPosition), uKeyDirView), 0.0), 4.0);
        outgoingLight += uKeyColor * diffuseColor.rgb * (back * 0.2 + 0.1) * vTip; // warm soft sunlit (translucent) tips
        #include <opaque_fragment>`,
      )
  }
  m.customProgramCacheKey = () => 'grass-v8'
  return m
}
