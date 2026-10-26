import * as THREE from 'three'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { Tier } from './quality'
import { HEIGHT_GLSL, type Terrain } from './Terrain'
import { SHADOW_GLSL } from './TerrainShadow'

/**
 * WATER — the lake and the ponds (a disc each at its level: calm, see-through turquoise → deep teal, the sky by
 * Fresnel, sun glints on drifting ripples) and the FLOWING water — the river and the streams (a ribbon along each
 * centre line at its sloping surface) — as RAPIDS (the user's reference: a fast shallow stream, light blue under
 * white foam streaks racing downstream). The depth under every pixel comes from the height grid itself (HEIGHT_GLSL:
 * no depth pre-pass); a soft white line where the water meets the bank.
 *
 * RAPIDS, cheap: two noise reads stretched along the current in the ribbon's own coordinates (metres downstream,
 * metres across — the streaks bend with the river) scrolling at the water's speed (faster where its surface drops
 * more), a slow churn, whiter in the shallows, along the banks and round the boulders (their footprint, blurred).
 */
export class Water {
  readonly group = new THREE.Group()

  constructor(map: MapData, atmos: Atmosphere, terrain: Terrain, tier: Tier, rockFootprint: THREE.Texture) {
    const t = terrain.uniforms
    const uniforms = {
      ...atmos.uniforms,
      uHIn: t.uHIn, uHFar: t.uHFar, uInGrid: t.uInGrid, uFarGrid: t.uFarGrid, uInScale: t.uInScale, uFarScale: t.uFarScale, uBoxHalf: t.uBoxHalf,
      uShBox: t.uShBox, uShWorld: t.uShWorld, uShBoxGrid: t.uShBoxGrid, uShOn: t.uShOn, uTreeSh: t.uTreeSh, uTreeShGrid: t.uTreeShGrid, uTreeShOn: t.uTreeShOn,
      uRocks: { value: rockFootprint },
    }
    const material = (rapids: boolean) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      defines: { ...(tier.spec ? { OTH_SPEC: '' } : {}), ...(rapids ? { RAPIDS: '' } : {}) },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const still = material(false), flowing = material(true)
    const disc = (cx: number, cz: number, rx: number, rz: number, rot: number, level: number, seg: number) => {
      const g = new THREE.CircleGeometry(1, seg)
      g.rotateX(-Math.PI / 2)
      g.scale(rx, 1, rz)
      g.rotateY(-rot)
      g.translate(cx, level, cz)
      const n = g.attributes.position.count
      g.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
      g.setAttribute('aUV', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
      const m = new THREE.Mesh(g, still)
      m.renderOrder = 5
      this.group.add(m)
    }
    // the lake: a disc round its ellipse (the shore clips it); the PONDS and small lakes: a disc each, at its level
    const L = map.meta.water.lake
    disc(L.cx, L.cz, L.rx * 1.75, L.rz * 1.75, L.rot, L.level, 96)
    for (const P of map.meta.water.ponds ?? []) disc(P.cx, P.cz, P.rx, P.rz, P.rot, P.level, 48)
    // the river and the streams: ribbons (the banks clip them), downstream toward index 0
    const r = map.meta.water.river
    this.group.add(ribbons([{ ...r, widen: 1.75 }], flowing))
    const streams = map.meta.water.streams ?? []
    if (streams.length) this.group.add(ribbons(streams.map((S) => ({ ...S, widen: 1.6 })), flowing)) // (every stream run: one draw)
  }
}

/** Flowing-water ribbons, one mesh: each along x / z (surface y, half width hw × widen each side), downstream toward
 *  index 0 — aFlow = the downstream direction × speed (faster where the surface drops more), aUV = (metres downstream
 *  from its source, metres across). */
function ribbons(lines: { x: number[]; z: number[]; y: number[]; hw: number[]; widen: number }[], mat: THREE.Material): THREE.Mesh {
  const total = lines.reduce((a, L) => a + L.x.length, 0)
  const pos = new Float32Array(total * 2 * 3), flow = new Float32Array(total * 2 * 2), uv = new Float32Array(total * 2 * 2), idx: number[] = []
  let o = 0
  for (const { x, z, y, hw, widen } of lines) {
    o += ribbon(x, z, y, hw, widen, pos, flow, uv, idx, o)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2))
  g.setAttribute('aUV', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeBoundingSphere()
  const m = new THREE.Mesh(g, mat)
  m.renderOrder = 5
  return m
}
/** One ribbon written from vertex pair o on; returns its pair count. */
function ribbon(x: number[], z: number[], y: number[], hw: number[], widen: number, pos: Float32Array, flow: Float32Array, uv: Float32Array, idx: number[], o: number): number {
  const n = x.length
  // arc length from the source (the last point) down
  const s = new Float32Array(n)
  for (let i = n - 2; i >= 0; i--) s[i] = s[i + 1] + Math.hypot(x[i + 1] - x[i], z[i + 1] - z[i])
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
    let tx = x[b] - x[a], tz = z[b] - z[a]
    const l = Math.hypot(tx, tz) || 1
    tx /= l; tz /= l
    const w = hw[i] * widen
    pos.set([x[i] - tz * w, y[i], z[i] + tx * w, x[i] + tz * w, y[i], z[i] - tx * w], (o + i) * 6)
    const drop = Math.max(0, (y[b] - y[a]) / l) // (the surface's fall per metre, downstream)
    const sp = Math.min(4.5, 1.3 + 30 * drop)
    flow.set([-tx * sp, -tz * sp, -tx * sp, -tz * sp], (o + i) * 4)
    uv.set([s[i], -w, s[i], w], (o + i) * 4)
    if (i < n - 1) { const k = (o + i) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2) }
  }
  return n
}

const VERT = /* glsl */ `
in vec2 aFlow;
in vec2 aUV;
out vec3 vWorld;
out vec2 vFlow;
out vec2 vUV;
void main() {
  vWorld = position;
  vFlow = aFlow;
  vUV = aUV;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
${HEIGHT_GLSL}
${SHADOW_GLSL}
uniform sampler2D uRocks;
in vec3 vWorld;
in vec2 vFlow;
in vec2 vUV;

const vec3 SHALLOW = vec3(0.2, 0.55, 0.52);
const vec3 DEEP = vec3(0.02, 0.17, 0.2);
// the rapids (the reference ≈ sRGB 150 190 215 under the streaks, the foam ≈ 235 242 248)
const vec3 RUN = vec3(0.26, 0.47, 0.64);
const vec3 RUN_DEEP = vec3(0.1, 0.27, 0.42);
const vec3 FOAM = vec3(0.83, 0.89, 0.94);

void main() {
  vec2 xz = vWorld.xz;
  float depth = vWorld.y - terrainHeight(xz);
  if (depth < 0.0) discard;
  vec3 V = normalize(uCamPos - vWorld);
  float sun = sunVisibility(xz);
  vec3 light = ambient(vec3(0.0, 1.0, 0.0)) + uSunColor * 0.45 * sun;
  float dcam = length(uCamPos - vWorld);
#ifdef RAPIDS
  // RAPIDS: streaks stretched along the current (u = metres downstream, v = metres across), racing downstream
  float spd = length(vFlow);
  float u = vUV.x - uTime * spd, v = vUV.y;
  float s1 = texture(uNoise, vec2(v / 1.1, u / 11.0) + vec2(0.13, 0.0)).r;
  float s2 = texture(uNoise, vec2(v / 0.45, (u - uTime * spd * 0.6) / 4.2) + vec2(0.57, 0.31)).g;
  float churn = texture(uNoise, xz / 5.0 + uTime * vec2(0.06, -0.045)).b;
  float k = 1.0 - exp(-depth * 0.9);
  // the foam: the streaks, more of them in the shallows (rocks under the surface) and on fast water; the banks and the
  // boulders ringed white
  float rocks = textureLod(uRocks, ((xz - uInGrid.z) / uInGrid.y + 0.5) / uInGrid.x, 1.2).r;
  float rough = 0.6 * s1 + 0.4 * s2 + (churn - 0.5) * 0.25 + (1.0 - k) * 0.1 + smoothstep(1.5, 4.0, spd) * 0.1 + rocks * 0.6;
  float foam = smoothstep(0.57, 0.68, rough);
  foam = max(foam, (1.0 - smoothstep(0.03, 0.22, depth)) * (0.6 + 0.4 * s2));
  // (the streaks blur into an even light blue far away: no shimmer)
  foam = mix(foam, 0.3, smoothstep(60.0, 260.0, dcam));
  vec3 body = mix(RUN, RUN_DEEP, k * 0.6) * (0.9 + 0.2 * s1);
  // a little sky on the blue, none on the foam
  vec3 N = normalize(vec3((s1 - 0.5) * 0.25, 1.0, (s2 - 0.5) * 0.25));
  float F = 0.02 + 0.3 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 R = reflect(-V, N);
  vec3 refl = skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
  vec3 c = mix(body * light, refl, F * (1.0 - foam));
  c = mix(c, FOAM * (light * 1.15), foam);
  float alpha = clamp(smoothstep(0.0, 0.06, depth) * mix(0.8, 0.98, max(k, foam)), 0.0, 1.0);
#else
  // ripples: two noise layers drifting
  vec2 drift = vFlow * uTime;
  vec2 n1 = texture(uNoise, xz / 9.0 - drift / 9.0 + uTime * vec2(0.012, 0.007)).rg - 0.5;
  vec2 n2 = texture(uNoise, xz / 3.1 - drift / 3.1 - uTime * vec2(0.02, -0.015)).gr - 0.5;
  // (ripples fade with distance: far water is calm — and no moiré)
  vec2 slope = (n1 * 0.16 + n2 * 0.08) * (1.0 - smoothstep(25.0, 160.0, dcam));
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // body colour: see-through shallows → deep teal
  float k = 1.0 - exp(-depth * 0.55);
  vec3 body = mix(SHALLOW, DEEP, k) * (ambient(vec3(0.0, 1.0, 0.0)) + uSunColor * 0.35 * sun);
  // the sky by Fresnel
  // (art-directed: the reflection never quite whites out the water, and takes its colour)
  float F = 0.02 + 0.42 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 R = reflect(-V, N);
  vec3 refl = skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z))) * vec3(0.72, 0.9, 0.95);
  vec3 c = mix(body, refl, F);
  // sun glints
  vec3 H = normalize(uSunDir + V);
  c += uSunDisc * sun * pow(max(dot(N, H), 0.0), 220.0) * 2.5; // (the sun's own colour: its reflection)
  // the shore line: a soft bright edge where it's a few cm deep
  float foam = (1.0 - smoothstep(0.02, 0.14, depth)) * (0.55 + 0.45 * texture(uNoise, xz / 1.7 + uTime * 0.05).b);
  c = mix(c, vec3(0.9, 0.93, 0.95) * (ambient(vec3(0.0, 1.0, 0.0)) * 1.4 + uSunColor * 0.5 * sun), foam * 0.75);
  float alpha = clamp(smoothstep(0.0, 0.08, depth) * mix(0.55, 0.97, k) + F * 0.5 + foam * 0.5, 0.0, 1.0);
#endif
  gl_FragColor = vec4(applyAtmos(c, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
