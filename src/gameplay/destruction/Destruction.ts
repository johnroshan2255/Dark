import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import { group, Groups, type PhysicsWorld, type PropRef } from '../../physics/PhysicsWorld'
import { PropType } from '../../world/POI/poiLayout'

/**
 * DESTRUCTION: the truck smashes roadside and farm props. Each breakable type has a STRENGTH (impact speed, m/s,
 * for a 1750 kg truck — a heavier vehicle breaks things slower, a lighter one needs more speed) and a LOSS (the
 * share of the truck's speed the crash eats). Below the strength the prop is solid (you stop against a post);
 * above it the prop is gone: its collider removed, its instance hidden in the chunk (WorldChunk.breakProp), and
 * it bursts into physics DEBRIS that tumble and settle, then sink away after a while.
 * Broken props are remembered per chunk (`PhysicsWorld.broken`) and REBUILT when the chunk unloads — drive away
 * and come back and the fence is standing again (deterministic world + a per-visit damage list; co-op can sync it).
 *
 * Debris: a pool of ≤ MAX_DEBRIS small dynamic boxes (Rapier) drawn as ONE instanced mesh; the oldest piece is
 * recycled when the pool is full. Cost: 1 draw; physics only while pieces exist (they sleep once settled).
 */
interface DebrisSpec {
  /** Pieces: half extents (m, at prop scale 1) and colour. */
  pieces: { half: [number, number, number]; color: number; n: number }[]
}
interface Breakable {
  speed: number
  loss: number
  debris: DebrisSpec
}

const WOOD = 0x6b4a30, DARK_WOOD = 0x4a3324, BARN_RED = 0x8c2f22, WALL = 0xd8d2c4, ROOF = 0x5a3d33, STRAW = 0xd9b45a, STONE = 0x8a8a84, CANVAS = 0x9c8f6a
export const BREAKABLES: Record<number, Breakable> = {
  // Power-line post: needs real speed (~31 km/h); the post itself falls over + a few splinters.
  0: { speed: 8.5, loss: 0.3, debris: { pieces: [{ half: [0.15, 4.3, 0.15], color: DARK_WOOD, n: 1 }, { half: [0.05, 0.25, 0.05], color: WOOD, n: 4 }] } },
  // Fence section: snaps at a jog (~8 km/h), barely slows you.
  1: { speed: 2.2, loss: 0.05, debris: { pieces: [{ half: [0.04, 0.06, 0.9], color: WOOD, n: 3 }, { half: [0.05, 0.55, 0.05], color: DARK_WOOD, n: 1 }] } },
  [PropType.Hay]: { speed: 2.5, loss: 0.1, debris: { pieces: [{ half: [0.3, 0.25, 0.3], color: STRAW, n: 5 }] } },
  [PropType.Woodpile]: { speed: 2.5, loss: 0.08, debris: { pieces: [{ half: [0.07, 0.07, 0.45], color: WOOD, n: 7 }] } },
  [PropType.Tent]: { speed: 2, loss: 0.04, debris: { pieces: [{ half: [0.5, 0.02, 0.6], color: CANVAS, n: 3 }, { half: [0.03, 0.5, 0.03], color: WOOD, n: 2 }] } },
  [PropType.RuinPillar]: { speed: 10, loss: 0.4, debris: { pieces: [{ half: [0.3, 0.35, 0.3], color: STONE, n: 4 }] } },
  [PropType.RuinWall]: { speed: 14, loss: 0.5, debris: { pieces: [{ half: [0.4, 0.3, 0.25], color: STONE, n: 7 }] } },
  // Buildings: only a fast truck (~65–80 km/h) goes through a wall; it costs most of the speed.
  [PropType.Cabin]: { speed: 18, loss: 0.6, debris: { pieces: [{ half: [0.12, 0.12, 1.4], color: WOOD, n: 8 }, { half: [1.1, 0.06, 0.9], color: ROOF, n: 3 }] } },
  [PropType.House]: { speed: 21, loss: 0.65, debris: { pieces: [{ half: [1.2, 0.9, 0.12], color: WALL, n: 7 }, { half: [1.3, 0.06, 1.1], color: ROOF, n: 4 }] } },
  [PropType.Barn]: { speed: 22, loss: 0.65, debris: { pieces: [{ half: [1.4, 1.0, 0.12], color: BARN_RED, n: 8 }, { half: [1.5, 0.06, 1.2], color: ROOF, n: 4 }] } },
}

const MAX_DEBRIS = 48
const LIFE = 14 // s before a piece sinks away
const STOCK_MASS = 1750

interface Piece {
  body: RAPIER.RigidBody
  age: number
  half: THREE.Vector3
  color: THREE.Color
}

export interface BreakEvent {
  ref: PropRef
  speed: number
}

export class Destruction {
  readonly mesh: THREE.InstancedMesh
  private readonly pieces: Piece[] = []
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly p = new THREE.Vector3()
  private readonly sc = new THREE.Vector3()
  /** Breaks queued by the contact events of a physics step (applied after the step). */
  private readonly queue: { handle: number; speed: number; v: { x: number; y: number; z: number } }[] = []
  /** Called for each prop broken (WorldChunk hides it, audio, camera shake). */
  onBreak: ((e: BreakEvent) => void) | null = null
  /** The vehicle that can smash things: its body handle, mass and pre-contact velocity. */
  vehicle: { body: () => RAPIER.RigidBody | null; mass: () => number; preVel: () => { x: number; y: number; z: number } } | null = null
  stats = { broken: 0, debris: 0 }

  constructor(private readonly physics: PhysicsWorld, material: THREE.Material) {
    const g = new THREE.BoxGeometry(2, 2, 2)
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3))
    this.mesh = new THREE.InstancedMesh(g, material, MAX_DEBRIS)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.castShadow = true
    this.mesh.name = 'debris'
    physics.breakable = (t) => t in BREAKABLES
    physics.onContactForce = (h1, h2) => this.contact(h1, h2)
    physics.afterStep = () => this.applyBreaks()
  }

  /** A contact force on a breakable collider: smash it if the vehicle hit it fast enough. */
  private contact(h1: number, h2: number): void {
    const ph = this.physics
    const propH = ph.props.has(h1) ? h1 : ph.props.has(h2) ? h2 : -1
    if (propH < 0 || !this.vehicle) return
    const other = this.physics.world.getCollider(propH === h1 ? h2 : h1)
    const vb = this.vehicle.body()
    if (!other || !vb || other.parent()?.handle !== vb.handle) return
    const ref = ph.props.get(propH)!
    const v = this.vehicle.preVel()
    const speed = Math.hypot(v.x, v.z)
    const need = BREAKABLES[ref.type].speed * Math.sqrt(STOCK_MASS / Math.max(400, this.vehicle.mass()))
    if (speed >= need && !this.queue.some((e) => e.handle === propH)) this.queue.push({ handle: propH, speed, v: { ...v } })
  }

  /** Right after the physics step whose contacts asked for it (PhysicsWorld.afterStep): smash the props. */
  private applyBreaks(): void {
    if (!this.queue.length) return
    const vb = this.vehicle?.body()
    let keep = 1
    let pre: { x: number; y: number; z: number } | null = null
    for (const { handle, speed, v } of this.queue) {
      const ref = this.physics.props.get(handle)
      if (!ref) continue
      const b = BREAKABLES[ref.type]
      keep = Math.min(keep, 1 - b.loss)
      pre = v
      this.physics.removeProp(handle)
      let set = this.physics.broken.get(ref.key)
      if (!set) this.physics.broken.set(ref.key, (set = new Set()))
      set.add(ref.index)
      this.spawn(ref, b, v, speed)
      this.stats.broken++
      this.onBreak?.({ ref, speed })
    }
    this.queue.length = 0
    // The crash costs `loss` of the speed — not the full stop the (now removed) solid collider produced.
    if (vb && pre) vb.setLinvel({ x: pre.x * keep, y: vb.linvel().y, z: pre.z * keep }, true)
  }

  /** Every frame: age, sink and recycle debris; draw the pieces. */
  update(dt: number): void {
    // Debris: sink and remove after LIFE seconds; draw the rest.
    let n = 0
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const pc = this.pieces[i]
      pc.age += dt
      if (pc.age > LIFE + 2) {
        this.physics.world.removeRigidBody(pc.body)
        this.pieces.splice(i, 1)
      }
    }
    for (const pc of this.pieces) {
      const t = pc.body.translation(), r = pc.body.rotation()
      const sink = Math.max(0, pc.age - LIFE) * 0.4
      this.p.set(t.x, t.y - sink, t.z)
      this.q.set(r.x, r.y, r.z, r.w)
      this.sc.copy(pc.half)
      this.m.compose(this.p, this.q, this.sc)
      this.mesh.setMatrixAt(n, this.m)
      this.mesh.setColorAt(n, pc.color)
      n++
    }
    this.mesh.count = n
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.mesh.instanceColor!.needsUpdate = true
    }
    this.stats.debris = n
  }

  private spawn(ref: PropRef, b: Breakable, v: { x: number; y: number; z: number }, speed: number): void {
    const R = this.physics.R
    let k = 0
    for (const spec of b.debris.pieces) {
      for (let i = 0; i < spec.n; i++, k++) {
        if (this.pieces.length >= MAX_DEBRIS) {
          const old = this.pieces.shift()!
          this.physics.world.removeRigidBody(old.body)
        }
        const hx = spec.half[0] * ref.scale, hy = spec.half[1] * ref.scale, hz = spec.half[2] * ref.scale
        const h = (a: number) => Math.sin((ref.index + 1) * 12.9898 + k * 78.233 + a) * 0.5 + 0.5 // deterministic jitter
        // Spread the pieces over the prop's footprint / height, rotated with it.
        const lx = (h(1) - 0.5) * 1.6 * ref.scale, lz = (h(2) - 0.5) * 1.6 * ref.scale
        const c = Math.cos(ref.rot), s = Math.sin(ref.rot)
        const x = ref.x + lx * c + lz * s, z = ref.z - lx * s + lz * c
        const y = ref.y + hy + h(3) * (spec.half[1] > 1 ? 0.5 : 1.6) * ref.scale
        const body = this.physics.world.createRigidBody(
          R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
            .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ref.rot, 0)))
            .setLinearDamping(0.15).setAngularDamping(0.4).setCcdEnabled(speed > 15),
        )
        this.physics.world.createCollider(
          R.ColliderDesc.cuboid(hx, hy, hz).setDensity(spec.half[1] > 1 ? 120 : 350).setFriction(0.8).setRestitution(0.15)
            .setCollisionGroups(group(Groups.Debris, Groups.Terrain | Groups.Static | Groups.Vehicle | Groups.Player | Groups.Debris)),
          body,
        )
        // Thrown along with the truck (a share of its speed), up a little, tumbling.
        const throwK = 0.55 + 0.35 * h(4)
        body.setLinvel({ x: v.x * throwK + (h(5) - 0.5) * 3, y: 1.5 + h(6) * 3 + speed * 0.08, z: v.z * throwK + (h(7) - 0.5) * 3 }, true)
        body.setAngvel({ x: (h(8) - 0.5) * 8, y: (h(9) - 0.5) * 6, z: (h(10) - 0.5) * 8 }, true)
        this.pieces.push({ body, age: 0, half: new THREE.Vector3(hx, hy, hz), color: new THREE.Color().setHex(spec.color, THREE.SRGBColorSpace) })
      }
    }
  }

  dispose(): void {
    for (const pc of this.pieces) this.physics.world.removeRigidBody(pc.body)
    this.pieces.length = 0
    this.mesh.geometry.dispose()
  }
}
