import type * as THREE from 'three'
import type { MapData } from './MapData'

/**
 * TERRAIN OCCLUSION CULLING — what the hills hide. From the camera, AZ rays march out over the height grid (from 6 m
 * to the reach, each sample 5.5 % farther than the last), each keeping the highest elevation (as a slope, rise / run)
 * met so far: the HORIZON along that ray at every distance. A box (a tree tile, a rock cell, a bush tile) whose
 * highest point is under the horizon in every azimuth it spans — the horizon taken nearer than the box — stands
 * behind the ground and is skipped. Conservative: the box's own highest slope is taken at its nearest corner, the
 * azimuths it spans ± one ray are all checked, and a small margin is kept (no popping at a ridge's edge).
 * The eye is taken 1.2 m above the camera (a higher eye sees more: safe while the camera bobs); rebuilt when the
 * camera has moved 4 m, rose past that eye or sank 6 m: 320 × ~104 height samples ≈ 0.4–0.9 ms, a few times a
 * second at most while driving; a query is ~10–40 array reads.
 */
const AZ = 320
const D0 = 6
const RATIO = 1.06
const MARGIN = 0.004 // (slope units: ~0.2°)
const EYE = 1.2

export class Horizon {
  private readonly dist: Float32Array
  private readonly max: Float32Array // AZ × NR: the highest slope met along the ray up to (and including) sample k
  private readonly nr: number
  private cx = Number.NaN
  private cy = 0
  private cz = 0
  /** Off (?occlusion=0): nothing is ever hidden. */
  enabled = true
  /** Rebuilds so far (the HUD). */
  builds = 0

  constructor(private readonly map: MapData, reach: number) {
    let n = 0
    for (let d = D0; d < reach * 1.02; d *= RATIO) n++
    this.nr = n
    this.dist = new Float32Array(n)
    for (let k = 0, d = D0; k < n; k++, d *= RATIO) this.dist[k] = d
    this.max = new Float32Array(AZ * n)
  }

  /** Call once a frame (cheap unless the camera moved far enough to rebuild). */
  update(cam: THREE.Vector3): void {
    if (!this.enabled) return
    const dx = cam.x - this.cx, dz = cam.z - this.cz
    if (dx * dx + dz * dz < 16 && cam.y < this.cy - 0.1 && cam.y > this.cy - 6) return
    this.cx = cam.x; this.cy = cam.y + EYE; this.cz = cam.z
    const eye = this.cy
    this.builds++
    const n = this.nr, D = this.dist, M = this.max, map = this.map
    for (let a = 0; a < AZ; a++) {
      const t = (a / AZ) * Math.PI * 2, ux = Math.cos(t), uz = Math.sin(t)
      let m = -1e9
      const o = a * n
      for (let k = 0; k < n; k++) {
        const d = D[k]
        const s = (map.height(cam.x + ux * d, cam.z + uz * d) - eye) / d
        if (s > m) m = s
        M[o + k] = m
      }
    }
  }

  /** Is the box [x0, x1] × [z0, z1] up to height `top` hidden behind the ground? */
  hidden(x0: number, z0: number, x1: number, z1: number, top: number): boolean {
    if (!this.enabled || Number.isNaN(this.cx)) return false
    const cx = this.cx, cz = this.cz
    // nearest / farthest distance of the box
    const nx = Math.max(x0 - cx, 0, cx - x1), nz = Math.max(z0 - cz, 0, cz - z1)
    const dn = Math.hypot(nx, nz)
    if (dn < D0 * 2) return false
    const fx = Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx)), fz = Math.max(Math.abs(z0 - cz), Math.abs(z1 - cz))
    const df = Math.hypot(fx, fz)
    // its highest slope as seen from the eye: at its nearest point if it rises above the eye, else at its farthest
    const rise = top - this.cy
    const sBox = rise > 0 ? rise / dn : rise / df
    // the horizon sample just nearer than the box
    const k = Math.floor(Math.log(dn / D0) / Math.log(RATIO)) - 1
    if (k < 0) return false
    const kk = Math.min(k, this.nr - 1)
    // the azimuths the box spans (its four corners; it never contains the camera here)
    let amin = Infinity, amax = -Infinity
    const a0 = Math.atan2(z0 - cz, x0 - cx)
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      let a = Math.atan2(z - cz, x - cx) - a0
      a = Math.atan2(Math.sin(a), Math.cos(a)) // (relative to the first corner: no wrap at ±π)
      if (a < amin) amin = a
      if (a > amax) amax = a
    }
    const step = (Math.PI * 2) / AZ
    const b0 = Math.floor((a0 + amin) / step) - 1, b1 = Math.ceil((a0 + amax) / step) + 1
    const n = this.nr, M = this.max
    for (let b = b0; b <= b1; b++) {
      const a = ((b % AZ) + AZ) % AZ
      if (M[a * n + kk] < sBox + MARGIN) return false // (seen along this ray)
    }
    return true
  }
}
