import * as THREE from 'three'
import { ATMOS_GLSL, FRAG_OUT, type Atmosphere } from './Atmosphere'
import type { MapData } from './MapData'

/**
 * WATERFALLS (meta.water.falls — scripts/oth/scenery.mjs): each a SHEET of falling water from its lip to the plunge
 * pool, arcing out a little as it drops (more the taller it is), white streaks racing down over light blue, ragged
 * strands at its edges; at its foot a churning FOAM disc spreading on the pool and a soft drift of MIST. Cheap: every
 * sheet in one draw, every foot (foam + mist) in a second, the paint noise the only texture.
 */
const ROWS = 12

export class Falls {
  readonly group = new THREE.Group()

  constructor(map: MapData, atmos: Atmosphere) {
    const F = map.meta.water.falls ?? []
    if (!F.length) return
    // the sheets: ROWS × 2 vertices each — aUV = (across −1…1, down 0…1), aDrop = the fall's height (m)
    const pos: number[] = [], uv: number[] = [], drop: number[] = [], idx: number[] = []
    // the feet: a foam disc (4 corners, aKind 0) and two mist billboards (4 corners each, aKind 1) — aCorner = the
    // corner (−1…1), aSize = radius / half size (m)
    const fpos: number[] = [], corner: number[] = [], size: number[] = [], kind: number[] = [], fidx: number[] = []
    for (const f of F) {
      let dx = f.bx - f.x, dz = f.bz - f.z
      const l = Math.hypot(dx, dz) || 1
      dx /= l; dz /= l
      const sx = -dz, sz = dx, H = Math.max(0.5, f.y - f.by)
      // (the arc: thrown out over the lip, ~0.4 m for a short drop … ~2 m for a tall one)
      const reach = (t: number) => 0.25 + Math.min(2.2, 0.55 * Math.sqrt(H)) * Math.sqrt(t)
      const base = pos.length / 3
      for (let r = 0; r <= ROWS; r++) {
        const t = r / ROWS, w = f.hw * (1 + 0.18 * t), o = reach(t)
        for (const side of [-1, 1]) {
          pos.push(f.x + dx * o + sx * w * side, f.y + 0.05 - (H + 0.1) * t, f.z + dz * o + sz * w * side)
          uv.push(side, t)
          drop.push(H)
        }
        if (r < ROWS) { const k = base + r * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2) }
      }
      // the foot: where the sheet meets the pool
      const o = reach(1), cx = f.x + dx * o, cz = f.z + dz * o
      const quad = (y: number, s: number, kd: number) => {
        const b = fpos.length / 3
        for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { fpos.push(cx, y, cz); corner.push(a, c); size.push(s); kind.push(kd) }
        fidx.push(b, b + 1, b + 2, b, b + 2, b + 3)
      }
      quad(f.by + 0.04, f.hw * 1.9, 0)
      const ms = f.hw * 1.6 + H * 0.35
      quad(f.by + ms * 0.45, ms, 1)
      quad(f.by + ms * 0.8, ms * 0.8, 1.5)
    }
    const sheet = new THREE.BufferGeometry()
    sheet.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    sheet.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2))
    sheet.setAttribute('aDrop', new THREE.Float32BufferAttribute(drop, 1))
    sheet.setIndex(idx)
    sheet.computeBoundingSphere()
    const sheetMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: { ...atmos.uniforms }, vertexShader: SHEET_VERT, fragmentShader: SHEET_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    })
    const sheetMesh = new THREE.Mesh(sheet, sheetMat)
    sheetMesh.renderOrder = 6
    const feet = new THREE.BufferGeometry()
    feet.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3))
    feet.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2))
    feet.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1))
    feet.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
    feet.setIndex(fidx)
    feet.computeBoundingSphere()
    feet.boundingSphere!.radius += 30 // (the billboards grow round their centres)
    const footMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: { ...atmos.uniforms }, vertexShader: FOOT_VERT, fragmentShader: FOOT_FRAG,
      transparent: true, depthWrite: false,
    })
    const footMesh = new THREE.Mesh(feet, footMat)
    footMesh.renderOrder = 7
    this.group.add(sheetMesh, footMesh)
  }
}

const SHEET_VERT = /* glsl */ `
in vec2 aUV;
in float aDrop;
out vec2 vUV;
out float vDrop;
out vec3 vWorld;
void main() {
  vUV = aUV;
  vDrop = aDrop;
  vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`
const SHEET_FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
in vec2 vUV;
in float vDrop;
in vec3 vWorld;
const vec3 RUN = vec3(0.3, 0.52, 0.68);
const vec3 FOAM = vec3(0.86, 0.91, 0.95);
void main() {
  // metres across / down the sheet; the streaks fall at ~6 m/s, stretched down
  float down = vUV.y * vDrop, across = vUV.x * 2.0;
  float s1 = texture(uNoise, vec2(across / 0.55, (down - uTime * 6.0) / 4.5)).r;
  float s2 = texture(uNoise, vec2(across / 0.25 + 0.37, (down - uTime * 7.5) / 2.2)).g;
  float streak = smoothstep(0.38, 0.66, 0.6 * s1 + 0.4 * s2);
  // ragged strands at the edges, the top gathering at the lip, the bottom lost in the spray
  float edge = 1.0 - smoothstep(0.62, 1.0, abs(vUV.x) + (s2 - 0.5) * 0.35);
  float alpha = edge * mix(0.5, 0.95, streak) * smoothstep(0.0, 0.04, vUV.y) * (1.0 - smoothstep(0.85, 1.0, vUV.y) * 0.6);
  if (alpha < 0.02) discard;
  vec3 light = ambient(vec3(0.0, 1.0, 0.0)) * 1.1 + uSunColor * 0.5;
  vec3 c = mix(RUN, FOAM, 0.45 + 0.55 * streak) * light;
  gl_FragColor = vec4(applyAtmos(c, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const FOOT_VERT = /* glsl */ `
in vec2 aCorner;
in float aSize;
in float aKind;
out vec2 vCorner;
out float vKind;
out vec3 vWorld;
void main() {
  vCorner = aCorner;
  vKind = aKind;
  vec3 p = position;
  if (aKind < 0.5) {
    p.xz += aCorner * aSize; // the foam: flat on the pool
  } else {
    // the mist: a billboard facing the camera
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p += (right * aCorner.x + up * aCorner.y) * aSize;
  }
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`
const FOOT_FRAG = /* glsl */ `
${FRAG_OUT}
${ATMOS_GLSL}
in vec2 vCorner;
in float vKind;
in vec3 vWorld;
void main() {
  float r = length(vCorner);
  if (r > 1.0) discard;
  vec3 light = ambient(vec3(0.0, 1.0, 0.0)) * 1.15 + uSunColor * 0.5;
  float alpha;
  if (vKind < 0.5) {
    // FOAM: churning, spreading out from where the sheet lands, a ragged edge
    float a = atan(vCorner.y, vCorner.x);
    float n = texture(uNoise, vec2(a * 0.8, r * 1.6 - uTime * 0.7)).g;
    float m = texture(uNoise, vWorld.xz / 2.2 + uTime * vec2(0.08, -0.05)).r;
    alpha = (1.0 - smoothstep(0.35 + 0.35 * n, 1.0, r)) * (0.55 + 0.45 * m);
  } else {
    // MIST: a soft drifting cloud, faint
    float n = texture(uNoise, vCorner * 0.35 + vec2(uTime * 0.03, -uTime * 0.05) + vKind).r;
    alpha = (1.0 - smoothstep(0.1, 1.0, r)) * (0.12 + 0.12 * n);
  }
  gl_FragColor = vec4(applyAtmos(vec3(0.88, 0.92, 0.95) * light, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
