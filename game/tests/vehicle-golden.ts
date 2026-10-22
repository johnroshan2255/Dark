/**
 * VEHICLE GOLDEN TRACES for the server's Rust port (`server/crates/vehicle`): the game's own TruckSim + Drivetrain
 * (Node + real Rapier, as tests/drivetrain.test.ts runs them) driven through fixed scenarios. Per physics step it
 * records the drivetrain's inputs (driver, chassis, wheels, grips, the state TruckSim hands it) and outputs, and the
 * body's state. The Rust tests replay the drivetrain step-for-step (it must match to rounding) and run the whole car
 * on the same ground (the trajectory must stay within tolerance).
 *   npm run golden:vehicle   (writes ../server/crates/vehicle/golden/*.json — rerun after changing the car model)
 */
import fs from 'node:fs'
import { group, Groups, PhysicsWorld } from '../src/physics/PhysicsWorld'
import { TruckSim, type Controls, type TruckTune } from '../src/gameplay/vehicle/VehicleSim'
import { SPECS } from '../src/gameplay/vehicle/specs'
import { resolveSpec, type VehicleSpec } from '../src/gameplay/vehicle/drivetrain/spec'
import type { ChassisIn, DriverInput, WheelIn } from '../src/gameplay/vehicle/drivetrain/Drivetrain'

// (run from game/: the bundle lives in node_modules/.cache, so paths are cwd-relative)
const OUT = '../server/crates/vehicle/golden/'
fs.mkdirSync(OUT, { recursive: true })
const R = await PhysicsWorld.load()

/** The models as the game's loader normalises them (same numbers as tests/drivetrain.test.ts). */
const MODELS: Record<string, { wheelPos: [number, number, number][]; wheelRadius: number; half: { x: number; y: number; z: number } }> = {
  pickup: { wheelPos: [[-0.756, 0.403, -1.551], [0.756, 0.403, -1.551], [-0.755, 0.391, 1.551], [0.756, 0.391, 1.551]], wheelRadius: 0.391, half: { x: 0.946, y: 0.973, z: 2.615 } },
  gwagen: { wheelPos: [[-0.904, 0.475, -1.426], [0.904, 0.475, -1.426], [-0.9, 0.475, 1.426], [0.9, 0.475, 1.426]], wheelRadius: 0.475, half: { x: 1.083, y: 0.946, z: 2.34 } },
  zuk: { wheelPos: [[-0.647, 0.339, -1.349], [0.647, 0.339, -1.349], [-0.647, 0.339, 1.349], [0.647, 0.339, 1.349]], wheelRadius: 0.339, half: { x: 1.084, y: 0.936, z: 2.2 } },
}

interface Phase { secs: number; ctl: Partial<Controls> }
interface Scenario { name: string; car: keyof typeof SPECS; ramp?: number; phases: Phase[] }

const SCENARIOS: Scenario[] = [
  // accelerate, a held turn, brake to a stop, roll
  ...(['pickup', 'gwagen', 'zuk'] as const).map((car): Scenario => ({
    name: `drive-${car}`,
    car,
    phases: [
      { secs: 3, ctl: { throttle: 1 } },
      { secs: 2, ctl: { throttle: 1, steer: 0.6 } },
      { secs: 2, ctl: { throttle: -1 } },
      { secs: 1, ctl: {} },
    ],
  })),
  // up a 15° ramp from a standstill
  { name: 'ramp-pickup', car: 'pickup', ramp: 15, phases: [{ secs: 5, ctl: { throttle: 1 } }] },
]

function world(rampDeg = 0, half = 4000, L = 60): PhysicsWorld {
  const p = new PhysicsWorld(R)
  const ground = p.world.createRigidBody(R.RigidBodyDesc.fixed())
  p.world.createCollider(R.ColliderDesc.cuboid(half, 0.5, half).setTranslation(0, -0.5, 0).setCollisionGroups(group(Groups.Terrain, 0xffff)), ground)
  if (rampDeg > 0) {
    const t = (rampDeg * Math.PI) / 180
    const q = { x: Math.sin(t / 2), y: 0, z: 0, w: Math.cos(t / 2) }
    const off = { y: 0.5 * Math.cos(t) - L * Math.sin(t), z: 0.5 * Math.sin(t) + L * Math.cos(t) }
    p.world.createCollider(R.ColliderDesc.cuboid(8, 0.5, L).setRotation(q).setTranslation(0, -off.y, -4 - off.z).setCollisionGroups(group(Groups.Terrain, 0xffff)), ground)
  }
  return p
}
/** The ramp box as the Rust test builds it (half extents, centre, rotation xyzw). */
function rampBox(rampDeg: number, L = 60) {
  const t = (rampDeg * Math.PI) / 180
  const off = { y: 0.5 * Math.cos(t) - L * Math.sin(t), z: 0.5 * Math.sin(t) + L * Math.cos(t) }
  return { half: [8, 0.5, L], at: [0, -off.y, -4 - off.z], rot: [Math.sin(t / 2), 0, 0, Math.cos(t / 2)] }
}

const r6 = (x: number) => x // full precision: the replay must start from the same numbers

for (const sc of SCENARIOS) {
  const p = world(sc.ramp ?? 0)
  const spec: VehicleSpec = SPECS[sc.car], m = MODELS[sc.car]
  const stock: TruckTune = { power: spec.power.peakPower, force: 12, boost: 2, grip: 1, suspension: 40, tyre: 1, mass: spec.mass.kerb }
  const t = new TruckSim(p, m, stock)
  const resolved = resolveSpec(spec, m)
  // (as resolved: TruckSim.configure later sets each axle's radius to the model's wheel radius in place)
  const resolvedCopy = structuredClone(resolved)
  t.setDrivetrain(resolved, stock)
  t.place(0, 0, 0, 0)
  const D = t.drivetrain!
  const steps: unknown[] = []
  let cur: Record<string, unknown> = {}
  const orig = D.step.bind(D)
  D.step = (dt: number, din: DriverInput, ch: ChassisIn, w: WheelIn[]) => {
    cur.dt = { dt, din: { ...din }, ch: { ...ch }, w: w.map((x) => ({ ...x })), grips: D.grips.map((g) => ({ ...g })),
      airT: [...D.airT], wetT: [...D.wetT], assistYaw: D.assistYaw, torqueBoost: D.torqueBoost, steepHold: D.steepHold,
      steepClimb: D.steepClimb, nitro: D.nitro, centre: D.locks.has('centre') }
    orig(dt, din, ch, w)
    cur.out = { Fx: [...D.Fx], Fy: [...D.Fy], omega: [...D.omega], spin: [...D.spin], steer: [...D.steer], we: D.we, gear: D.gear,
      gas: D.gas, brake: D.brake, treadT: [...D.treadT],
      dbg: (({ shifting, clutch }, x) => ({ shifting, clutch, tcs: x.tcs, lockup: x.lockup, Tcarrier: x.Tcarrier, absRel: [...x.absRel], escBrake: [...x.escBrake], tcsBrake: [...x.tcsBrake], burnClutch: x.burnClutch }))(D, D as unknown as Record<string, any>) }
  }
  for (const ph of sc.phases) {
    Object.assign(t.controls, { throttle: 0, steer: 0, handbrake: false, boost: false, lift: 0, parked: false, footBrake: 0, ...ph.ctl })
    for (let i = 0; i < Math.round(ph.secs * 60); i++) {
      cur = {}
      t.step(1 / 60)
      p.world.step()
      const b = t.body, tr = b.translation(), q = b.rotation(), lv = b.linvel(), av = b.angvel()
      cur.ctl = { ...t.controls }
      cur.body = { p: [tr.x, tr.y, tr.z].map(r6), q: [q.x, q.y, q.z, q.w], v: [lv.x, lv.y, lv.z], w: [av.x, av.y, av.z], speed: t.speed }
      steps.push(cur)
    }
  }
  const def = { id: sc.car, dims: m, stock, resolved: resolvedCopy }
  const out = { scenario: sc.name, ramp: sc.ramp ? rampBox(sc.ramp) : null, def, aids: D.aids, steps }
  fs.writeFileSync(`${OUT}${sc.name}.json`, JSON.stringify(out))
  const last = steps[steps.length - 1] as { body: { p: number[] } }
  console.log(`golden ${sc.name}: ${steps.length} steps, end ${last.body.p.map((x) => x.toFixed(2)).join(', ')}`)
}
