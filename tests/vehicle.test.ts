/**
 * Vehicle simulation tests (Node + real Rapier): the truck and the bike are dynamic raycast vehicles
 * (src/gameplay/vehicle/VehicleSim.ts). Checks the behaviour a player feels: acceleration, top speed, braking,
 * cornering without flipping, hill climbing; the bike stays balanced, leans INTO turns, climbs moderate hills
 * and falls over when nobody balances it.
 */
import { group, Groups, PhysicsWorld } from '../src/physics/PhysicsWorld'
import { BikeSim, TruckSim, type Controls } from '../src/gameplay/vehicle/VehicleSim'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const log = process.env.VERBOSE ? console.log : () => {}

const R = await PhysicsWorld.load()

/** Truck dimensions as normalised from pickup_truck.lod0.glb (assets/loadModels). */
const TRUCK = {
  wheelPos: [[-0.74, 0.386, -1.513], [0.74, 0.386, -1.513], [-0.74, 0.386, 1.513], [0.74, 0.386, 1.513]] as [number, number, number][],
  wheelRadius: 0.386,
  half: { x: 0.866, y: 1.11, z: 2.55 },
}
const BIKE = { front: [0, 0.28, -0.476] as [number, number, number], rear: [0, 0.28, 0.442] as [number, number, number], wheelRadius: 0.28 }

function world(rampDeg = 0): PhysicsWorld {
  const p = new PhysicsWorld(R)
  const ground = p.world.createRigidBody(R.RigidBodyDesc.fixed())
  p.world.createCollider(R.ColliderDesc.cuboid(400, 0.5, 400).setTranslation(0, -0.5, 0).setCollisionGroups(group(Groups.Terrain, 0xffff)).setFriction(0.9), ground)
  if (rampDeg > 0) {
    // Ramp surface starts at z = −4 on the ground and rises toward −Z.
    const t = (rampDeg * Math.PI) / 180, L = 60
    const q = { x: Math.sin(t / 2), y: 0, z: 0, w: Math.cos(t / 2) }
    const off = { y: 0.5 * Math.cos(t) - L * Math.sin(t), z: 0.5 * Math.sin(t) + L * Math.cos(t) }
    p.world.createCollider(
      R.ColliderDesc.cuboid(6, 0.5, L).setRotation(q).setTranslation(0, -off.y, -4 - off.z).setCollisionGroups(group(Groups.Terrain, 0xffff)).setFriction(0.9),
      ground,
    )
  }
  return p
}

function run(p: PhysicsWorld, sim: TruckSim | BikeSim, seconds: number, ctl: Partial<Controls>, each?: (t: number) => void): void {
  Object.assign(sim.controls, { throttle: 0, steer: 0, handbrake: false, boost: false, ...ctl })
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    sim.step(1 / 60)
    p.world.step()
    each?.(i / 60)
  }
}
const pos = (s: TruckSim | BikeSim) => s.body.translation()
/** Heading change accumulated step by step (no ±π wrap — a 4.5 rad left turn must not read as −1.8). */
function turned(s: TruckSim | BikeSim): { step: () => void; total: () => number } {
  let prev = s.heading, sum = 0
  return { step: () => { let d = s.heading - prev; d = Math.atan2(Math.sin(d), Math.cos(d)); sum += d; prev = s.heading }, total: () => sum }
}

// ---------------- TRUCK ----------------
{
  const p = world()
  const t = new TruckSim(p, TRUCK)
  t.place(0, 0, 0, 0)
  run(p, t, 1.5, {})
  const rest = pos(t).y
  const att = t.attitude()
  check('truck settles level on its suspension', Math.abs(rest) < 0.08 && Math.abs(att.roll) < 0.01 && Math.abs(att.pitch) < 0.02, `ride height ${rest.toFixed(3)} m, roll ${att.roll.toFixed(3)}, pitch ${att.pitch.toFixed(3)}`)
  let t20 = NaN
  run(p, t, 14, { throttle: 1 }, (s) => { if (Number.isNaN(t20) && t.speed >= 20) t20 = s })
  const top = t.speed
  check('truck 0→20 m/s (72 km/h)', t20 > 3 && t20 < 9, `${t20.toFixed(1)} s`)
  check('truck top speed ~ 90–110 km/h', top > 24 && top < 31, `${top.toFixed(1)} m/s`)
  const z0 = pos(t).z, v0 = t.speed
  let stop = NaN, tStop = NaN
  run(p, t, 8, { throttle: -1 }, (s) => { if (Number.isNaN(stop) && t.speed < 0.5) (stop = Math.abs(pos(t).z - z0)), (tStop = s) })
  check('truck brakes from top speed', stop > 15 && stop < 70, `${v0.toFixed(1)} m/s → stop in ${stop.toFixed(1)} m / ${tStop.toFixed(1)} s, then reverses (${t.speed.toFixed(1)} m/s)`)
  p.dispose()
}
{
  // Hard turn at speed: body rolls outward but stays on its wheels; heading turns right with D.
  const p = world()
  const t = new TruckSim(p, TRUCK)
  t.place(0, 0, 0, 0)
  run(p, t, 3.5, { throttle: 1 })
  const v = t.speed
  let maxRoll = 0
  const tr = turned(t)
  run(p, t, 3, { throttle: 0.4, steer: 1 }, () => (tr.step(), (maxRoll = Math.max(maxRoll, Math.abs(t.attitude().roll)))))
  const dh = tr.total()
  check('truck steers right with D (heading decreases)', dh < -0.5 && dh > -4, `Δheading ${dh.toFixed(2)} rad in 3 s from ${v.toFixed(1)} m/s`)
  check('truck corners hard without flipping', maxRoll < 0.3 && t.axesUp() > 0.9, `max roll ${(maxRoll * 57.3).toFixed(1)}°`)
  p.dispose()
}
{
  // GARAGE tuning: a heavier, bigger-tyred, stiffer setup still settles level; retune() changes it live.
  const p = world()
  const t = new TruckSim(p, TRUCK, { power: 300, force: 18, boost: 2, grip: 2.8, suspension: 44, tyre: 1.3, mass: 3000 })
  t.place(0, 0, 0, 0)
  run(p, t, 1.5, {})
  const att = t.attitude()
  check('tuned truck (3 t, 1.3× tyres) settles level', Math.abs(pos(t).y) < 0.12 && Math.abs(att.pitch) < 0.03 && t.wheelRadius > TRUCK.wheelRadius * 1.25, `ride ${pos(t).y.toFixed(3)} m, tyre r ${t.wheelRadius.toFixed(3)}`)
  t.retune({ mass: 1200, tyre: 0.9, suspension: 30 })
  run(p, t, 1.5, {})
  check('retune() live: lighter + smaller tyres still level', Math.abs(pos(t).y) < 0.12 && Math.abs(t.attitude().pitch) < 0.03 && t.axesUp() > 0.99, `ride ${pos(t).y.toFixed(3)} m`)
  run(p, t, 6, { throttle: 1 })
  check('retuned truck drives', t.speed > 12, `${t.speed.toFixed(1)} m/s`)
  p.dispose()
}
{
  // BOOST: Shift / touch BOOST — clearly faster off the line and a higher top speed, still stable.
  const p = world()
  const t = new TruckSim(p, TRUCK)
  t.place(0, 0, 0, 0)
  let t20 = NaN
  run(p, t, 14, { throttle: 1, boost: true }, (s) => { if (Number.isNaN(t20) && t.speed >= 20) t20 = s })
  check('boost: 0→72 km/h clearly quicker', t20 > 1.5 && t20 < 3.8, `${t20.toFixed(1)} s (no boost 4.7 s)`)
  check('boost: top speed ~ 110–140 km/h', t.speed > 30 && t.speed < 39 && t.axesUp() > 0.95, `${t.speed.toFixed(1)} m/s`)
  p.dispose()
}
{
  // DRIFT: handbrake + steer at speed → the rear steps out (a real sideways slide, the effects see tyre slip),
  // the truck stays on its wheels, and it straightens out again once the handbrake is released.
  const p = world()
  const t = new TruckSim(p, TRUCK)
  t.place(0, 0, 0, 0)
  run(p, t, 4, { throttle: 1 })
  const v = t.speed
  let maxLat = 0, maxSlip = 0, driftFrames = 0, maxRoll = 0
  run(p, t, 1.6, { throttle: 0.6, steer: 1, handbrake: true }, () => {
    maxLat = Math.max(maxLat, Math.abs(t.lateral))
    maxSlip = Math.max(maxSlip, t.wheelSlip[2], t.wheelSlip[3])
    if (t.drifting) driftFrames++
    maxRoll = Math.max(maxRoll, Math.abs(t.attitude().roll))
  })
  check('truck drifts on the handbrake (rear slides out)', maxLat > 3 && driftFrames > 30 && maxSlip > 0.5, `from ${v.toFixed(1)} m/s: lateral ${maxLat.toFixed(1)} m/s, rear slip ${maxSlip.toFixed(2)}, ${driftFrames} drift frames`)
  check('drift keeps the truck on its wheels', maxRoll < 0.35 && t.axesUp() > 0.9, `max roll ${(maxRoll * 57.3).toFixed(1)}°`)
  run(p, t, 3, { throttle: 0.5 })
  check('truck recovers from the drift', Math.abs(t.lateral) < 1.5 && !t.drifting && t.drift < 0.15 && t.axesUp() > 0.9, `lateral ${t.lateral.toFixed(2)} m/s, drift ${t.drift.toFixed(2)}`)
  p.dispose()
}
{
  // No drift from normal cornering: a brisk turn without the handbrake keeps its grip.
  const p = world()
  const t = new TruckSim(p, TRUCK)
  t.place(0, 0, 0, 0)
  run(p, t, 3, { throttle: 1 })
  let driftFrames = 0, maxLat = 0
  run(p, t, 2.5, { throttle: 0.5, steer: 1 }, () => { if (t.drifting) driftFrames++; maxLat = Math.max(maxLat, Math.abs(t.lateral)) })
  check('ordinary cornering does not drift', driftFrames === 0 && maxLat < 3.5, `lateral ${maxLat.toFixed(1)} m/s, ${driftFrames} drift frames`)
  p.dispose()
}
/** Start ON the slope (real hills have no 55° kink at the bottom — the bumper would hit it first). */
const onRamp = (deg: number, d = 6) => { const r = (deg * Math.PI) / 180; return [0, d * Math.sin(r), -4 - d * Math.cos(r), 0, r] as const }
for (const deg of [20, 35, 45, 55, 60]) {
  const p = world(deg)
  const t = new TruckSim(p, TRUCK)
  t.place(...onRamp(deg))
  run(p, t, 10, { throttle: 1 })
  const y = pos(t).y - onRamp(deg)[1]
  log(`truck ramp ${deg}°: height ${y.toFixed(1)} m, speed ${t.speed.toFixed(1)}`)
  check(`truck climbs a ${deg}° slope from standstill`, y > 8 && t.axesUp() > 0.3, `+${y.toFixed(1)} m in 10 s, ${t.speed.toFixed(1)} m/s`)
  p.dispose()
}

// ---------------- BIKE ----------------
{
  const p = world()
  const b = new BikeSim(p, BIKE)
  b.place(0, 0, 0, 0)
  let maxRoll = 0
  run(p, b, 8, { throttle: 1 }, () => (maxRoll = Math.max(maxRoll, Math.abs(b.attitude().roll))))
  check('bike stays balanced pedalling straight', maxRoll < 0.08 && b.axesUp() > 0.95, `max roll ${(maxRoll * 57.3).toFixed(1)}°, ${b.speed.toFixed(1)} m/s`)
  check('bike cruising speed (human power)', b.speed > 7 && b.speed < 14, `${b.speed.toFixed(1)} m/s`)
  let lean = 0
  const tr = turned(b)
  run(p, b, 2.5, { throttle: 0.5, steer: 1 }, () => (tr.step(), (lean = b.attitude().roll)))
  check('bike leans INTO a right turn and turns right', lean > 0.12 && tr.total() < -0.6 && b.axesUp() > 0.6, `lean ${(lean * 57.3).toFixed(1)}° (target ${(b.targetLean * 57.3).toFixed(1)}°), Δheading ${tr.total().toFixed(2)}`)
  const tl = turned(b)
  run(p, b, 2.5, { throttle: 0.5, steer: -1 }, () => (tl.step(), (lean = b.attitude().roll)))
  check('bike leans into a left turn and turns left', lean < -0.12 && tl.total() > 0.6 && b.axesUp() > 0.6, `lean ${(lean * 57.3).toFixed(1)}°, Δheading ${tl.total().toFixed(2)}`)
  b.balancing = false
  run(p, b, 3, {})
  check('unbalanced bike falls over', Math.abs(b.attitude().roll) > 0.9, `roll ${(b.attitude().roll * 57.3).toFixed(0)}°`)
  p.dispose()
}
for (const [deg, want] of [[12, true], [18, true], [32, false]] as const) {
  const p = world(deg)
  const b = new BikeSim(p, BIKE)
  b.place(...onRamp(deg, 3))
  run(p, b, 10, { throttle: 1 })
  const y = pos(b).y - onRamp(deg, 3)[1]
  log(`bike ramp ${deg}°: height ${y.toFixed(1)} m, speed ${b.speed.toFixed(1)}`)
  check(want ? `bike climbs a ${deg}° slope` : `bike can't pedal up a ${deg}° slope (push it)`, (y > 4) === want && b.axesUp() > 0.85, `+${y.toFixed(1)} m in 10 s`)
  p.dispose()
}

process.exit(failures ? 1 : 0)
