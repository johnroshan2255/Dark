import * as THREE from 'three'
import { globalUniforms, GUST_GLSL } from '../../rendering/shaders/uniforms'
import { isGenshin, isOverland } from '../../rendering/artStyle'

/**
 * Genshin-style grass: a dense field of INDIVIDUAL blades (no clumps, no alpha cards).
 *
 * One instance = one 1 m² PATCH filled with `blades` separately placed blades (random root, facing, height,
 * lean) — patches tile a jittered 1 m grid with random rotation, so the field reads as uniform blades.
 * Each blade: `segments` = 1 → 1 triangle (LOW), 2 → 3 triangles with a curved mid joint (MEDIUM/HIGH).
 * Opaque geometry (no alpha test): thin blades cover few pixels and keep early-z — cheaper per pixel than cards.
 *
 * Vertex shader, per BLADE (using its own world root): wind sway + rolling gusts, parting around the player,
 * distance shrink (no pop) and distance THINNING (far blades collapse → fewer rasterised), base→tip colour
 * with two tip hues. Normals point up (soft, Genshin-like lighting of the whole meadow).
 */
/**
 * @param tall blade height multiplier (overland meadows ≈ 2.1: knee-to-waist-high straw)
 * @param wide blade width multiplier (taller blades are wider so the carpet stays closed)
 * @param vary height spread (1 = 0.28–0.62 m × tall)
 * @param lean random lean multiplier (Genshin's blades stand UPRIGHT ≈ 0.35)
 */
export function createGrassGeometry(blades: number, segments: number, tall = 1, wide = 1, vary = 1, leanK = 1): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const tip: number[] = []
  const root: number[] = []
  const id: number[] = []
  const flower: number[] = []
  const index: number[] = []
  let nv = 0
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const push = (p: [number, number, number], t: number, r: [number, number], bid: number, f = 0): number => {
    pos.push(p[0], p[1], p[2])
    col.push(0.55 + 0.45 * t, 0.55 + 0.45 * t, 0.55 + 0.45 * t)
    tip.push(t)
    root.push(r[0], r[1])
    id.push(bid)
    flower.push(f)
    return nv++
  }
  for (let b = 0; b < blades; b++) {
    const rx = rnd() * 1.1 - 0.55
    const rz = rnd() * 1.1 - 0.55
    const h = (0.28 + Math.pow(rnd(), 0.7) * 0.34 * vary) * tall
    const w = (0.028 + rnd() * 0.018) * wide
    const face = rnd() * Math.PI
    const lean = (0.06 + rnd() * 0.16) * Math.min(1, tall) * leanK
    const la = face + Math.PI / 2 + (rnd() - 0.5) * 1.2 // lean roughly across the blade face (natural curl)
    const px = Math.cos(face) * w, pz = Math.sin(face) * w
    const at = (t: number): [number, number, number] => [rx + Math.cos(la) * lean * t * t, h * t, rz + Math.sin(la) * lean * t * t]
    const bid = b / blades
    const r: [number, number] = [rx, rz]
    const base = at(0)
    const L: [number, number, number] = [base[0] + px, 0, base[2] + pz]
    const R: [number, number, number] = [base[0] - px, 0, base[2] - pz]
    const T = at(1)
    if (segments <= 1) {
      const a0 = push(L, 0, r, bid), a1 = push(R, 0, r, bid), a2 = push(T, 1, r, bid)
      index.push(a0, a1, a2)
    } else {
      const m = at(0.55)
      const k = 0.62
      const ML: [number, number, number] = [m[0] + px * k, m[1], m[2] + pz * k]
      const MR: [number, number, number] = [m[0] - px * k, m[1], m[2] - pz * k]
      const iL = push(L, 0, r, bid), iR = push(R, 0, r, bid), iML = push(ML, 0.55, r, bid), iMR = push(MR, 0.55, r, bid), iT = push(T, 1, r, bid)
      index.push(iL, iR, iML, iR, iMR, iML, iML, iMR, iT)
    }
  }
  // One flower per patch (2 tris), shown on ~10 % of patches.
  {
    // A small DAISY just above the blades: a 5-petal star (centre `tip` 0 → yellow eye, petal tips 1 → white; the
    // shader colours it), tilted ~40° so it reads from a low camera. 10 triangles.
    const cx = rnd() * 0.6 - 0.3, cz = rnd() * 0.6 - 0.3, cy = 0.5 * tall, R = 0.045
    const tilt = 0.7, ct = Math.cos(tilt), st = Math.sin(tilt), rot = rnd() * Math.PI * 2
    const P = (a: number, r: number): [number, number, number] => {
      const x = Math.cos(a) * r, z = Math.sin(a) * r // flat, then tilted about x and spun
      const y2 = z * st, z2 = z * ct
      return [cx + x * Math.cos(rot) - z2 * Math.sin(rot), cy + y2, cz + x * Math.sin(rot) + z2 * Math.cos(rot)]
    }
    const c0 = push([cx, cy, cz], 0, [cx, cz], 0, 1)
    const ring: number[] = []
    for (let k = 0; k < 10; k++) ring.push(push(P((k / 10) * Math.PI * 2, k % 2 === 0 ? R : R * 0.42), k % 2 === 0 ? 1 : 0.55, [cx, cz], 0, 1))
    for (let k = 0; k < 10; k++) index.push(c0, ring[k], ring[(k + 1) % 10])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  g.setAttribute('tip', new THREE.Float32BufferAttribute(tip, 1))
  g.setAttribute('bladeRoot', new THREE.Float32BufferAttribute(root, 2))
  g.setAttribute('bladeId', new THREE.Float32BufferAttribute(id, 1))
  g.setAttribute('flower', new THREE.Float32BufferAttribute(flower, 1))
  g.setIndex(index)
  g.computeBoundingSphere()
  g.name = `grass.blades${blades}x${segments}${tall !== 1 ? `.tall${tall}` : ''}${vary !== 1 ? `.vary${vary}` : ''}${leanK !== 1 ? `.lean${leanK}` : ''}`
  return g
}

/**
 * OVERLAND grass TUFT texture (512², drawn once): ~90 soft tapered strokes fanning up from the bottom centre,
 * darker at the root and pale at the tips, so a crossed pair of cards reads as a soft brushed clump of straw —
 * the fur-like meadow of over the hill — instead of hard triangles. Greyscale luminance × vertex colour.
 */
export function createGrassTuftTexture(): THREE.CanvasTexture {
  const S = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = S
  const g = canvas.getContext('2d')!
  g.clearRect(0, 0, S, S)
  let seed = 31
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  g.lineCap = 'round'
  // Dense pale straw: a soft mound base plus ~140 fine strokes in a NARROW luminance band (0.7–0.95). Low
  // contrast between strokes is what keeps thin strokes from glittering against the alpha cut on phones.
  const base = g.createRadialGradient(S * 0.5, S * 0.98, S * 0.05, S * 0.5, S * 0.98, S * 0.5)
  base.addColorStop(0, 'rgba(200,200,200,1)')
  base.addColorStop(0.5, 'rgba(205,205,205,0.95)')
  base.addColorStop(0.8, 'rgba(210,210,210,0.6)')
  base.addColorStop(1, 'rgba(215,215,215,0)')
  g.fillStyle = base
  g.fillRect(0, S * 0.4, S, S * 0.6)
  g.shadowColor = 'rgba(200,200,200,0.5)'
  g.shadowBlur = 4
  for (let layer = 0; layer < 3; layer++) {
    const n = [60, 50, 34][layer]
    for (let i = 0; i < n; i++) {
      const x0 = S * (0.5 + (rnd() - 0.5) * 0.6)
      const lean = (rnd() - 0.5) * 0.8 + (x0 - S / 2) / S
      const h = S * (0.45 + rnd() * 0.5) * (1 - layer * 0.08)
      const x1 = x0 + lean * h * 0.5
      const y0 = S * 0.98, y1 = y0 - h
      const cx = x0 + lean * h * 0.15, cy = y0 - h * 0.55
      const v = 0.7 + layer * 0.08 + rnd() * 0.06
      for (const [t, w] of [[0.6, 11], [0.85, 7], [1.0, 4]] as const) {
        const q = (a: number, b: number, c: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c
        const c = Math.round(Math.min(0.96, v + t * 0.12) * 255)
        g.strokeStyle = `rgba(${c},${c},${c},1)`
        g.lineWidth = w
        g.beginPath()
        g.moveTo(x0, y0)
        g.quadraticCurveTo(cx, cy, q(x0, cx, x1), q(y0, cy, y1))
        g.stroke()
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.name = 'grassTuft'
  return tex
}

/**
 * OVERLAND card grass: per 1 m² patch, `tufts` crossed card pairs (2 quads = 4 tris each) of the tuft texture,
 * ~1 m wide × 0.75 m × `tall` high, overlapping so the meadow closes into one soft carpet. Same attributes as
 * the blade geometry (tip = card v, bladeRoot = tuft centre, bladeId) so the wind/parting/thinning shader is shared.
 */
export function createGrassCardGeometry(tufts: number, tall = 1, wide = 1): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], tip: number[] = [], root: number[] = [], id: number[] = [], flower: number[] = [], uv: number[] = [], index: number[] = []
  let nv = 0
  let seed = 11
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let t = 0; t < tufts; t++) {
    const rx = rnd() * 1.1 - 0.55, rz = rnd() * 1.1 - 0.55
    const h = (0.55 + rnd() * 0.4) * tall
    const w = (0.7 + rnd() * 0.35) * wide
    const a0 = rnd() * Math.PI
    const bid = t / tufts
    for (const a of [a0, a0 + Math.PI / 2]) {
      const dx = Math.cos(a) * w, dz = Math.sin(a) * w
      const corners: [number, number, number, number, number][] = [
        [rx - dx, 0, rz - dz, 0, 0], [rx + dx, 0, rz + dz, 1, 0], [rx + dx, h, rz + dz, 1, 1], [rx - dx, h, rz - dz, 0, 1],
      ]
      const base = nv
      for (const [x, y, z, u, v] of corners) {
        pos.push(x, y, z)
        col.push(0.55 + 0.45 * v, 0.55 + 0.45 * v, 0.55 + 0.45 * v)
        tip.push(v)
        root.push(rx, rz)
        id.push(bid)
        flower.push(0)
        uv.push(u, v)
        nv++
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('tip', new THREE.Float32BufferAttribute(tip, 1))
  g.setAttribute('bladeRoot', new THREE.Float32BufferAttribute(root, 2))
  g.setAttribute('bladeId', new THREE.Float32BufferAttribute(id, 1))
  g.setAttribute('flower', new THREE.Float32BufferAttribute(flower, 1))
  g.setIndex(index)
  g.computeBoundingSphere()
  g.name = `grass.cards${tufts}.tall${tall}`
  return g
}

/**
 * @param band this layer's distance band from the player (m): x→y the blades GROW in (far layer, crossfading from
 *   the near one), z→w they shrink away (the field's edge). Each blade uses its own random threshold inside the
 *   band, so the edge is ragged and the crossfade is a gradual thinning — no ring, no line, no pop (Genshin).
 */
export function createGrassMaterial(band = { value: new THREE.Vector4(-2, -1, 1e4, 1e4 + 1) }, thin = { value: new THREE.Vector2(1e4, 1e4 + 1) }): THREE.MeshLambertMaterial {
  // Opaque individual blades in every style (over the hill's meadow is single blades too; the card-clump variant
  // `createGrassCardGeometry` stays available but read as clumps).
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  m.name = 'lib/grass'
  m.onBeforeCompile = (shader) => {
    const u = globalUniforms
    Object.assign(shader.uniforms, {
      uTime: u.uTime, uWind: u.uWind, uGrassBand: band, uGrassThin: thin, uCameraPos: u.uCameraPos, uPlayerPos: u.uPlayerPos,
      uKeyDirView: u.uKeyDirView, uKeyColor: u.uKeyColor,
    })
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime; uniform vec2 uWind; uniform vec4 uGrassBand; uniform vec2 uGrassThin; uniform vec3 uCameraPos; uniform vec3 uPlayerPos;
attribute float tip; attribute float flower; attribute vec2 bladeRoot; attribute float bladeId; attribute float iDensity; attribute vec2 iSlope; varying float vTip;
${GUST_GLSL}
float gHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 gBW; float gGust;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vTip = tip;
        #ifdef USE_INSTANCING
          vec2 ax = normalize(instanceMatrix[0].xz), az = normalize(instanceMatrix[2].xz);
          vec4 bw = gBW; // this blade's root (computed once in color_vertex)
          // Distance from the PLAYER (the field is centred on them), not the camera: in third person the camera
          // orbits ~8 m around the player, so camera-relative thresholds swept through the meadow on every look
          // and whole tufts popped in and out — the "glitter" when moving the camera.
          float dist = distance(bw.xz, uPlayerPos.xz);
          // EVERY BLADE ON ITS OWN: a random threshold per blade AND per patch (the patch origin re-shuffles which
          // blades go first), so density, distance thinning and the field's edge never repeat patch to patch —
          // no rows, no rings, no squares. All transitions are a smooth shrink (blades grow in / out, no pop).
          vec3 patchO = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
          float h = fract(bladeId * 7.31 + gHash(patchO.xz) * 13.7);
          float h2 = gHash(bw.xz + 5.3);
          // Local density 0..1 (meadow vs forest floor vs verge, interpolated per patch — GrassField): a soft
          // threshold, so a patch at 0.4 shows 40 % of its blades instead of all-or-nothing squares.
          float fade = 1.0 - smoothstep(iDensity - 0.12, iDensity, h);
          // Band: grow in (far layer) and shrink out (edge), each blade at its own distance (±18 % of the band).
          float jit = (h2 - 0.5) * 0.36;
          fade *= smoothstep(uGrassBand.x, uGrassBand.y, dist + jit * (uGrassBand.y - uGrassBand.x));
          fade *= 1.0 - smoothstep(uGrassBand.z, uGrassBand.w, dist + jit * (uGrassBand.w - uGrassBand.z));
          // Distance thinning toward the edge (fewer blades rasterised far away), random per blade.
          float keep = 1.0 - smoothstep(uGrassThin.x, uGrassThin.y, dist) * ${isOverland() ? '0.45' : '0.6'};
          fade *= 1.0 - smoothstep(keep - 0.15, keep, h);
          // Flowers: a sprinkle; Genshin meadows have DRIFTS of small white / yellow flowers (low-frequency clusters).
          float fl = ${isGenshin() ? '0.06 + 0.5 * smoothstep(0.35, 0.8, sin(bw.x * 0.09 + sin(bw.z * 0.07) * 2.0) * sin(bw.z * 0.11 - bw.x * 0.03) * 0.5 + 0.5)' : '0.1'};
          if (flower > 0.5 && gHash(bw.xz) > fl) fade = 0.0;
          vec2 rootL = bladeRoot;
          transformed = vec3(rootL.x, 0.0, rootL.y) + (transformed - vec3(rootL.x, 0.0, rootL.y)) * fade;
          // ON THE SLOPE: each blade's root sits on the terrain under it (the patch's local height gradient,
          // GrassField) — a flat 1 m patch on a hillside buried its uphill blades and floated its downhill ones,
          // which stacked into terraced rows across every slope.
          transformed.y += dot(iSlope, rootL);
          // Per-blade height variety (Genshin: a fairly even, lush field).
          transformed.y *= ${isGenshin() ? '0.85 + 0.3' : '0.8 + 0.45'} * gHash(bw.xz + 3.1);
          // Blades thicken with distance (base widens, tip stays a point) so a far blade never thins below a
          // pixel: sub-pixel blades shimmer as the camera pans (the "glitter" on phones).
          transformed.xz = vec2(rootL.x, rootL.y) + (transformed.xz - vec2(rootL.x, rootL.y)) * (1.0 + dist * ${isOverland() ? '0.14' : '0.08'});
          float t2 = tip * tip;
          float gust = gGust;
          float phase = dot(bw.xz, vec2(0.37, 0.29));
          float sway = (sin(uTime * 2.1 + phase) * 0.4 + sin(uTime * 4.7 + phase * 1.9) * 0.14) * (0.45 + 0.9 * gust) + gust * 0.7;
          transformed.xz += vec2(dot(uWind, ax), dot(uWind, az)) * sway * t2 * 0.28;
          // Parting around the player (~1.2 m).
          vec2 dp = bw.xz - uPlayerPos.xz;
          float pd = length(dp);
          float push = (1.0 - smoothstep(0.3, 1.2, pd)) * step(abs(bw.y - uPlayerPos.y), 2.0);
          vec2 pl = pd > 1e-3 ? dp / pd : vec2(0.0);
          transformed.xz += vec2(dot(pl, ax), dot(pl, az)) * push * t2 * 0.4;
          transformed.y *= 1.0 - push * 0.5;
        #endif`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING
        {
          gBW = modelMatrix * instanceMatrix * vec4(bladeRoot.x, 0.0, bladeRoot.y, 1.0);
          gGust = windGust(gBW.xz, uTime, uWind);
          vec4 bwc = gBW;
          float tn = sin(bwc.x * 0.11 + sin(bwc.z * 0.07) * 3.0) * 0.5 + 0.5;
          float bh = gHash(bwc.xz + 7.7);
          ${isOverland()
            ? `// OVERLAND straw: darker orange-ochre at the root, pale gold at the tip (over the hill's meadows).
          // Low root→tip contrast: high contrast on thin strokes sparkles as the camera moves.
          vec3 tipHue = mix(vec3(1.16, 1.14, 0.84), vec3(1.2, 1.16, 0.78), tn) * (0.98 + 0.04 * bh);
          // Flatten the geometry's root→tip gradient (0.55→1): dark roots between pale blades flicker on phones.
          vColor.rgb *= mix(vec3(0.92, 0.84, 0.6), tipHue, tip) * (0.8 + 0.2 * tip) / (0.55 + 0.45 * tip); // shaded roots → depth in a dense short field`
            : isGenshin()
            ? `// GENSHIN (sampled, Statue of the Seven / Starfell): the blades ARE the meadow's colour — the tip a little
          // lighter and warmer than the ground (so near grass and the far painted hill read as one green), the root a
          // cooler, darker GREEN (never olive-brown). The geometry's 0.55→1 root gradient is replaced, not stacked.
          // (Measured: blades averaged 13 % darker and yellower than the bare ground under them → lifted so the
          // field's mean ≈ the ground (sampled 119,160,81), tips ≈ +25 %.)
          // ANIME GRASS (Genshin meadow close-up): blade = the GROUND's colour at the root (no dark band — the field
          // and the soil read as one surface) brightening to a LIME, slightly yellow tip (≈ 130,195,70 on screen),
          // lit with the terrain's own up normal (whole field shades as one, no per-blade facets); soft gust bands.
          // The ground colour, hue-shifted toward Genshin's LIME (keeping its brightness): olive / golden ground patches
          // don't turn the grass olive.
          vec3 gc = vColor.rgb / (0.55 + 0.45 * tip);
          float gl = dot(gc, vec3(0.2126, 0.7152, 0.0722));
          gc = mix(gc, vec3(0.223, 0.546, 0.061) * (gl / 0.442), 0.6);
          vec3 tipHue = mix(vec3(1.2, 1.3, 0.95), vec3(1.34, 1.32, 0.85), tn) * (0.96 + 0.08 * bh);
          vColor.rgb = gc * mix(vec3(0.96, 1.0, 1.0), tipHue, tip * tip * (3.0 - 2.0 * tip));`
            : `vec3 tipHue = mix(vec3(0.9, 1.05, 0.92), vec3(1.2, 1.08, 0.68), tn) * (0.9 + 0.2 * bh);
          vColor.rgb *= mix(vec3(1.0), tipHue, tip);`}
          vColor.rgb *= 1.0 + gGust * (${isOverland() ? '0.08' : '0.2'}) * tip;
          if (flower > 0.5) { float fh = gHash(bwc.xz + 1.3); vColor.rgb = ${isGenshin() ? 'mix(vec3(1.0, 0.72, 0.12), fh > 0.3 ? vec3(1.0, 0.98, 0.92) : vec3(1.0, 0.86, 0.3), smoothstep(0.3, 0.8, tip))' : 'fh > 0.66 ? vec3(0.95, 0.92, 0.82) : fh > 0.33 ? vec3(0.95, 0.72, 0.12) : vec3(0.3, 0.75, 0.95)'}; }
        }
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uKeyDirView; uniform vec3 uKeyColor; varying float vTip;')
      // Spot lights (the flashlight) at 30 % on the blades: a full-strength pool sweeping over thousands of thin
      // cards as the camera turns read as glitter; the ground under the grass still shows the beam.
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('getSpotLightInfo( spotLight, geometryPosition, directLight );', 'getSpotLightInfo( spotLight, geometryPosition, directLight );\n\t\tdirectLight.color *= 0.3;'))
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `float back = pow(max(dot(normalize(-vViewPosition), uKeyDirView), 0.0), 4.0);
        outgoingLight += uKeyColor * diffuseColor.rgb * (back * ${isGenshin() ? '0.4' : '0.2'} + ${isGenshin() ? '0.16' : '0.1'}) * vTip; // warm soft sunlit (translucent) tips
        #include <opaque_fragment>`,
      )
  }
  m.customProgramCacheKey = () => `grass-v7-blades${isOverland() ? '-over' : isGenshin() ? '-gen' : ''}`
  return m
}
