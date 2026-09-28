import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Placeholder low-poly player (cap, hoodie, backpack, jeans — refer/characters) until the
 * AI-generated rig passes the asset pipeline. 5 meshes = 5 draw calls, all on the shared Lambert
 * vertex-colour program. Procedural walk cycle: limb groups rotate about hips/shoulders.
 * Faces −Z in local space (same convention as the camera).
 */
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

function box(w: number, h: number, d: number, color: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
  g.deleteAttribute('uv')
  g.translate(x, y, z)
  const c = srgb(color)
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) c.toArray(col, i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

function merged(parts: THREE.BufferGeometry[], name: string): THREE.BufferGeometry {
  const g = mergeGeometries(parts)!
  parts.forEach((p) => p.dispose())
  g.name = name
  g.computeBoundingSphere()
  return g
}

const JEANS = 0x2d3a55
const HOODIE = 0x2b3550
const SKIN = 0xc89a78
const CAP = 0x8e1f22
const PACK = 0x4a4f55
const SHOE = 0x1a1a1a

export class CharacterModel {
  readonly root = new THREE.Group()
  private readonly body: THREE.Mesh
  private readonly legL = new THREE.Group()
  private readonly legR = new THREE.Group()
  private readonly armL = new THREE.Group()
  private readonly armR = new THREE.Group()
  private readonly meshes: THREE.Mesh[] = []
  private readonly geos: THREE.BufferGeometry[] = []
  private phase = 0
  /** Body yaw (smoothed toward movement / aim). */
  yaw = 0

  constructor(material: THREE.Material) {
    this.root.name = 'player-character'
    this.root.rotation.order = 'YXZ' // knockdown tips relative to facing
    const bodyGeo = merged(
      [
        box(0.42, 0.56, 0.24, HOODIE, 0, 1.13, 0),
        box(0.24, 0.26, 0.24, SKIN, 0, 1.55, 0),
        box(0.27, 0.09, 0.27, CAP, 0, 1.71, 0),
        box(0.23, 0.03, 0.15, CAP, 0, 1.675, -0.19),
        box(0.34, 0.42, 0.16, PACK, 0, 1.16, 0.2),
        box(0.4, 0.1, 0.22, JEANS, 0, 0.86, 0),
      ],
      'character.body',
    )
    const legGeo = merged([box(0.16, 0.78, 0.18, JEANS, 0, -0.39, 0), box(0.18, 0.08, 0.27, SHOE, 0, -0.8, -0.04)], 'character.leg')
    const armGeo = merged([box(0.12, 0.52, 0.13, HOODIE, 0, -0.26, 0), box(0.1, 0.1, 0.1, SKIN, 0, -0.57, 0)], 'character.arm')
    const armRGeo = merged(
      [box(0.12, 0.52, 0.13, HOODIE, 0, -0.26, 0), box(0.1, 0.1, 0.1, SKIN, 0, -0.57, 0), box(0.06, 0.06, 0.2, 0x333333, 0, -0.62, -0.06)],
      'character.armR',
    )
    this.geos.push(bodyGeo, legGeo, armGeo, armRGeo)
    this.body = this.mesh(bodyGeo, material)
    this.root.add(this.body)
    const limb = (grp: THREE.Group, geo: THREE.BufferGeometry, x: number, y: number) => {
      grp.position.set(x, y, 0)
      grp.add(this.mesh(geo, material))
      this.root.add(grp)
    }
    limb(this.legL, legGeo, -0.1, 0.84)
    limb(this.legR, legGeo, 0.1, 0.84)
    limb(this.armL, armGeo, -0.28, 1.37)
    limb(this.armR, armRGeo, 0.28, 1.37)
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(g, m)
    this.meshes.push(mesh)
    return mesh
  }

  set castShadow(v: boolean) {
    for (const m of this.meshes) m.castShadow = v
  }

  /**
   * @param speed horizontal m/s   @param grounded   @param aimPitch camera pitch (arm follows when aiming)
   * @param aiming flashlight on → right arm raised forward
   */
  animate(dt: number, pos: THREE.Vector3, targetYaw: number, speed: number, grounded: boolean, aiming: boolean, aimPitch: number): void {
    // Shortest-arc yaw smoothing.
    let d = targetYaw - this.yaw
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.yaw += d * (1 - Math.exp(-12 * dt))
    const amount = Math.min(1, speed / 4)
    this.phase += dt * (3 + speed * 1.6)
    const swing = Math.sin(this.phase) * 0.75 * amount
    if (grounded) {
      this.legL.rotation.x = swing
      this.legR.rotation.x = -swing
    } else {
      this.legL.rotation.x = -0.5
      this.legR.rotation.x = 0.25
    }
    this.armL.rotation.x = -swing * 0.8
    this.armR.rotation.x = aiming ? Math.PI / 2 + aimPitch * 0.8 : swing * 0.8
    const bob = grounded ? Math.abs(Math.sin(this.phase)) * 0.045 * amount : 0
    this.root.position.set(pos.x, pos.y + bob, pos.z)
    this.root.rotation.set(0, this.yaw, 0)
  }

  /** Riding pose on the BMX: seated, hands on the bars, legs pedalling, leaning with the bike. */
  ride(pos: THREE.Vector3, heading: number, pedal: number, lean: number): void {
    this.yaw = heading
    this.root.position.set(pos.x, pos.y + 0.12, pos.z)
    this.root.position.x += Math.sin(heading) * -0.12
    this.root.position.z += Math.cos(heading) * -0.12
    this.root.rotation.set(0.28, heading, lean, 'YXZ') // lean forward over the bars
    this.legL.rotation.x = -1.05 + Math.sin(pedal) * 0.55
    this.legR.rotation.x = -1.05 + Math.sin(pedal + Math.PI) * 0.55
    this.armL.rotation.x = -1.15
    this.armR.rotation.x = -1.15
  }

  /** World position of the right hand (flashlight origin in TPP). */
  handPosition(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld()
    return out.set(0, -0.62, -0.16).applyMatrix4(this.armR.matrixWorld)
  }

  dispose(): void {
    this.geos.forEach((g) => g.dispose())
  }
}

/** Soft round blob shadow (grounds the character on tiers without real dynamic shadows). */
export function createBlobShadow(): THREE.Mesh {
  const size = 64
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2)
      const a = Math.max(0, 1 - r) ** 1.6
      // alphaMap is sampled from the GREEN channel (three.js convention) — write the falloff into RGB too.
      const v = Math.round(a * 255)
      data.set([v, v, v, 255], (y * size + x) * 4)
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.needsUpdate = true
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, opacity: 0.45, depthWrite: false, fog: true })
  mat.polygonOffset = true
  mat.polygonOffsetFactor = -2
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2), mat)
  mesh.name = 'player-blob-shadow'
  mesh.renderOrder = 1
  return mesh
}
