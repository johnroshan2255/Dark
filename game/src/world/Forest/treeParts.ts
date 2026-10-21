import * as THREE from 'three'
import { ATLAS_CELLS, cellUv, SOLID_UV } from '../../rendering/materials/FoliageAtlas'
import type { Rng } from '../noise/rng'

/** Shared building blocks of the procedural trees (treeFactory, genshinTrees). */
export type V3 = [number, number, number]
export const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

/** Triangle soup with explicit normals, uvs and colours. */
export class Soup {
  readonly pos: number[] = []
  readonly nor: number[] = []
  readonly uv: number[] = []
  readonly col: number[] = []
  readonly bbC: number[] = []
  readonly bbO: number[] = []
  vert(p: V3, n: V3, uv: readonly [number, number], c: THREE.Color, bbCenter?: V3, bbOff?: [number, number]): void {
    this.bbC.push(...(bbCenter ?? [0, 0, 0]))
    this.bbO.push(...(bbOff ?? [0, 0]))
    this.pos.push(p[0], p[1], p[2])
    // Zero-length normals → NaN in the shader → bright blobs spread by the paint filter/bloom. Guard them.
    const l = Math.hypot(n[0], n[1], n[2])
    if (l < 1e-5) this.nor.push(0, 1, 0)
    else this.nor.push(n[0] / l, n[1] / l, n[2] / l)
    this.uv.push(uv[0], uv[1])
    this.col.push(c.r, c.g, c.b)
  }
  geometry(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('bbCenter', new THREE.Float32BufferAttribute(this.bbC, 3))
    g.setAttribute('bbOff', new THREE.Float32BufferAttribute(this.bbO, 2))
    g.name = name
    g.computeBoundingSphere()
    return g
  }
}

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/**
 * Camera-facing fluffy TUFT (billboarded in the vertex shader): quad of half-size `r` at `c`, normal from the
 * crown centre `crown` (the canopy lights as one soft volume), colour dark→light bottom→top.
 */
export function tuft(s: Soup, c: V3, r: number, crown: V3, dark: THREE.Color, light: THREE.Color): void {
  const [u0, v0, u1, v1] = cellUv(ATLAS_CELLS.tuft)
  const n: V3 = [c[0] - crown[0], (c[1] - crown[1]) * 0.8 + 0.25, c[2] - crown[2]]
  const up = Math.max(0, Math.min(1, (c[1] - crown[1]) * 0.3 + 0.5))
  const cb = dark.clone().lerp(light, up * 0.7), ct = dark.clone().lerp(light, 0.35 + up * 0.65)
  const q: [number, number, number, number, THREE.Color][] = [[-r, -r, u0, v0, cb], [r, -r, u1, v0, cb], [r, r, u1, v1, ct], [-r, r, u0, v1, ct]]
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const [ox, oy, u, v, col] = q[i]
    // Authored position = flat quad in XY (what the shadow pass sees); the shader re-orients it to the camera.
    s.vert([c[0] + ox, c[1] + oy, c[2]], n, [u, v], col, c, [ox, oy])
  }
}

/** Lump of a crown: jittered icosahedron whose normals point from the CROWN centre (unified soft shading). */
export function crownLump(s: Soup, c: V3, r: number, crown: V3, rng: Rng, dark: THREE.Color, light: THREE.Color, detail: number, flat = 0.9, uv: readonly [number, number] = SOLID_UV): void {
  // detail −1 = octahedron (8 tris: cheap cores for the mid/far levels, hidden under tufts or far away).
  const g = detail < 0 ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, detail)
  const p = g.getAttribute('position')
  const j = new Map<string, number>()
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
    const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`
    if (!j.has(key)) j.set(key, rng.range(0.85, 1.12))
    const k = j.get(key)!
    const v: V3 = [c[0] + x * r * k, c[1] + y * r * k * flat, c[2] + z * r * k]
    const n: V3 = [v[0] - crown[0], (v[1] - crown[1]) * 1.2 + 0.3, v[2] - crown[2]]
    const up = THREE.MathUtils.clamp((v[1] - crown[1]) / 1.6 * 0.5 + 0.5, 0, 1)
    s.vert(v, n, uv, dark.clone().lerp(light, up))
  }
  g.dispose()
}

