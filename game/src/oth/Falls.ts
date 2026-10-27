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
      const ms = f.hw * 1.8 + H * 0.4
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
// (2026-10-27, "real waterfall effect like in Over the Hill — cheap"): PAINTED in three tones — deep teal where the
// water is a clear sheet, light aqua, white foam — not a frosted pane. Two noise layers race down at different scales
// and speeds (big slow ropes of water, fast fine strands); the lip a smooth glassy curl (dark teal, a bright line where
// it breaks over); whiter as it falls (air beaten into it); the edges torn into strands; the foot lost in white spray.
const vec3 DEEP = vec3(0.07, 0.25, 0.3);
const vec3 AQUA = vec3(0.36, 0.66, 0.72);
const vec3 FOAM = vec3(0.9, 0.95, 0.97);
void main() {
  float down = vUV.y * vDrop, across = vUV.x * 2.2;
  float t = vUV.y;
  float a1 = texture(uNoise, vec2(across / 1.1, (down - uTime * 5.0) / 11.0)).r;
  float a2 = texture(uNoise, vec2(across / 0.32 + 0.37, (down - uTime * 7.5) / 3.2)).g;
  float v = 0.55 * a1 + 0.45 * a2 + 0.28 * smoothstep(0.05, 0.7, t) - 0.12;
  // the lip: a smooth glassy curl over the first metre, then it breaks
  float lip = 1.0 - smoothstep(0.0, min(0.35, 1.2 / vDrop), t);
  v = mix(v, 0.18 + 0.15 * a1, lip);
  // three painted tones, a soft step between them
  vec3 c = mix(DEEP, AQUA, smoothstep(0.36, 0.42, v));
  c = mix(c, FOAM, smoothstep(0.55, 0.61, v));
  float brk = (1.0 - smoothstep(0.0, 0.03, abs(t - min(0.3, 1.0 / vDrop)))) * 0.8; // (the bright line where it breaks)
  c = mix(c, FOAM, brk);
  // the foot: white spray
  c = mix(c, FOAM, smoothstep(0.78, 0.97, t));
  // torn edges (strands), the clear sheet see-through a little, the spray thinning out at the bottom
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vUV.x) + (a2 - 0.5) * 0.5 + (a1 - 0.5) * 0.2);
  float alpha = edge * mix(0.72, 1.0, smoothstep(0.36, 0.6, v)) * smoothstep(0.0, 0.02, t) * (1.0 - smoothstep(0.9, 1.0, t) * (0.5 + 0.5 * a2));
  if (alpha < 0.02) discard;
  // lit like the stylized rock: the sun, the sky, soft (a falling sheet faces every way at once)
  vec3 light = ambient(vec3(0.0, 1.0, 0.0)) * 1.25 + uSunColor * 0.55;
  gl_FragColor = vec4(applyAtmos(c * light, vWorld), alpha);
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
    float ring = 0.5 + 0.5 * sin((r * 7.0 - uTime * 2.2) * 3.1416 + n * 3.0); // (rings of foam running out)
    alpha = (1.0 - smoothstep(0.3 + 0.35 * n, 1.0, r)) * (0.5 + 0.35 * m + 0.25 * ring * smoothstep(0.2, 0.6, r));
  } else {
    // MIST: a soft white cloud of spray, churning (a painted puff, not a fog)
    float n = texture(uNoise, vCorner * 0.35 + vec2(uTime * 0.03, -uTime * 0.05) + vKind).r;
    float n2 = texture(uNoise, vCorner * 0.9 - vec2(uTime * 0.07, uTime * 0.11) + vKind * 0.3).g;
    alpha = (1.0 - smoothstep(0.15 + 0.25 * n2, 1.0, r)) * (0.16 + 0.2 * n) * (vKind > 1.2 ? 0.8 : 1.0);
  }
  gl_FragColor = vec4(applyAtmos(vec3(0.88, 0.92, 0.95) * light, vWorld), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
