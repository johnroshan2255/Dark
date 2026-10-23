import type { VehicleSpec } from './drivetrain/spec'

/**
 * The real machines behind the garage cars (skills/realistic-vehicle-system §8.4): public spec sheets, resolved at
 * load against each model's measured wheelbase and track (drivetrain/spec.ts resolveSpec). Kept apart from the
 * catalogue so the Node tests can import them (the catalogue imports model URLs through Vite).
 */
export const SPECS: Record<'gwagen' | 'bmw' | 'van', VehicleSpec> = {
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
  // BMW E30 M3 (1986, European): S14 2.3 L four, 147 kW at 6750 rpm, 240 N·m at 4750 rpm, 7250 redline; Getrag 265
  // close-ratio 5-speed (dogleg first) 3.72 / 2.40 / 1.77 / 1.26 / 1.00, R 4.23, final 3.25, a 25 % rear LSD;
  // MacPherson front, semi-trailing-arm rear (≈ multi-link here); discs all round with ABS; 205/55R15; 1200 kg;
  // 0–100 6.7 s, 235 km/h; Cd 0.33. TUNED (skills/realistic-vehicle-system §8.4, data only): C_dA 0.78 solved from
  // the 235 km/h top speed (Cd × A = 0.63 ran to 278 km/h: the sim's losses are lower than the real car's), quick
  // 0.28 s shifts, 50:50 with the driver, road tyres (the game's cars climb grass walls with the off-road assist;
  // performance rubber can't), and an OPEN rear diff — with the 25 % LSD the 123 W/kg car spun donuts on the
  // skidpad at a quarter throttle (1.45 g of 'lateral'); open, it still holds a drift (tests/drivetrain).
  bmw: {
    class: 'sports',
    published: { zeroTo100: 6.7, topSpeed: 235, turningCircle: 10.5 },
    mass: { kerb: 1200, frontShare: 0.5, comHeight: 0.48 },
    power: { kind: 'petrol', peakPower: 147, powerRpm: 6750, peakTorque: 240, torqueRpm: 4750, redline: 7250, idle: 900 },
    transmission: { kind: 'manual', ratios: [3.72, 2.4, 1.77, 1.26, 1.0], reverse: 4.23, final: 3.25, shift: 0.28, efficiency: 0.9 },
    drive: { layout: 'FR' },
    axles: [
      { suspension: 'macpherson', steered: true, tyre: '205/55R15', tyreKind: 'road', brake: 'disc', travel: 0.16 },
      { suspension: 'multi-link', tyre: '205/55R15', tyreKind: 'road', brake: 'disc', travel: 0.16 },
    ],
    brakes: { abs: true },
    aero: { cdA: 0.78 },
  },
  // The kei van (a 1980–85 cab-over 800 cc van, the ST90 kind): F8A 797 cc four, 27 kW at 5500 rpm, ≈ 57 N·m at
  // 3000, 4-speed manual 3.818 / 2.294 / 1.506 / 1.0, R 3.818, final 5.375, engine under the seats driving the rear
  // (leaf-sprung live axle), MacPherson front, drums all round, 145/80R12, 860 kg, ≈ 105 km/h. No aids.
  van: {
    class: 'van',
    published: { topSpeed: 105, turningCircle: 8.4 },
    mass: { kerb: 860, frontShare: 0.48, comHeight: 0.72 },
    power: { kind: 'petrol', peakPower: 27, powerRpm: 5500, peakTorque: 57, torqueRpm: 3000, redline: 6000, idle: 850 },
    transmission: { kind: 'manual', ratios: [3.818, 2.294, 1.506, 1.0], reverse: 3.818, final: 5.375 },
    drive: { layout: 'FR' },
    axles: [
      { suspension: 'macpherson', steered: true, tyre: '145/80R12', tyreKind: 'road', brake: 'drum', travel: 0.15 },
      { suspension: 'solid-leaf', tyre: '145/80R12', tyreKind: 'road', brake: 'drum', travel: 0.18 },
    ],
    brakes: { abs: false, maxDecel: 0.85 },
    aids: 'off', // 1980s kei van: none
    aero: { cd: 0.45, frontalArea: 2.3 },
  },
}
