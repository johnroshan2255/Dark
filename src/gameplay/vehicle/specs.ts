import type { VehicleSpec } from './drivetrain/spec'

/**
 * The real machines behind the garage cars (skills/realistic-vehicle-system §8.4): public spec sheets, resolved at
 * load against each model's measured wheelbase and track (drivetrain/spec.ts resolveSpec). Kept apart from the
 * catalogue so the Node tests can import them (the catalogue imports model URLs through Vite).
 */
export const SPECS: Record<'pickup' | 'gwagen' | 'zuk', VehicleSpec> = {
  // A 1989 Hilux Xtra Cab 4×4 (22R-E): 85 kW / 192 N·m, W56 5-speed, RF1A transfer case (low 2.28), IFS front,
  // leaf-sprung live rear axle, front discs / rear drums, no ABS. 0–100 and top speed: period road tests (≈).
  pickup: {
    class: 'pickup',
    published: { zeroTo100: 14.5, topSpeed: 145, turningCircle: 11.8 },
    mass: { kerb: 1600, frontShare: 0.56 },
    power: { kind: 'petrol', peakPower: 85, powerRpm: 4800, peakTorque: 192, torqueRpm: 3400, redline: 5400, idle: 800 },
    transmission: { kind: 'manual', ratios: [3.954, 2.141, 1.384, 1.0, 0.85], reverse: 4.091, final: 4.1 },
    drive: { layout: 'part-time-4WD', low: 2.28, lockers: ['centre'] },
    axles: [
      { suspension: 'double-wishbone', steered: true, tyre: '31x10.50R15', tyreKind: 'at', brake: 'disc', travel: 0.2 },
      // Rear: the factory limited-slip option — it is what lets a rear-drive truck hold a slide on the throttle.
      { suspension: 'solid-leaf', tyre: '31x10.50R15', tyreKind: 'at', brake: 'drum', travel: 0.28, diff: 'lsd' },
    ],
    brakes: { abs: false },
    aids: 'off', // 1989: no traction or stability control
    aero: { cd: 0.5, frontalArea: 2.9 },
  },
  // G500 4×4² (2015): M176 4.0 V8 biturbo 310 kW / 610 N·m (2250–4750), 7G-Tronic Plus (ratios verified),
  // permanent 4MATIC 50:50 with three locking diffs, low range 2.1, portal axles, 325/55R22, 3021 kg, 0–100 7.4 s,
  // 210 km/h (limited). Final drive 5.4 is derived (portal + axle reduction), not published.
  gwagen: {
    class: 'offroader',
    published: { zeroTo100: 7.4, topSpeed: 210, turningCircle: 13.6 },
    mass: { kerb: 3021, frontShare: 0.52, comHeight: 0.95 },
    power: { kind: 'turbo-petrol', peakPower: 310, powerRpm: 5250, peakTorque: 610, torqueRpm: [2250, 4750], redline: 6000, idle: 650, turbo: { from: 1800, lag: 0.4 } },
    transmission: { kind: 'auto', ratios: [4.377, 2.859, 1.921, 1.368, 1.0, 0.82, 0.728], reverse: 3.416, final: 5.4 },
    drive: { layout: 'AWD-permanent', centre: 'open', split: 0.5, low: 2.1, lockers: ['centre', 'rear', 'front'] },
    axles: [
      { suspension: 'portal', steered: true, tyre: '325/55R22', tyreKind: 'at', travel: 0.3 },
      { suspension: 'portal', tyre: '325/55R22', tyreKind: 'at', travel: 0.3 },
    ],
    brakes: { abs: true },
    aero: { cd: 0.54, frontalArea: 4.0 },
  },
  // Żuk A06 (1972): S-21 2.12 L petrol, 51.5 kW / 147 N·m, 4-speed manual (ratios approximate), rear drive on a
  // leaf-sprung live axle, Warszawa wishbone front, drums all round, 6.50-16 bias-ply tyres, 100 km/h.
  zuk: {
    class: 'van',
    published: { topSpeed: 100, turningCircle: 12.5 },
    mass: { kerb: 1480, frontShare: 0.5 },
    power: { kind: 'petrol', peakPower: 51.5, powerRpm: 4000, peakTorque: 147, torqueRpm: 2300, redline: 4400, idle: 700 },
    transmission: { kind: 'manual', ratios: [3.6, 2.2, 1.45, 1.0], reverse: 4.0 },
    drive: { layout: 'FR' },
    axles: [
      { suspension: 'double-wishbone', steered: true, tyre: '6.50-16', tyreKind: 'road', brake: 'drum', travel: 0.18 },
      { suspension: 'solid-leaf', tyre: '6.50-16', tyreKind: 'road', brake: 'drum', travel: 0.24 },
    ],
    brakes: { abs: false },
    aids: 'off', // 1972: none
    aero: { cd: 0.5, frontalArea: 3.2 },
  },
}
