/**
 * The UNIVERSAL VEHICLE SUITE (skills/realistic-vehicle-system §10): every car in the garage, driven by its spec
 * sheet through the realistic drivetrain (Node + real Rapier). Every expected value comes from the car's own spec
 * (published 0–100 / top speed, redline, brake target, tyre grip) — a new car is tested by adding its spec.
 */
import { group, Groups, PhysicsWorld } from '../src/physics/PhysicsWorld'
import { TruckSim, type Controls, type TruckTune } from '../src/gameplay/vehicle/VehicleSim'
import { SPECS } from '../src/gameplay/vehicle/specs'
import { resolveSpec, type VehicleSpec } from '../src/gameplay/vehicle/drivetrain/spec'
import { Surf, type SurfaceMix } from '../src/gameplay/vehicle/drivetrain/tyre'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const R = await PhysicsWorld.load()

/** Each model as the game's loader normalises it (assets/loadModels bakeVehicle: metres, −Z forward, wheelbase
 *  centre origin, ground at y = 0) — measured from the GLBs. */
const MODELS: Record<string, { wheelPos: [number, number, number][]; wheelRadius: number; half: { x: number; y: number; z: number } }> = {
  pickup: { wheelPos: [[-0.756, 0.403, -1.551], [0.756, 0.403, -1.551], [-0.755, 0.391, 1.551], [0.756, 0.391, 1.551]], wheelRadius: 0.391, half: { x: 0.946, y: 0.973, z: 2.615 } },
  gwagen: { wheelPos: [[-0.904, 0.475, -1.426], [0.904, 0.475, -1.426], [-0.9, 0.475, 1.426], [0.9, 0.475, 1.426]], wheelRadius: 0.475, half: { x: 1.083, y: 0.946, z: 2.34 } },
  zuk: { wheelPos: [[-0.647, 0.339, -1.349], [0.647, 0.339, -1.349], [-0.647, 0.339, 1.349], [0.647, 0.339, 1.349]], wheelRadius: 0.339, half: { x: 1.084, y: 0.936, z: 2.2 } },
}

/** Ground, with an optional ramp rising toward −Z from z = −4. */
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
const onRamp = (deg: number, d = 8) => { const r = (deg * Math.PI) / 180; return [0, d * Math.sin(r), -4 - d * Math.cos(r), 0, r] as const }

function car(p: PhysicsWorld, id: keyof typeof SPECS, opts: { grip?: number; aids?: 'off' | 'std' | 'full'; surface?: number } = {}): TruckSim {
  const spec: VehicleSpec = SPECS[id], m = MODELS[id]
  const stock: TruckTune = { power: spec.power.peakPower, force: 12, boost: 2, grip: 1, suspension: 40, tyre: 1, mass: spec.mass.kerb }
  const t = new TruckSim(p, m, { ...stock, grip: opts.grip ?? 1 })
  t.setDrivetrain(resolveSpec(spec, m), stock)
  if (opts.aids) t.drivetrain!.aids = opts.aids
  if (opts.surface !== undefined) {
    const s = opts.surface
    t.surface = (_x: number, _z: number, out: SurfaceMix) => { out.w.fill(0); out.w[s] = 1 }
  }
  t.place(0, 0, 0, 0)
  return t
}

function run(p: PhysicsWorld, t: TruckSim, seconds: number, ctl: Partial<Controls>, each?: (s: number) => void): void {
  Object.assign(t.controls, { throttle: 0, steer: 0, handbrake: false, boost: false, lift: 0, parked: false, footBrake: 0, ...ctl })
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    t.step(1 / 60)
    p.world.step()
    each?.(i / 60)
  }
}
const deg = (r: number) => (r * 180) / Math.PI
/** Hottest tread surface of the car (°C, Drivetrain TYRE). */
const hottest = (s: TruckSim) => Math.max(...s.drivetrain!.treadT)
/** The foot brake the game applies with both pedals (Car BURN_BRAKE: W + S / the touch brake-stand). */
const BURN_BRAKE = 0.75
function turned(s: TruckSim): { step: () => void; total: () => number } {
  let prev = s.heading, sum = 0
  return { step: () => { let d = s.heading - prev; d = Math.atan2(Math.sin(d), Math.cos(d)); sum += d; prev = s.heading }, total: () => sum }
}

for (const id of Object.keys(SPECS) as (keyof typeof SPECS)[]) {
  const spec = SPECS[id]
  const RS = resolveSpec(spec, MODELS[id])
  const red = RS.power.wRedline * 30 / Math.PI
  console.log(`\n—— ${id} (${spec.class}, ${spec.power.kind} ${spec.power.peakPower} kW, ${spec.transmission.kind}, ${spec.drive.layout}) ——`)
  // ---------------- static ----------------
  {
    const p = world()
    const t = car(p, id)
    run(p, t, 2, {})
    const y = t.body.translation().y, a = t.attitude()
    check(`${id}: settles level at its design ride height`, Math.abs(y) < 0.03 && Math.abs(deg(a.roll)) < 1 && Math.abs(deg(a.pitch)) < 1, `y ${y.toFixed(3)} m, roll ${deg(a.roll).toFixed(2)}°, pitch ${deg(a.pitch).toFixed(2)}°`)
    // Heave: push the body down 5 cm, release, time the bounce (between the axles' ride frequencies ± 10 %).
    const b = t.body.translation()
    t.body.setTranslation({ x: b.x, y: b.y - 0.05, z: b.z }, true)
    // Height extremes are half a damped period apart (ω_d = ω·√(1 − ζ²), ζ the mean of bump and rebound).
    let lastY = t.body.translation().y, lastD = 0
    const cross: number[] = []
    run(p, t, 2, {}, (s) => { const y = t.body.translation().y, d = Math.sign(y - lastY); if (d && lastD && d !== lastD) cross.push(s); if (d) lastD = d; lastY = y })
    const f = cross.length >= 2 ? 1 / (2 * (cross[1] - cross[0])) : NaN
    const z = (RS.axles[0].zeta[0] + RS.axles[0].zeta[1]) / 2, k = Math.sqrt(1 - z * z)
    const f0 = RS.axles[0].freq * k, f1 = RS.axles[1].freq * k
    check(`${id}: heave frequency within the axles' damped ride frequencies (± 12 %)`, f > f0 * 0.88 && f < f1 * 1.12, `${f.toFixed(2)} Hz (axles ${f0.toFixed(2)} / ${f1.toFixed(2)} Hz damped)`)
    p.dispose()
  }
  {
    const p = world(15)
    const t = car(p, id)
    t.place(...onRamp(15))
    run(p, t, 3, { parked: true })
    const z0 = t.body.translation().z
    run(p, t, 6, { parked: true })
    const d = Math.abs(t.body.translation().z - z0)
    check(`${id}: parked on 15° stays put (< 2 cm in 6 s)`, d < 0.02, `${(d * 100).toFixed(1)} cm`)
    run(p, t, 3, {})
    const d2 = Math.abs(t.body.translation().z - z0)
    check(`${id}: hill hold with nobody on the pedals (< 5 cm)`, d2 < 0.05, `${(d2 * 100).toFixed(1)} cm`)
    p.dispose()
  }
  // ---------------- powertrain ----------------
  {
    const p = world()
    const t = car(p, id)
    run(p, t, 1, {})
    const D = t.drivetrain!
    let t100 = NaN, maxRpm = 0, prevGear = D.gear
    const upShifts: number[] = []
    let rpmPrev = 0, hot100 = 0
    run(p, t, 80, { throttle: 1 }, (s) => {
      if (Number.isNaN(t100)) hot100 = Math.max(hot100, hottest(t))
      if (Number.isNaN(t100) && t.speed > 100 / 3.6) t100 = s
      maxRpm = Math.max(maxRpm, D.rpm)
      if (D.gear > prevGear && prevGear >= 1) upShifts.push(rpmPrev)
      if (!D.shifting) rpmPrev = D.rpm
      prevGear = D.gear
    })
    const top = t.speed * 3.6
    const pub = spec.published ?? {}
    if (pub.zeroTo100) check(`${id}: 0–100 km/h within 15 % of the published ${pub.zeroTo100} s`, Math.abs(t100 / pub.zeroTo100 - 1) < 0.15, `${t100.toFixed(1)} s`)
    if (pub.topSpeed) check(`${id}: top speed within 10 % of the published ${pub.topSpeed} km/h`, Math.abs(top / pub.topSpeed - 1) < 0.1, `${top.toFixed(0)} km/h in ${D.gearLabel} at ${D.rpm.toFixed(0)} rpm`)
    check(`${id}: never past the redline (${red.toFixed(0)} rpm)`, maxRpm < red * 1.03, `max ${maxRpm.toFixed(0)} rpm`)
    check(`${id}: a full-throttle 0–100 only warms the tyres (< 110 °C, no fire)`, hot100 < 110 && !t.drivetrain!.burning, `${hot100.toFixed(0)} °C`)
    if (upShifts.length) {
      const want = 0.93 * red * (spec.power.kind === 'diesel' ? 0.85 : 1)
      const ok = upShifts.every((r) => Math.abs(r / want - 1) < 0.06)
      check(`${id}: full-throttle upshifts at ~93 % of the redline`, ok, `${upShifts.map((r) => r.toFixed(0)).join(', ')} rpm (target ${want.toFixed(0)})`)
    }
    p.dispose()
  }
  {
    // Kickdown: cruising at ~70 km/h on light throttle, a stab of full throttle drops a gear within 0.3 s.
    const p = world()
    const t = car(p, id)
    const D = t.drivetrain!
    run(p, t, 1, {})
    while (t.speed < 70 / 3.6) run(p, t, 0.1, { throttle: 1 })
    run(p, t, 6, { throttle: 0.2 })
    const g0 = D.gear
    // A gear down is possible if it lands under 85 % of the redline — then it must come; else it must not.
    const can = D.stepped && g0 > 1 && (D.rpm * RS.gearbox.ratios[g0 - 2]) / RS.gearbox.ratios[g0 - 1] < 0.85 * red
    let kd = NaN
    run(p, t, 1, { throttle: 1 }, (s) => { if (Number.isNaN(kd) && (D.shifting || D.gear < g0)) kd = s })
    if (!can && D.stepped) check(`${id}: no kickdown when the gear below would over-rev (${g0} at ${(t.speed * 3.6).toFixed(0)} km/h)`, Number.isNaN(kd) || D.gear >= g0, `${D.gearLabel}`)
    else if (g0 > 1) check(`${id}: kickdown within 0.3 s (from ${D.stepped ? g0 : '-'} at ${(t.speed * 3.6).toFixed(0)} km/h)`, kd <= 0.3, `${Number.isNaN(kd) ? 'none' : kd.toFixed(2) + ' s'}`)
    p.dispose()
  }
  {
    // A steady 5° climb at a held 50 km/h (a driver's foot: PI on the speed) doesn't hunt between gears.
    const p = world(5, 4000, 600)
    const t = car(p, id)
    t.place(...onRamp(5, 2))
    let shifts = 0, g = 0, iTerm = 0.4
    const hold = () => {
      const e = 50 / 3.6 - t.speed
      iTerm = Math.max(0, Math.min(1, iTerm + (e * 0.15) / 60))
      return Math.max(0, Math.min(1, iTerm + e * 0.15))
    }
    for (let k = 0; k < 60 * 15; k++) run(p, t, 1 / 60, { throttle: hold() })
    g = t.drivetrain!.gear
    for (let k = 0; k < 60 * 10; k++) {
      run(p, t, 1 / 60, { throttle: hold() })
      if (t.drivetrain!.gear !== g) (shifts++, (g = t.drivetrain!.gear))
    }
    check(`${id}: ≤ 1 shift in 10 s on a steady 5° climb at 50 km/h`, shifts <= 1, `${shifts} shifts, ${(t.speed * 3.6).toFixed(0)} km/h in ${t.drivetrain!.gearLabel}`)
    p.dispose()
  }
  // ---------------- traction ----------------
  {
    // Launch on ice-like grip: wheelspin with TCS off, controlled slip with it on.
    for (const aids of ['off', 'std'] as const) {
      const p = world()
      const t = car(p, id, { grip: 0.15, aids })
      run(p, t, 1, {})
      let maxK = 0, rimOverGround = 0
      run(p, t, 3, { throttle: 1 }, (s) => {
        const D = t.drivetrain!
        if (s > 0.5) for (let i = 0; i < 4; i++) maxK = Math.max(maxK, D.kappa[i])
        if (s > 1) rimOverGround = Math.max(rimOverGround, t.wheelSpeed / Math.max(0.3, t.speed))
      })
      if (aids === 'off') check(`${id}: launch on grip 0.15, TCS off → wheelspin (rim > 1.5 × ground)`, rimOverGround > 1.5, `rim/ground ${rimOverGround.toFixed(2)}`)
      else check(`${id}: launch on grip 0.15, TCS on → slip held (κ < 0.3)`, maxK < 0.3, `max κ ${maxK.toFixed(2)}`)
      p.dispose()
    }
  }
  if (RS.drive.low > 1) {
    const p = world(35)
    const t = car(p, id)
    t.place(...onRamp(35, 6))
    run(p, t, 0.5, {})
    // Low range and every locker the car has — what its driver would select for a 35° climb.
    const D = t.drivetrain!
    D.toggleLow(0)
    for (let k = 0; k < 3 && D.locks.size < RS.drive.lockers.length; k++) D.cycleLockers()
    const y0 = t.body.translation().y
    // A driver feathers it (60 %): flooring a car without traction control in 4L just spins the tyres.
    run(p, t, 12, { throttle: 0.6 })
    const climbed = t.body.translation().y - y0
    check(`${id}: climbs a 35° slope in low range (locked: ${[...D.locks].join(', ') || 'none'})`, climbed > 6 && t.axesUp() > 0.5, `+${climbed.toFixed(1)} m`)
    p.dispose()
  }
  // OFF-ROAD ASSIST (gameplay, on by default in Settings): an 80° wall is drivable in 1st on asphalt and grass —
  // climbs, never flips, low gears, and holds still when the driver stops on it.
  for (const surf of [Surf.Asphalt, Surf.Grass]) {
    const p = world(80, 4000, 200)
    const t = car(p, id, { surface: surf })
    t.offroadAssist = true
    t.place(...onRamp(80, 6))
    run(p, t, 0.5, {})
    const D = t.drivetrain!, y0 = t.body.translation().y
    let minUp = 1, maxGear = 0
    run(p, t, 8, { throttle: 0.8 }, () => ((minUp = Math.min(minUp, t.axesUp())), (maxGear = Math.max(maxGear, D.gear))))
    const climbed = t.body.translation().y - y0
    run(p, t, 5, {}) // (coming to rest from up to ~40 km/h up the wall)
    const yStop = t.body.translation().y
    run(p, t, 3, {})
    const slid = Math.abs(t.body.translation().y - yStop)
    check(`${id}: off-road assist — 80° wall on ${surf === Surf.Grass ? 'grass' : 'asphalt'} climbed in 1st/2nd, holds when stopped`, climbed > 15 && minUp > 0.05 && maxGear <= 2 && slid < 0.1, `+${climbed.toFixed(1)} m, gears ≤ ${maxGear}, held to ${(slid * 100).toFixed(1)} cm`)
    p.dispose()
  }
  // ---------------- grip ----------------
  {
    // Skidpad: a steady circle at the limit; lateral g ≈ μ·g (± 20 % — load transfer, AT tyres).
    const p = world()
    const t = car(p, id, { aids: 'off' })
    run(p, t, 1, {})
    run(p, t, 4, { throttle: 0.6 })
    let maxLat = 0, maxRoll = 0
    const lat: number[] = []
    for (let k = 0; k < 600; k++) {
      // Hold ~the speed that saturates the tyres at full lock; measure v·yaw rate.
      const thr = t.speed < 15 ? 0.5 : 0.2
      run(p, t, 1 / 60, { throttle: thr, steer: 1 })
      const w = t.body.angvel()
      const a = Math.abs(t.speed * w.y)
      lat.push(a)
      maxRoll = Math.max(maxRoll, Math.abs(t.attitude().roll))
    }
    lat.sort((x, y) => x - y)
    maxLat = lat[Math.floor(lat.length * 0.9)]
    const mu = t.drivetrain!.grips[0].mu
    check(`${id}: skidpad lateral ≈ μ·g (${(mu * 9.81).toFixed(1)} m/s², ± 25 %) without rolling over`, maxLat > mu * 9.81 * 0.75 && maxLat < mu * 9.81 * 1.25 && t.axesUp() > 0.8, `${maxLat.toFixed(1)} m/s², max roll ${deg(maxRoll).toFixed(1)}°`)
    p.dispose()
  }
  {
    // TYRE HEAT at the limit: 30 s (~3 laps) of a steady circle at the car's cornering limit (half lock, 50 km/h
    // held, full aids so no car spins off its line) — the tyres warm to working temperature, never smoke or burn.
    const p = world()
    const t = car(p, id, { aids: 'full' })
    run(p, t, 1, {})
    while (t.speed < 14) run(p, t, 0.1, { throttle: 0.6 })
    const lat: number[] = []
    let hot = 0
    for (let k = 0; k < 60 * 30; k++) {
      run(p, t, 1 / 60, { throttle: Math.max(0, Math.min(0.6, 0.3 + 0.3 * (14 - t.speed))), steer: 0.5 * Math.min(1, k / 120) })
      if (k > 300) lat.push(Math.abs(t.speed * t.body.angvel().y))
      hot = Math.max(hot, hottest(t))
    }
    lat.sort((a, b) => a - b)
    const g50 = lat[lat.length >> 1] / 9.81
    check(`${id}: 30 s cornering at its limit (${g50.toFixed(2)} g) only warms the tyres (< 110 °C, no fire)`, g50 > 0.6 && hot < 110 && !t.drivetrain!.burning, `${hot.toFixed(0)} °C`)
    p.dispose()
  }
  {
    // Handbrake at speed while steering: the rear slides (|slip| > 15°), the car stays on its wheels.
    const p = world()
    const t = car(p, id, { aids: 'off' })
    run(p, t, 1, {})
    run(p, t, 6, { throttle: 1 })
    let maxSlip = 0
    run(p, t, 1.5, { throttle: 0, steer: 0.6, handbrake: true }, () => { maxSlip = Math.max(maxSlip, Math.atan2(Math.abs(t.lateral), Math.max(1, Math.abs(t.speed)))) })
    check(`${id}: handbrake turn slides the rear (> 15°) without rolling over`, deg(maxSlip) > 15 && t.axesUp() > 0.8, `slip ${deg(maxSlip).toFixed(0)}°`)
    p.dispose()
  }
  {
    // DRIFT (aids off — the driver's job): a handbrake flick at 50 km/h, then (a) firm counter-steer CATCHES it
    // (slide < 10° within 2.5 s, no spin; lifting to 20 % — an open diff on 40 % keeps spinning its inside wheel) and (b) a balanced throttle + proportional counter-steer HOLDS it
    // (15–57° for ≥ 1 s) on asphalt — the rear can be steered on the throttle, the car never just spins away.
    const flick = (ks: number) => {
      const p = world()
      const t = car(p, id, { aids: 'off' })
      run(p, t, 1, {})
      while (t.speed < 50 / 3.6) run(p, t, 0.1, { throttle: 1 })
      run(p, t, 0.45, { throttle: 0, steer: 0.8, handbrake: true })
      const slip = () => Math.atan2(t.lateral, Math.max(1, Math.abs(t.speed)))
      let held = 0, maxS = 0
      for (let k = 0; k < 150; k++) {
        const s = slip()
        maxS = Math.max(maxS, Math.abs(s))
        if (Math.abs(s) > 0.26 && Math.abs(s) < 1) held += 1 / 60
        run(p, t, 1 / 60, { throttle: ks > 1.3 ? 0.2 : Math.max(0, Math.min(1, 0.75 + 3 * (0.5 - Math.abs(s)))), steer: Math.max(-1, Math.min(1, s * ks)) })
      }
      const r = { held, maxS, end: Math.abs(slip()), up: t.axesUp() }
      p.dispose()
      return r
    }
    const c = flick(1.4)
    check(`${id}: a handbrake slide can be CAUGHT (counter-steer → straight, no spin)`, c.end < 0.18 && c.maxS < 1.2 && c.up > 0.9, `max ${deg(c.maxS).toFixed(0)}°, end ${deg(c.end).toFixed(0)}°`)
    if (id === 'pickup') {
      const h = flick(1.1)
      check(`${id}: a drift can be HELD on throttle + counter-steer (15–57° ≥ 1 s, LSD rear)`, h.held >= 1 && h.up > 0.9, `held ${h.held.toFixed(1)} s, max ${deg(h.maxS).toFixed(0)}°`)
    }
  }
  // ---------------- burnout + tyre heat ----------------
  // BRAKE-STAND (W + S): the brakes (front-biased) hold the fronts, the engine spins the driven rears against their
  // brakes. A car driving its rear axle only (rear-drive, part-time 4WD in 2H) does it; a permanent 4×4 can't hold
  // its driven fronts (it creeps off), like the real thing. Aids off (a 1989 pickup / 1972 van: the real car's).
  const rearDrive = RS.drive.layout === 'part-time-4WD' /* (2H) */ || (!RS.axles[0].driven && RS.drive.layout !== 'AWD-permanent' && RS.drive.layout !== 'AWD-on-demand')
  if (rearDrive) {
    const p = world()
    const t = car(p, id, { aids: 'off' })
    const D = t.drivetrain!, r = RS.axles[RS.axles.length - 1].radius, last = (RS.axles.length - 1) * 2
    run(p, t, 1, {})
    const z0 = t.body.translation().z
    let rim5 = 0, v5 = 0, hot5 = 0, fireAt = NaN, maxMove = 0, notD = 0
    run(p, t, 30, { throttle: 1, footBrake: BURN_BRAKE }, (s) => {
      maxMove = Math.max(maxMove, Math.abs(t.body.translation().z - z0))
      if (D.selector !== 'D' || D.gear < 1) notD++
      if (s <= 5) hot5 = Math.max(hot5, hottest(t))
      if (Math.abs(s - 5) < 1 / 120) (rim5 = Math.max(Math.abs(D.omega[last]), Math.abs(D.omega[last + 1])) * r), (v5 = Math.abs(t.speed))
      if (Number.isNaN(fireAt) && D.burning) fireAt = s
    })
    check(`${id}: brake-stand burnout — the rears spin (rim ≫ ground), the car stays put (< 1 m), never selects R`, rim5 > 4 && rim5 > 10 * v5 && maxMove < 1 && notD === 0, `rim ${rim5.toFixed(1)} m/s vs ground ${v5.toFixed(2)} m/s, moved ${maxMove.toFixed(2)} m`)
    check(`${id}: burnout heats the tread past 150 °C within 5 s (heavy smoke)`, hot5 > 150, `${hot5.toFixed(0)} °C at 5 s`)
    check(`${id}: a burnout held long enough sets a tyre ALIGHT (< 30 s)`, fireAt < 30, `${Number.isNaN(fireAt) ? 'no fire' : `fire at ${fireAt.toFixed(1)} s`}, ${hottest(t).toFixed(0)} °C`)
    // Released and driven off at ~50 km/h: the air puts the fire out and the tyres cool.
    run(p, t, 3, { throttle: 0 })
    const burntHot = hottest(t)
    let outAt = NaN
    for (let k = 0; k < 60 * 15; k++) {
      run(p, t, 1 / 60, { throttle: Math.max(0, Math.min(0.5, 0.3 + 0.2 * (14 - t.speed))) })
      if (Number.isNaN(outAt) && !D.burning) outAt = k / 60
    }
    check(`${id}: driving off puts the tyre fire out and cools the tread`, outAt < 10 && !D.burning && hottest(t) < burntHot - 150, `out after ${Number.isNaN(outAt) ? '—' : outAt.toFixed(1)} s, ${burntHot.toFixed(0)} → ${hottest(t).toFixed(0)} °C`)
    p.dispose()
  }
  if (rearDrive) {
    // A short burnout (4 s, no fire), then released at a standstill: the tread cools (it keeps no heat source).
    const p = world()
    const t = car(p, id, { aids: 'off' })
    run(p, t, 1, {})
    run(p, t, 4, { throttle: 1, footBrake: BURN_BRAKE })
    const h0 = hottest(t)
    run(p, t, 20, {})
    const h1 = hottest(t)
    check(`${id}: after a short burnout the tyres cool at rest`, !t.drivetrain!.burning && h1 < h0 - 0.4 * (h0 - 20), `${h0.toFixed(0)} → ${h1.toFixed(0)} °C in 20 s`)
    p.dispose()
  }
  // ---------------- brakes ----------------
  {
    const p = world()
    const t = car(p, id)
    run(p, t, 1, {})
    while (t.speed < 80 / 3.6) run(p, t, 0.1, { throttle: 1 })
    run(p, t, 0.3, { throttle: 0 })
    const v0 = t.speed, z0 = t.body.translation().z
    const h = turned(t)
    let dist = NaN
    run(p, t, 8, { throttle: -1 }, () => { h.step(); if (Number.isNaN(dist) && t.speed < 0.3) dist = Math.abs(t.body.translation().z - z0) })
    // Without ABS the brakes are sized just under lock-up: full pedal gives 92 % of the target (Drivetrain).
    const ideal = (v0 * v0) / (2 * RS.brakes.maxDecel * (RS.brakes.abs ? 1 : 0.92) * 9.81)
    check(`${id}: brakes ${(v0 * 3.6).toFixed(0)}→0 straight in ~v²/2a (${ideal.toFixed(0)} m, ± 20 %${RS.brakes.abs ? ', ABS' : ''})`, dist > ideal * 0.85 && dist < ideal * 1.25 /* + the 0.15 s pedal ramp */ && Math.abs(deg(h.total())) < 3, `${dist.toFixed(1)} m, heading ${deg(h.total()).toFixed(1)}°`)
    p.dispose()
  }
  if (RS.brakes.abs) {
    const p = world()
    const t = car(p, id)
    run(p, t, 1, {})
    while (t.speed < 80 / 3.6) run(p, t, 0.1, { throttle: 1 })
    const h = turned(t)
    run(p, t, 3, { throttle: -1, steer: 1 }, () => h.step())
    check(`${id}: ABS — braking hard while steering still turns (> 15°)`, Math.abs(deg(h.total())) > 15, `${deg(h.total()).toFixed(0)}°`)
    p.dispose()
  }
  {
    // ESC (Full) lane change at 25 m/s on dirt: the slide stays under 35°.
    const p = world()
    const t = car(p, id, { aids: 'full', surface: Surf.Dirt })
    run(p, t, 1, {})
    while (t.speed < 22) run(p, t, 0.1, { throttle: 1 })
    let maxSlip = 0
    const track = () => { maxSlip = Math.max(maxSlip, Math.atan2(Math.abs(t.lateral), Math.max(1, Math.abs(t.speed)))) }
    run(p, t, 0.6, { throttle: 0.3, steer: 1 }, track)
    run(p, t, 0.8, { throttle: 0.3, steer: -1 }, track)
    run(p, t, 1.5, { throttle: 0.3 }, track)
    check(`${id}: ESC lane change at ${(22 * 3.6).toFixed(0)} km/h on dirt stays < 35° of slide`, deg(maxSlip) < 35 && t.axesUp() > 0.8, `max slip ${deg(maxSlip).toFixed(0)}°`)
    p.dispose()
  }
  // ---------------- body ----------------
  {
    const p = world()
    const t = car(p, id)
    t.place(0, 1.5, 0, 0)
    let minY = 9
    run(p, t, 3, {}, () => (minY = Math.min(minY, t.body.translation().y)))
    check(`${id}: a 1.5 m drop never passes through the ground`, minY > -0.4 && t.axesUp() > 0.95, `lowest y ${minY.toFixed(2)} m`)
    p.dispose()
  }
  {
    // Boat handoff: the hull out (boat ≥ 0.5) takes over — no wheel torque; folded away, it drives off again.
    const p = world()
    const t = car(p, id)
    run(p, t, 1, {})
    t.boat = 1
    run(p, t, 2, { throttle: 1 })
    const crawl = t.speed
    t.boat = 0
    run(p, t, 1, {})
    run(p, t, 4, { throttle: 1 })
    check(`${id}: boat handoff — keel crawl with the hull out, drives off normally after`, crawl < 4.6 && t.speed > 8 && t.drivetrain!.gear >= 1, `crawl ${crawl.toFixed(1)} m/s, then ${t.speed.toFixed(1)} m/s in ${t.drivetrain!.gearLabel}`)
    p.dispose()
  }
}

process.exit(failures ? 1 : 0)
