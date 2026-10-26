import * as THREE from 'three'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'
import type { Tier } from './quality'
import { HEIGHT_GLSL, type Terrain } from './Terrain'
import { SHADOW_GLSL } from './TerrainShadow'

/**
 * WATER — the lake and the ponds (a disc each at its level) and the river (a ribbon along its centre line at its
 * sloping surface), one material. The depth under every pixel comes from the height grid itself (HEIGHT_GLSL in the fragment shader: no
 * depth pre-pass), so the colour runs from a see-through turquoise over the stones at the shore to deep teal, with a
 * soft white line where the water meets the bank. The sky is reflected by Fresnel, the sun glints on ripples that
 * drift (and on the river, flow downstream).
 */
export class Water {
  readonly group = new THREE.Group()

  constructor(map: MapData, atmos: Atmosphere, terrain: Terrain, tier: Tier) {
    const t = terrain.uniforms
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...atmos.uniforms,
        uHIn: t.uHIn, uHFar: t.uHFar, uInGrid: t.uInGrid, uFarGrid: t.uFarGrid, uInScale: t.uInScale, uFarScale: t.uFarScale, uBoxHalf: t.uBoxHalf,
        uShBox: t.uShBox, uShWorld: t.uShWorld, uShBoxGrid: t.uShBoxGrid, uShOn: t.uShOn, uTreeSh: t.uTreeSh, uTreeShGrid: t.uTreeShGrid, uTreeShOn: t.uTreeShOn,
      },
      defines: tier.spec ? { OTH_SPEC: '' } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    // the lake: a disc round its ellipse (the shore clips it)
    const L = map.meta.water.lake
    const lake = new THREE.CircleGeometry(1, 96, 0, Math.PI * 2)
    lake.rotateX(-Math.PI / 2)
    lake.scale(L.rx * 1.75, 1, L.rz * 1.75)
    lake.rotateY(-L.rot)
    lake.translate(L.cx, L.level, L.cz)
    const flowL = new Float32Array(lake.attributes.position.count * 2)
    lake.setAttribute('aFlow', new THREE.BufferAttribute(flowL, 2))
    const lakeMesh = new THREE.Mesh(lake, mat)
    lakeMesh.renderOrder = 5
    // the PONDS and small lakes: a disc each, at its level (the bowl's shore clips it like the lake's)
    for (const P of map.meta.water.ponds ?? []) {
      const g = new THREE.CircleGeometry(1, 48)
      g.rotateX(-Math.PI / 2)
      g.scale(P.rx, 1, P.rz)
      g.rotateY(-P.rot)
      g.translate(P.cx, P.level, P.cz)
      g.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
      const m = new THREE.Mesh(g, mat)
      m.renderOrder = 5
      this.group.add(m)
    }
    // the river: a ribbon 1.7 half-widths each side (the banks clip it), flow = its downstream direction × speed
    const r = map.meta.water.river
    const n = r.x.length
    const pos = new Float32Array(n * 2 * 3), flow = new Float32Array(n * 2 * 2), idx: number[] = []
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
      let tx = r.x[b] - r.x[a], tz = r.z[b] - r.z[a]
      const l = Math.hypot(tx, tz) || 1
      tx /= l; tz /= l
      const w = r.hw[i] * 1.75, y = r.y[i]
      pos.set([r.x[i] - tz * w, y, r.z[i] + tx * w, r.x[i] + tz * w, y, r.z[i] - tx * w], i * 6)
      // downstream is toward index 0 (the south exit); faster where narrow / steep
      const sp = 0.9
      flow.set([-tx * sp, -tz * sp, -tx * sp, -tz * sp], i * 4)
      if (i < n - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2) }
    }
    const river = new THREE.BufferGeometry()
    river.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    river.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2))
    river.setIndex(idx)
    river.computeBoundingSphere()
    const riverMesh = new THREE.Mesh(river, mat)
    riverMesh.renderOrder = 5
    this.group.add(lakeMesh, riverMesh)
  }
}

const VERT = /* glsl */ `
in vec2 aFlow;
out vec3 vWorld;
out vec2 vFlow;
void main() {
  vWorld = position;
  vFlow = aFlow;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`

const FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
${HEIGHT_GLSL}
${SHADOW_GLSL}
in vec3 vWorld;
in vec2 vFlow;

const vec3 SHALLOW = vec3(0.2, 0.55, 0.52);
const vec3 DEEP = vec3(0.02, 0.17, 0.2);

void main() {
  vec2 xz = vWorld.xz;
  float depth = vWorld.y - terrainHeight(xz);
  if (depth < 0.0) discard;
  // ripples: two noise layers drifting (and carried downstream on the river)
  vec2 drift = vFlow * uTime;
  vec2 n1 = texture(uNoise, xz / 9.0 - drift / 9.0 + uTime * vec2(0.012, 0.007)).rg - 0.5;
  vec2 n2 = texture(uNoise, xz / 3.1 - drift / 3.1 - uTime * vec2(0.02, -0.015)).gr - 0.5;
  // (ripples fade with distance: far water is calm — and no moiré)
  float dcam = length(uCamPos - vWorld);
  vec2 slope = (n1 * 0.16 + n2 * 0.08) * (1.0 - smoothstep(25.0, 160.0, dcam));
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 V = normalize(uCamPos - vWorld);
  float sun = sunVisibility(xz);
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
  c += uSunColor * sun * pow(max(dot(N, H), 0.0), 220.0) * 2.5;
  // the shore line: a soft bright edge where it's a few cm deep
  float foam = (1.0 - smoothstep(0.02, 0.14, depth)) * (0.55 + 0.45 * texture(uNoise, xz / 1.7 + uTime * 0.05).b);
  c = mix(c, vec3(0.9, 0.93, 0.95) * (ambient(vec3(0.0, 1.0, 0.0)) * 1.4 + uSunColor * 0.5 * sun), foam * 0.75);
  float alpha = clamp(smoothstep(0.0, 0.08, depth) * mix(0.55, 0.97, k) + F * 0.5 + foam * 0.5, 0.0, 1.0);
  gl_FragColor = vec4(applyAtmos(c, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
