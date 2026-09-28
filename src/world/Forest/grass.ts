import * as THREE from 'three'
import { globalUniforms, GUST_GLSL } from '../../rendering/shaders/uniforms'

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
export function createGrassGeometry(blades: number, segments: number): THREE.BufferGeometry {
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
    const h = 0.28 + Math.pow(rnd(), 0.7) * 0.34
    const w = 0.028 + rnd() * 0.018
    const face = rnd() * Math.PI
    const lean = 0.06 + rnd() * 0.16
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
    const cx = rnd() * 0.6 - 0.3, cz = rnd() * 0.6 - 0.3, cy = 0.42, e = 0.04
    const q: [number, number, number][] = [[cx - e, cy, cz - e * 0.3], [cx + e, cy, cz + e * 0.3], [cx + e, cy + e * 1.5, cz + e * 0.3], [cx - e, cy + e * 1.5, cz - e * 0.3]]
    const qi = q.map((v) => push(v, 1, [cx, cz], 0, 1))
    index.push(qi[0], qi[1], qi[2], qi[0], qi[2], qi[3])
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
  g.name = `grass.blades${blades}x${segments}`
  return g
}

export function createGrassMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  m.name = 'lib/grass'
  m.onBeforeCompile = (shader) => {
    const u = globalUniforms
    Object.assign(shader.uniforms, {
      uTime: u.uTime, uWind: u.uWind, uGrassFade: u.uGrassFade, uCameraPos: u.uCameraPos, uPlayerPos: u.uPlayerPos,
      uKeyDirView: u.uKeyDirView, uKeyColor: u.uKeyColor,
    })
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime; uniform vec2 uWind; uniform vec2 uGrassFade; uniform vec3 uCameraPos; uniform vec3 uPlayerPos;
attribute float tip; attribute float flower; attribute vec2 bladeRoot; attribute float bladeId; varying float vTip;
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
          float dist = distance(bw.xyz, uCameraPos);
          // Distance shrink + thinning: far blades collapse (fewer rasterised); no pop.
          float fade = 1.0 - smoothstep(uGrassFade.x, uGrassFade.y, dist);
          float keep = 1.0 - smoothstep(uGrassFade.x * 0.35, uGrassFade.y, dist) * 0.65;
          if (bladeId > keep) fade = 0.0;
          if (flower > 0.5 && gHash(bw.xz) > 0.1) fade = 0.0;
          vec2 rootL = bladeRoot;
          transformed = vec3(rootL.x, 0.0, rootL.y) + (transformed - vec3(rootL.x, 0.0, rootL.y)) * fade;
          // Per-blade height variety.
          transformed.y *= 0.8 + 0.45 * gHash(bw.xz + 3.1);
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
          vec3 tipHue = mix(vec3(0.9, 1.05, 0.92), vec3(1.2, 1.08, 0.68), tn) * (0.9 + 0.2 * bh);
          vColor.rgb *= mix(vec3(1.0), tipHue, tip);
          vColor.rgb *= 1.0 + gGust * 0.2 * tip;
          if (flower > 0.5) vColor.rgb = gHash(bwc.xz + 1.3) > 0.5 ? vec3(0.95, 0.92, 0.82) : vec3(0.95, 0.72, 0.12);
        }
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uKeyDirView; uniform vec3 uKeyColor; varying float vTip;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `float back = pow(max(dot(normalize(-vViewPosition), uKeyDirView), 0.0), 4.0);
        outgoingLight += uKeyColor * diffuseColor.rgb * (back * 0.35 + 0.12) * vTip; // warm soft sunlit tips
        #include <opaque_fragment>`,
      )
  }
  m.customProgramCacheKey = () => 'grass-v6-blades'
  return m
}
