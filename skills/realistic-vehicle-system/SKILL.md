---
name: realistic-vehicle-system
description: Universal realistic car system — read before adding ANY car (hatchback, sedan, sports/supercar, muscle, SUV, pickup, off-roader, van, EV, rally, multi-axle) or changing any part of one — Blender modelling via the Blender MCP and the part-naming standard, turning a spec sheet into simulation data, engine / clutch / gearbox (manual, auto, DCT, CVT, EV) / differentials / low range, tyres and surfaces, brakes / ABS, steering, aids, suspension of every type, materials, tyre deformation, HUD / gauges / lights, audio, camera, co-op — and its cost per tier.
---

# Realistic vehicle system — any car

Every car is the same machine with different numbers. It has:
- a body on springs;
- axles with wheels that steer, drive and brake;
- an engine or motor that sends torque through a transmission and differentials;
- tyres whose grip depends on load, slip and surface;
- parts you can see move.

This skill defines that machine **once**. A new car is a Blender model that follows the naming standard (§8.2) plus a
`VehicleSpec` derived from its public spec sheet (§8.4). No new code per car. A car that needs new code is
missing a *variant* (a gearbox kind, a suspension type), and that variant goes into the shared model for every car.

"Realistic" in DARK means it **behaves like the real machine and looks mechanically right, inside the Genshin
art style, at ≥ 60 fps on a ₹15k phone**. It is not photoreal PBR.

Scope: road vehicles with 2+ axles (cars, SUVs, pickups, vans, off-roaders, EVs, multi-axle trucks). Not bikes:
the BMX is `BikeSim` / `skills/physics`.

Values marked **(verified)** were checked against a published source on 2026-10-09 (§11). The rest are
engineering defaults to tune against the tests (§10).

## 1. Purpose

One hero car is in the world at a time, always near the camera: a third of the screen in the chase view, all of
the garage turntable. Each car may spend more triangles, shader ALU and sim CPU than any prop. Its limits, whatever
the car: **one shader program, ≤ ~15 draws, ≈ 0.15 ms CPU per frame including its physics**, on every tier.

## 2. Architecture

```
Blender model (named per §8.2) ──► GLB ──► loader: bake + normalise + read parts / empties ──► VehicleModel
public spec sheet ──► §8.4 derivation (+ §8.5 class defaults for gaps) ──► VehicleSpec (data only)
                                                     │
               ┌─────────────────────────────────────┴─────────────────────────────────────┐
     SIM (plain TS, render-free, Node-tested)                       RENDER / FEEDBACK (read sim outputs only)
     fixed 60 Hz: controls → aids → raycast suspension              body pose (interpolated), wheels (lift, spin=∫ω,
     (physics engine: springs + contacts only) → N substeps:         steer, camber by suspension type, squash),
     power unit → clutch/converter → transmission → diffs →         linkages, calipers, doors/hood/trunk, steering
     wheel ω → tyre forces per surface → forces at contacts         wheel, gauges, lamps · HUD · audio · camera ·
     outputs: rpm, gear, load, ω, κ, α, Fz, slip, aids, surface      effects · haptics · network snapshot
```

**The one rule:** the SIM owns every number (rpm, gear, wheel speed, slip, load). Audio, HUD, gauges, effects,
camera and network only read it. Nothing re-derives a gear from speed.

**Conventions** (break them and wheels spin backwards or steer the wrong way):

| Thing | Convention |
|---|---|
| Car space | forward = −Z, up = +Y, right = +X, origin on the ground at the wheelbase centre (midpoint of the first and last axle) |
| Axles / wheels | axles ordered front → rear; wheel index = axle·2 + (0 left, 1 right); dual wheels add `_in` |
| Wheel geometry | one wheel per axle (or one for all) centred on its hub; right wheels = left turned 180° about Y, spin negated |
| Signs | `lift` + = pushed up, `spin` + = rolling forward, `steer` + = right, roll + = right side down, pitch + = nose up |
| Units | SI everywhere (m, kg, N, N·m, rad, s); rpm only at the edges (spec input, HUD, audio) |

## 3. When to use

Use it for:
- adding a car of any class;
- changing how any car drives, looks, sounds or feels;
- adding a variant (a new transmission kind, suspension type or power unit);
- tuning the shared model.

## 4. When NOT to use

- **Wrecks and parked props:** `skills/asset-optimization` (prop budget, instanced, cuboid colliders), never a sim.
- **Bikes:** `skills/physics` (`BikeSim`).
- **Arcade handling** (scripted grip, nitro, drift, air suspension, the flying car): a separate mode that stays as
  it is. Never "realism-fix" it.
- **Per-car code paths** (`if (car.id === …)`): everything a car needs is data in its `VehicleSpec`.
- **A new physics engine, soft-body tyres, or a skinned/rigged car:** raycast suspension plus our powertrain/tyre
  code plus render-side kinematics is the model (ARCHITECTURE.md §1).

## 5. Performance (CPU / GPU / memory, per tier)

Per car in view. The first rows are measured on the current garage (ARCHITECTURE.md §6, M4 + RTX 4050). The
planned rows are CEILINGS to verify with `npm run shot` + F3.

| Piece | Draws | Tris | CPU | GPU | Memory |
|---|---|---|---|---|---|
| Body + wheels + steering wheel + doors (1 instanced program) | 5–8 | ≤ 40 k budget | ≈ 0.05 ms render side | Lambert + stylize | geometry + 1 texture ≤ 1024² (LOW 512²) |
| Glass ×≤ 3 + lamps ×1 | ≤ 4 | small | — | blended / additive | — |
| Running gear instances (struts, axles, arms, calipers, needles) | 3–4 (+ shadow pass) | ≈ 2–3 k | in the 0.05 ms | within noise | < 50 KB |
| Raycast suspension, 4–8 wheels | — | — | ≈ 0.05 ms / step | — | small |
| **Powertrain + tyres + aids** (8 substeps × wheels) | — | — | ≤ +0.03 ms / step (4 wheels) | — | < 10 KB |
| **Surface sampling** (1 wheel per step) | — | — | ≤ +0.005 ms | — | — |
| **Material classes** | +0 | +0 | +0 | LOW +0; MED/HIGH ≤ +0.05 ms | +1 float / vertex |
| **Tyre deformation** | +0 | +0 (≥ 24 tread segments) | ≈ +0.005 ms | ≈ 15 ALU / wheel vertex | +1 float / vertex |
| **HUD tacho + gear** (DOM refs) | — | — | ≤ 0.01 ms | compositing | — |
| **Skid marks** (HIGH) | +1 | 512 | ≈ 0.01 ms | decal overdraw | ring buffer |
| **Effects** (exhaust, smoke) | 1 shared | ≤ tier cap sprites | ≈ 0.03 ms | blended | fixed pool |

Tier rules:
- The SIM is identical on every tier (determinism, co-op). Physics never reads `game.quality`.
- Visuals read `game.quality`: LOW = class colours only, no reflection term, no shear, no skid marks; MEDIUM adds
  reflection and spec; HIGH/ULTRA add tyre shear, rim blur and skid marks.
- Never `if (isMobile)`, never hard-coded constants.

## 6. WebGL limitations

- **One program per car.** Every opaque car part is an `InstancedMesh` on one material. A feature goes into its
  `onBeforeCompile` behind a `#define` plus `customProgramCacheKey`, never into a second material.
- **Every geometry on a program needs every attribute it reads.** Three.js doesn't reset a missing attribute's
  generic value. New attributes (`matClass`, `tyreW`, `zone`) go on every car geometry, with zeros where unused.
- **`gl_InstanceID` restarts at 0 per draw.** Gate per-wheel uniform arrays with a per-vertex flag and clamp the
  index to the wheel count.
- **No env maps on LOW, no PMREM per frame.** Reflections use the analytic sky colour (`skyColor(dir)` in the
  stylize shaders). Mirrors are sky-coloured, never rendered.
- **Baking keeps base colour only.** Surface response comes from geometry plus per-vertex material classes, never
  from normal or roughness maps.
- **The shadow pass uses the default depth material.** Vertex deformation ≤ 3 cm doesn't need a custom one.
- **Glass sorts per object.** Keep glass to ≤ 3 meshes.
- **Precision:** do per-vertex math in car or wheel local space, and pass small vectors to shaders.

## 7. R3F implementation

There is none per frame, by design. The game constructs the car with plain Three.js. The game loop calls the
car's fixed update before the physics step and its render update per frame. React renders only the garage and
settings UI, which call `selectVehicle` / `setTuning` once per change. The HUD reads `sim.rpm` / `sim.gear` in rAF
into refs. Only discrete changes (gearbox mode → which buttons show) go into the store.

## 8. The universal car

### 8.1 Anatomy: what every car has

| System | Physical role (sim) | Visible role (render) | Variants (all data, §8.3) |
|---|---|---|---|
| Body / chassis | mass, COM, inertia, colliders | the shell, panels, glass, interior | class, mass split |
| Axles (2+) | per axle: steered? driven? braked; track; spring/damper; anti-roll bar | linkage of its suspension type | suspension type per axle |
| Wheels + tyres | ω, slip, Fx/Fy from load and surface | rim + tyre spin, steer, camber, squash | tyre size code, kind, dual |
| Brakes | torque per wheel, bias, ABS | disc (spins with the wheel), caliper (steers + lifts, never spins), glow on HIGH | disc / drum |
| Power unit | torque(rpm, throttle), inertia, engine braking | exhaust tip(s), engine-bay shake at idle | petrol NA, turbo petrol, diesel, electric |
| Clutch / converter | couples power unit and transmission | — | auto-clutch, torque converter, none (EV) |
| Transmission | ratios, shift logic | gear on the HUD / gauges | manual, auto, DCT, CVT, single-speed |
| Differentials | torque split per axle and between axles | diff housings on solid axles | open, LSD, locked, viscous, on-demand |
| Transfer case | high/low range, centre lock | — | none, part-time, permanent |
| Steering | rack ratio, lock, Ackermann | steering wheel, tie-rods, front wheels | front, rear-steer (option) |
| Aero | drag, (downforce) | spoilers | C_dA, C_lA front/rear |
| Lights | — | head, tail, brake, reverse, indicators, fog, high beam | lamp parts found by name |
| Cockpit | — | steering wheel, gauges, seats | gauge empties |
| Openings | — | doors (2/4, hinged or sliding), hood, trunk/tailgate | hinge or slide extras |

### 8.2 The model: Blender standard and MCP workflow

**Naming standard** (Blender object names; empties export as glTF nodes, so measured positions come from the
model, not from hand-typed numbers):

| Name | What | Notes |
|---|---|---|
| `body` (any unnamed mesh) | everything rigid with the chassis | paint material name contains `paint` |
| `wheel_<A><S>` | wheel + tyre + brake disc. A = `F`, `R`, or `M1`, `M2`… for middle axles; S = `L`/`R`; `_in` for an inner dual | `B` is accepted as an alias for `R` (rear) |
| `caliper_<A><S>` | caliper + knuckle bits | steers and lifts with the wheel, never spins |
| `door_<FL|FR|RL|RR>` | door skin + trim + its window | extra `hinge` [x,y,z] (+ `axis`, default vertical); sliding door: extra `slide` [dx,dy,dz] |
| `hood`, `trunk` / `tailgate` | opening panels | extra `hinge` + `axis` (horizontal) |
| `steering_wheel` | rim + spokes | pivot and column axis found from its ring |
| `glass_*` or a transparent material | glass | ≤ 3 meshes after merge |
| `lamp_<head|tail|brake|reverse|fog|ind>_<pos>` | lamp lenses | `ind` pos = `FL FR RL RR`; others `L`/`R` |
| `mirror_L/R`, `wiper_L/R` | small parts | wiper: extra `pivot` |
| empties `seat_driver`, `gauge_speedo`, `gauge_tacho`, `exhaust_<L|R>` | positions | gauge empties: −Z = needle zero, extra `sweep` (rad) |
| materials `*interior*` / `*inner*` | unpainted trim | |

Rules:
- metres; triangulated; transforms applied; weighted normals; one base-colour texture ≤ 1024² (or vertex
  colours);
- tyres touch the ground at design ride height;
- export GLB with `export_yup=True, export_extras=True`;
- budget ≤ 40 k tris and ≤ 12 materials.

**Geometry where it reads** (any class): silhouette + bevelled panels + real 1–2 cm panel gaps (35 %); wheels (25 %:
tyre ≥ 24 radial segments, rounded sidewall, rim with depth, disc + caliper behind); closed arch liners + dark
underbody (15 %); lamps, grille, mirrors (15 %); cabin + gauges (10 %). One LOD.

**Blender MCP workflow.** The Blender MCP gives scene/object info, viewport screenshots and execute-Python
(ahujasid/blender-mcp: `get_scene_info`, `get_object_info`, `get_viewport_screenshot`, `execute_blender_code`;
load its tools first). The same `bpy` works pasted into Blender's Text Editor.

1. **Inspect, don't guess:** run this read-only report, and take a left-side screenshot to confirm the front:

```python
import bpy, json, re
dg, sc = bpy.context.evaluated_depsgraph_get(), bpy.context.scene
rep, total, mats = {'objects': [], 'empties': {}, 'warn': []}, 0, set()
for o in sc.objects:
    if o.type == 'EMPTY':
        rep['empties'][o.name] = [round(v, 3) for v in o.matrix_world.translation]; continue
    if o.type != 'MESH' or not o.visible_get(): continue
    ev = o.evaluated_get(dg); me = ev.to_mesh()
    t = sum(len(p.vertices) - 2 for p in me.polygons); total += t
    ws = [o.matrix_world @ v.co for v in me.vertices] or [o.location]
    ms = [s.material.name for s in o.material_slots if s.material]; mats.update(ms)
    rep['objects'].append({'name': o.name, 'tris': t, 'mats': ms,
        'min': [round(min(p[i] for p in ws), 3) for i in range(3)], 'max': [round(max(p[i] for p in ws), 3) for i in range(3)],
        'extras': {k: (list(o[k]) if hasattr(o[k], '__len__') and not isinstance(o[k], str) else o[k]) for k in o.keys() if not k.startswith('_')}})
    ev.to_mesh_clear()
pat = {'wheels': r'^wheel_(F|R|B|M\d)(L|R)', 'calipers': r'^caliper_', 'doors': r'^door_(FL|FR|RL|RR)', 'openings': r'^(hood|trunk|tailgate)',
       'steering': r'^steering_wheel', 'lamps': r'^lamp_', 'glass': r'^glass_'}
names = [x['name'] for x in rep['objects']]
rep['contract'] = {k: [n for n in names if re.search(p, n, re.I)] for k, p in pat.items()}
rep['textures'] = sorted({f'{n.image.name} {tuple(n.image.size)}' for m in bpy.data.materials if m.use_nodes and m.node_tree
                          for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image})
rep['totals'] = {'tris': total, 'materials': len(mats)}
if total > 40000: rep['warn'].append('over 40k tris')
if len(mats) > 12: rep['warn'].append('over 12 materials')
if len(rep['textures']) > 1: rep['warn'].append('more than one texture')
if len(rep['contract']['wheels']) < 4: rep['warn'].append('wheels not named wheel_<A><S>')
for d in rep['contract']['doors'] + rep['contract']['openings']:
    if not any(x['name'] == d and 'hinge' in x['extras'] for x in rep['objects']): rep['warn'].append(f'{d}: no hinge extra')
print(json.dumps(rep, indent=1))
```

   From the wheel objects' min/max: wheelbase (first to last axle centre along the length axis), track per axle,
   and tyre radius (half the height). Compare them with the spec sheet: a mismatch means the model's scale is off.
2. **Fix in small named steps**, one execute call each, re-running the report after each:
   - scale to the real wheelbase;
   - split and rename parts to the standard;
   - add `hinge` / `axis` custom properties and the empties;
   - join small parts by material to cut the count;
   - bake or atlas textures down to one;
   - decimate the interior/underside first when over budget.

   Never `separate by loose parts` on a whole body (it makes thousands of objects). Keep reusable prep code as a
   script in `scripts/blender/`.
3. **Export** to its own folder, check the size, then copy it into the game's vehicle folder.

### 8.3 Variants (the shared model implements every row once)

**Power units:**

| Kind | Torque curve shape | Idle / redline | Inertia | Extras |
|---|---|---|---|---|
| `petrol` (NA) | rises to peak at ~55–70 % of redline, gently falling to peak power at ~90 % | 700–900 / 6000–8000 | 0.10–0.25 kg·m² | — |
| `turbo-petrol` | flat plateau from boost onset (1500–2500) to ~75 % of redline | 700–850 / 6000–7000 | 0.12–0.3 | boost lag τ 0.3–0.6 s, blow-off |
| `diesel` | peak early (1500–2500), falls steadily | 700–800 / 4000–4800 | 0.2–0.4 | strong engine braking, turbo lag |
| `electric` | constant torque T_max to base speed `ω_b = P/T_max`, then constant power P (verified) | none (0 rpm at rest) / 12–20 k motor rpm | 0.05–0.1 | single-speed ≈ 9:1 (verified: Model 3 9.03:1), regen braking, no clutch, no shifts |

**Transmissions:**

| Kind | Shift time | Torque during shift | Logic |
|---|---|---|---|
| `manual` (auto-clutch) | 0.30–0.45 s | 0 | shift map (§8.6) or player (manual mode) |
| `auto` (torque converter) | 0.25–0.4 s | ~50 % | shift map + converter (×2.0 at stall → 1.0 at speed ratio 0.85), creep |
| `dct` | 0.08–0.15 s | ~70 % | shift map, quick |
| `cvt` | — | continuous | ratio range ≈ 2.5 → 0.4 (verified spread ≈ 6:1); holds a target rpm from the throttle; optional 6–7 fake steps in manual mode |
| `single` (EV) | — | — | fixed reduction; reverse = motor reversed |

Example ratio sets (verified) for shaping unknown boxes: a 5-speed manual (Toyota W56) 3.954 / 2.141 / 1.384 /
1.000 / 0.850, R 4.091; a 7-speed auto (Mercedes 7G-Tronic) 4.377 / 2.859 / 1.921 / 1.368 / 1.000 / 0.820 / 0.728,
R 3.416.

**Drive layouts:** `FF` (front engine, front drive), `FR`, `MR`, `RR`, `AWD-permanent` (centre diff open/LSD/
viscous with a split), `AWD-on-demand` (rear engages by front slip, Haldex-like: transfer ∝ slip, ≤ 50 %),
`part-time-4WD` (2H / 4H locked / 4L + low range 2.0–2.7, e.g. Toyota RF1A 2.28 (verified)), `N×N` multi-axle (each
axle has a diff; axle pairs share a lockable inter-axle diff).

**Differentials:** `open`, `lsd` (clutch: preload + bias), `torsen` (torque-bias ratio 2–4), `viscous` (transfer ∝
speed difference), `locked`, `none`.

**Suspension types (per axle):**

| Type | Camber vs body in bump (render) | Visible parts | Typical travel | Notes |
|---|---|---|---|---|
| `macpherson` | small, hard to tune (verified): ≈ −0.2 to −0.4 rad/m | strut (rotates with steer), lower arm, ARB | 0.15–0.20 m | most front axles |
| `double-wishbone` | negative camber gain (verified): ≈ −0.35 to −1.0 rad/m | upper + lower arms, coil-over | 0.15–0.25 | sports, trucks' front |
| `multi-link` | most tunable (verified): ≈ −0.3 to −0.8 rad/m | 4–5 links, coil, damper | 0.15–0.20 | modern rears |
| `torsion-beam` | semi-independent (verified): about half the solid-axle tilt | trailing arms + beam | 0.15–0.20 | small FF cars' rear |
| `solid-coil` / `solid-leaf` | wheels stay perpendicular to the axle (verified): tilt = `atan2(liftL − liftR, track)` | beam, diff housing, coils or leaf packs, panhard/links | 0.20–0.35 | trucks, off-roaders |
| `portal` | as solid; hub below the axle by the portal offset | beam above the wheel centre, hub boxes | 0.25–0.35 | Unimog-style off-roaders |

In the raycast model every type is a vertical spring/damper per wheel. The type sets the render kinematics and the
default rates and travel. Unsprung mass, camber thrust and roll centres are out of scope.

**Brakes:** `disc` / `drum` per axle; ABS yes/no; EV regen.

**Tyre kinds:** `road` (μ 1.0, peak slip angle 6–8°), `performance` (μ 1.1, peak 5–6°, worse off-road), `at`
(all-terrain, × 1.15 off-road), `mt` (mud-terrain: μ 0.9 on asphalt, × 1.3 off-road, peak 10°), `winter` (× 1.5 on
snow, × 1.2 on ice).

Out of scope on purpose: tyre temperature and wear, brake fade, fuel, clutch pedal, hybrids, camber thrust,
gyroscopic effects. Add one only with a gameplay reason and a test.

### 8.4 From spec sheet to `VehicleSpec`

```ts
interface VehicleSpec {
  class: VehicleClass                      // §8.5 — supplies every default
  published?: { zeroTo100?: number; topSpeed?: number; turningCircle?: number }   // m, s, km/h — for tests
  mass: { kerb: number; frontShare?: number; comHeight?: number }
  power: { kind: 'petrol' | 'turbo-petrol' | 'diesel' | 'electric'; peakPower: number; powerRpm: number;
           peakTorque: number; torqueRpm: number | [number, number]; idle?: number; redline?: number; inertia?: number;
           turbo?: { from: number; lag: number }; regen?: number }
  transmission: { kind: 'manual' | 'auto' | 'dct' | 'cvt' | 'single'; ratios?: number[]; reverse?: number; final?: number;
                  range?: [number, number]; shift?: number; efficiency?: number }
  drive: { layout: Layout; centre?: Diff; split?: number; low?: number; lockers?: ('front' | 'centre' | 'rear')[] }
  axles: { suspension: SuspensionType; steered?: boolean; driven?: boolean; diff?: Diff; tyre: string /* '225/45R17' or '35x12.50R17' */;
           tyreKind?: TyreKind; dual?: boolean; springHz?: number; zeta?: [number, number]; arb?: number; travel?: number;
           brake?: 'disc' | 'drum' }[]
  brakes?: { bias?: number; maxDecel?: number; abs?: boolean }
  steering?: { ratio?: number; lock?: number }
  aero?: { cd?: number; frontalArea?: number; cdA?: number; clA?: [number, number] }
}
```

Fill it from the manufacturer's spec sheet. Derive what's missing, in this order:

| Quantity | Derivation |
|---|---|
| tyre radius | metric `W/AR R D`: `r = (D·25.4/2 + W·AR/100)/1000` m (verified: 225/45R17 → 0.317 m); flotation `35x12.50R17`: `r = 35·0.0254/2` |
| wheelbase, track | from the model (they must match the sheet: §8.2 check) |
| COM height | class default (verified ranges: sports < 0.50 m, passenger 0.50–0.60, 5-seat SUV 0.61–0.70, big off-roaders 0.70–0.87); EVs −0.05 (low battery) |
| front share | layout default: FF 0.60, FR 0.52, MR 0.42, RR 0.40, EV skateboard 0.50, front-engine 4×4 0.55 |
| torque curve | from kind (§8.3) through (torqueRpm, peakTorque) and (powerRpm, peakPower/ω); redline ≈ powerRpm × 1.08 if unknown |
| ratios | if unknown: `g_n = g_1·(g_top/g_1)^((n−1)/(N−1))` with the class g_1 and g_top, then tighten the top gears by 5 % (progressive) |
| final drive | if unknown and the top speed is gearing-limited: `final = (redline·2π/60)·r / (v_top·g_top)`; else the class default |
| C_dA | `Cd × A`, with `A ≈ 0.84·width·height`; or, from a drag-limited top speed, solve `η·P = ½ρ·C_dA·v³ + c_rr·m·g·v` (ρ 1.2, η 0.85–0.9) |
| steering lock | from the published kerb turning circle D: `δ_outer ≈ asin(L / (D/2))`; inner by Ackermann (§8.7) |
| steering ratio | class default (verified range 12:1–20:1 for road cars; lock-to-lock ≈ 2.5–3.5 turns) |
| spring rate | `k_wheel = s_w·(2π f)²` per §8.8 from the class frequency; damping from ζ |
| inertias | wheel `I_w ≈ 0.6·m_w·r²` (m_w ≈ 15–25 kg cars, 30–50 kg trucks / 35″ tyres); power unit from §8.3 |
| brakes | bias 0.6–0.7 (front-heavy) / 0.55 (MR, RR); maxDecel ≈ μ_tyre·0.95 g on road tyres, 0.8 off-road, 0.65 old drums |

**Validate before tuning anything else:** run the headless sim (§10) and compare 0–100 km/h and top speed with
`published`. Fix gaps in this order: power curve, then efficiency, then C_dA. Never fix them by changing grip.

### 8.5 Class defaults (fill the gaps, then tune)

| Class | Layout | Mass | COM | C_dA m² | Ride f (F) | ζ b/r | Steer ratio | g_1 / g_top | Tyre | Susp F / R | Aids default |
|---|---|---|---|---|---|---|---|---|---|---|---|
| city / hatch | FF | 1000–1300 | 0.52 | 0.62 | 1.2 Hz | 0.3 / 0.5 | 15 | 3.6 / 0.75 | road | macpherson / torsion-beam | std |
| sedan / wagon | FF/FR/AWD | 1350–1800 | 0.55 | 0.65 | 1.2 | 0.3 / 0.5 | 15 | 4.0 / 0.70 | road | macpherson / multi-link | std |
| sports | FR/MR | 1200–1600 | 0.46 | 0.58 | 1.6 | 0.35 / 0.6 | 13 | 3.3 / 0.80 | performance | double-wishbone / multi-link | std |
| supercar | MR/AWD | 1400–1700 | 0.44 | 0.60 + C_lA | 2.0 | 0.4 / 0.65 | 12 | 3.1 / 0.75 | performance | double-wishbone ×2 | std |
| muscle | FR | 1600–1900 | 0.52 | 0.70 | 1.4 | 0.3 / 0.55 | 16 | 3.0 / 0.70 | performance | double-wishbone / solid-coil | std |
| SUV / crossover | AWD-on-demand | 1600–2300 | 0.65 | 0.95 | 1.4 | 0.3 / 0.5 | 16 | 4.2 / 0.70 | road/at | macpherson / multi-link | full |
| pickup | part-time-4WD | 1700–2400 | 0.68 | 1.20 | 1.6 | 0.3 / 0.55 | 18 | 4.0 / 0.80 | at | double-wishbone / solid-leaf | full |
| off-roader | AWD-permanent + lockers | 2000–3000 | 0.75 | 1.50 | 1.5 | 0.3 / 0.5 | 18 | 4.4 / 0.75 + low | mt | solid-coil (or portal) ×2 | full |
| van | FF/FR | 1500–2500 | 0.75 | 1.30 | 1.6 | 0.3 / 0.55 | 20 | 4.0 / 0.80 | road | macpherson / solid-leaf | full |
| EV | RWD/AWD | 1700–2300 | 0.48 | 0.58 | 1.4 | 0.3 / 0.55 | 14 | single ≈ 9:1 | road | double-wishbone / multi-link | std |
| rally | AWD-permanent (LSDs) | 1200–1400 | 0.48 | 0.70 | 1.8 | 0.35 / 0.6 | 11 | 3.2 / 0.95 (close ratio) | at/gravel | macpherson ×2 | off |

Ride frequencies follow the verified ranges: comfort 1.0–1.2 Hz, sporty 1.25–1.75, trucks / off-road / rally
1.5–2.0. Damping ratio 0.2–0.6. Rear is ~10 % stiffer than front. C_dA values come from verified Cd and drag-area
ranges (modern cars Cd 0.25–0.30, SUVs 0.35–0.45, drag area ≈ 0.57 m² for a sports car up to ≈ 1.56 m² for a big
SUV).

### 8.6 Powertrain simulation

**Why the game owns wheel speed (verified, Rapier source and a headless probe):** the raycast vehicle (a Bullet
port) sets wheel rotation from ground speed (`delta_rotation = v_forward·dt / radius`). Friction is one combined
budget, `suspension_force · dt · friction_slip`. Wheels never spin up or lock (probe: rim 8.40 vs ground 8.30 m/s at
full throttle on grip 0.15; "locked" wheels kept rolling). Gears, burnouts, ABS and engine braking need a simulated
ω. So:

- **The physics engine does springs, dampers and contacts only.** Per wheel: friction slip 0, side friction 0,
  engine force 0, brake 0.
- **The shared model does power unit → clutch/converter → transmission → diffs → per-wheel ω → tyre forces**,
  applied at the contact points.

**Step (fixed 60 Hz):**

```
1. pedal/steer filters (§8.7) → aids pre-pass (TCS cut, ABS modulation, ESC brake requests)
2. raycast suspension update (springs + contacts)
3. per wheel: Fz, contact point/normal, patch velocity, surface (§8.7)
4. 8 substeps (same on every tier): power torque → coupling → transmission → diffs → T_drive per wheel;
   ω += (T_drive − T_brake − Fx·r − T_roll)/I_w·h; tyre Fx, Fy (capped, below); power unit ω follows the coupling
5. average each wheel's force over the substeps → add at its contact point → physics step
```

**Power unit:**
- **Combustion:** `T = thr·T_curve(rpm) − (1 − thr)·T_fric(rpm)`, with `T_fric = (0.05 + 0.15·rpm/redline)·T_peak`
  (engine braking). Idle PI control (never stalls); rev limiter 50 ms fuel cut; turbo boost fraction with lag τ and a
  blow-off event.
- **Electric:** `T = thr·min(T_max, P/ω)`. Lift-off regen `−regen·T_max` (0.1–0.3), blended with the friction brakes
  under pedal. No idle, no clutch, no limiter bounce (smooth cut at max motor rpm).
- **Scaling:** the curve is scaled so its peak power = the garage power slider.

**Coupling:**
- **Auto-clutch** (manual / DCT): `T_c = clamp(k·(ω_e − ω_in), ±1.3·T_peak)·engagement`. Engagement ramps 0→1
  from idle to the launch rpm (≈ 0.6 × torque rpm at full throttle). LOCK when engaged and slip < 20 rpm (engine +
  gearbox become one inertia, `I_e·g²` reflected) to avoid chatter. 0 in N and mid-shift.
- **Torque converter** (auto): multiplication `2.0 → 1.0` over speed ratio 0 → 0.85, then lock-up. Creeps at idle.
- **CVT:** converter at launch, then the ratio slews (≤ 1 ratio/s) to hold `rpm_target = lerp(1.3·idle, 0.9·powerRpm, thr)`.
- **EV:** direct.

**Shift logic** (stepped transmissions; rpm thresholds, `thr` smoothed):

```
upRpm(thr)   = lerp(0.42, 0.93, thr^0.8) · redline        downRpm(thr) = lerp(0.24, 0.55, thr) · redline
upshift   rpm > upRpm  AND rpm·g[n+1]/g[n] > downRpm + 0.08·redline     (hysteresis → no hunting)
downshift rpm < downRpm AND rpm·g[n−1]/g[n] < 0.9·redline               (never over-rev)
kickdown  throttle +0.5 within 0.2 s → down 1–2 gears if the result < 0.85·redline
hold      |lat g| > 0.4, airborne, any driven κ > 0.25, 0.8 s after a shift; early downshift on climbs > 12°;
          engine-brake gear downhill (pitch < −8°, throttle 0)
diesel    shift points × 0.85 (redline-relative curves still apply)
```

- **Selector:** `P R N D` (+ `M`). Hold brake at a standstill for 0.3 s → R; throttle in R → D.
- **Manual mode:** up/down keys; refuse a shift that would over-rev (click sound); the limiter bounces.
- **Ratio check:** `v_top(gear) = (redline·2π/60)·r / (g·final)`.

**Differentials** (each substep):
- `open`: equal torque, free speeds.
- `lsd`: `T_b = clamp(k·Δω, ±(preload + bias·|T_in|))` from the faster to the slower wheel.
- `torsen`: the slower side gets up to TBR × the faster side's torque.
- `viscous`: `T_b = c·Δω`.
- `locked`: both wheels take their inertia-weighted mean ω.
- **Layouts** compose these per axle and between axles. **Low range** multiplies the ratio (only ≤ 8 km/h).
  Lockers are toggled by the player. Never hand-write "traction split by load": diffs plus tyres produce it.

**Wheel ω stability:** slip stiffness (≈ B·C·D·Fz) makes the low-speed wheel time constant ≪ 1 ms. Use all three:
1. 8 substeps;
2. overshoot caps `|Fx| ≤ |ωr − v_x|·I_w/(r²·h)` and `|Fy| ≤ m_share·|v_y|/h`;
3. a slip floor `max(|v_x|, 1.5 m/s)` + relaxation length σ 0.3–0.5 m, blending to static friction below 1 m/s with
   no throttle (with hill hold, a parked car stays parked).

**Outputs:** `rpm`, `gear` (−1 R, 0 N, 1…n; EV shows D), `selector`, `shifting`, `load`, `clutch`, `boost`, `regen`,
`lowRange`, `locks`, and per wheel `ω`, `κ`, `α`, `Fz`, `surface`.

### 8.7 Tyres, surfaces, brakes, steering, aids

**Tyre forces** (contact frame, per wheel, per substep):

```
κ  = (ω·r − v_x)/max(|v_x|, 1.5)      α_ss = atan2(v_y, max(|v_x|, 1.5));   α += (|v_x|/σ)(α_ss − α)·h
μ  = tyreKind.μ · surface.μ · grip scale · (1 − 0.1·(Fz/Fz_static − 1))       (load sensitivity)
MF(s) = sin(C·atan(B·s − E·(B·s − atan(B·s))))
Fx0 = μ·Fz·MF(κ; B 10, C 1.9, E 0.97)                          (verified dry-tarmac set; peak near κ ≈ 0.1)
Fy0 = −μ·Fz·0.95·MF(α; B 10·kind.stiff·surface.stiff, C 1.3, E 0.97)   (verified lateral set; peak per tyre kind)
friction ellipse: k = hypot(Fx0/μFz, Fy0/μFz); k > 1 → divide both by k;  then the §8.6 caps
rolling resistance: torque on ω, c_rr·Fz·r·sign(ω), faded out below 0.1 rad/s
```

This produces, with no special cases:
- understeer from entering too fast;
- lift-off and power oversteer;
- burnouts;
- locked wheels skidding straight;
- handbrake turns;
- bogging in sand.

**Surfaces** are deterministic and sampled one wheel per step. In DARK: road distance, biome weights, frozen water,
weather `wet`.

| Surface | μ | lateral stiffness | c_rr | wet |
|---|---|---|---|---|
| asphalt | 1.00 | 1.0 | 0.012 | μ × (1 − 0.3·wet) |
| dirt / gravel | 0.70 | 0.8 | 0.025 | mud: μ × (1 − 0.35·wet) |
| grass | 0.60 | 0.75 | 0.04 | μ × (1 − 0.3·wet) |
| sand | 0.55 | 0.6 | 0.12 + 0.1·clamp(κ, 0, 1) | — |
| snow | 0.35 | 0.6 | 0.05 | — |
| ice | 0.12 | 0.5 | 0.01 | — |

Blend by weights, never jump. The same lookup drives smoke/dust colour, surface audio and camera shake.

**Brakes:**
- **Brake torque:** `T_b = pedal · maxDecel·g·m·r · share` (bias split per axle), applied to ω, never reversing it.
- **ABS (verified):** μ peaks at 8–30 % slip, target ≈ 15 %, cycling up to 15–20 Hz. Rule: κ < −0.15 → release
  (× 0.25) until κ > −0.06; off below 2 m/s.
- **Handbrake:** rear axle, 1.5 × its grip torque, bypasses ABS.
- **Parked (P):** ω pinned to 0 + static friction + hill hold.
- **EV:** regen first, friction for the rest. Brake lamps follow the total deceleration from pedal/regen, never
  the ABS cycling.

**Steering:**
- **Lock:** `δ = steer·lock / (1 + v·k_speed)` (k 0.05–0.08), rack rate 2.5 → 0.8 rad/s with speed, self-centring
  at 1.5× that.
- **Exact Ackermann:** `R = L/tan δ`, `δ_in = atan(L/(R − t/2))`, `δ_out = atan(L/(R + t/2))`.
- **Rear-steer** (option): rear δ = −0.3·δ below 15 m/s, +0.1·δ above.
- **Steering wheel visual:** `δ × ratio` (hand-over-hand IK past 120°).
- **Pedals:** ramp from keys (throttle 0.25 s up / 0.12 s down, brake 0.15 s). Analogue stick/triggers pass
  through. Never feed digital 0/1 into the powertrain.
- **Counter-steer help:** when |α_rear| > 8°, add 0.4·α_rear to the steer target.

**Aids** (Off / Standard / Full; class default in §8.5, touch defaults to Full):

| Aid | Rule | Off / Std / Full |
|---|---|---|
| ABS | above (only if the car has it) | off / on / on |
| TCS | driven κ > 0.15 (0.25 off-road / low range) → torque × (1 − k(κ − 0.15)), attack 30 ms, release 200 ms | off / on / on |
| ESC | `r_ref = v·δ/(L(1 + K·v²))`, K ≈ 0.003, clamped to μg/v; oversteer > 0.08 rad/s → brake the outer front; understeer → brake the inner rear + trim throttle | off / off / on |
| Counter-steer | above | off / on / on |

Aids act only through torque and brakes, never by setting velocities.

### 8.8 Chassis

- **Gravity:** use real gravity for the car (`g = 9.81`) so real numbers work unchanged. In DARK the world runs
  `GRAVITY = 20`, so the car body gets `setGravityScale(9.81/20)` in the realistic model (§8.13).
- **Mass / inertia:** colliders laid out to put the COM at the spec height and front share. Rollover threshold
  `≈ (t/2)/h·g`. Tune yaw inertia with end masses. No numerical damping beyond ≈ 0.05.
- **Springs and dampers** (verified, Rapier source): per wheel the force is `max(0, (k·x − c·ẋ)·m_chassis)`, with
  the WHOLE chassis mass. For wheel mass share `s_w`:

```
f = √(k/s_w)/2π    ζ = c/(2√(k·s_w))    sag = s_w·g/k      →  k = s_w(2πf)²,  c = 2ζ√(k·s_w)   (per wheel)
```

  Keep sag < 0.6 × travel.
- **Bump stops:** progressive over the last 25 % of travel, `F = k_bs(x − 0.75·travel)²`, sized to 4 g of the static
  wheel load.
- **Anti-roll bars** per axle:
  - `F = k_arb·(x_L − x_R)` on the body (+ at the compressed side's hard point, − at the other);
  - **and** `Fz_L += F, Fz_R −= F` for the tyres. The load shift sets the balance: a stiffer front bar gives
    understeer, a stiffer rear bar oversteer;
  - front 55–65 % of the roll stiffness; target roll gradient 2–3°/g cars, 3–5°/g trucks;
  - disconnect the front bar in low range.
- **Aero:** drag `½ρ·C_dA·v²` at the COM. Downforce `½ρ·C_lA·v²` split front/rear at the axles (sports/supercar
  only).
- **Air suspension / ride height** (if the car has it): changes the rest length; the frequency stays the same.

### 8.9 Visuals

**Materials** (one program):
- **`matClass` per vertex:** 0 paint, 1 trim, 2 chrome/metal, 3 rubber, 4 lens. It comes from material names
  (`/paint/`, `/chrome|metal|alu|rim/`, `/tyre|tire|rubber/`, `/plastic|trim|black/`), else from colour.
- **Clear-coat** (MEDIUM+, paint): vertex-rate `skyColor(reflect(view, N))` × Fresnel⁵ × 0.25, plus a sharp toon
  highlight `smoothstep(0.92, 0.96, N·H)·0.6`.
- **Chrome:** 80 % sky reflection. **Rubber:** albedo ≤ sRGB 40, no spec. **Trim:** spec × 0.2.
- **Paint:** hue replace masked to the panels. **Dirt:** by height × biome colour.

**Wheels:**
- **Spin** = `∫ω dt`. **Rotation order:** hub (lift − squash) ← steer about Y ← camber about Z ← spin about X.
- **Discs** are part of the wheel. **Calipers** take hub + steer + camber, but no spin.
- **Rim blur** on HIGH above 25 rad/s.

**Linkages** (instanced unit cylinders/boxes on the car program; one draw for all arms):

| Type | Draw | Camber applied to the wheel (car space) |
|---|---|---|
| macpherson | strut hub → tower (turns with steer), lower arm | `−0.3·lift` |
| double-wishbone | upper + lower arm, coil-over | `−0.6·lift` (from the spec if given) |
| multi-link | 3 links + coil + damper | `−0.5·lift` |
| torsion-beam | trailing arms + beam between them | `0.5·atan2(liftL − liftR, track)` |
| solid / portal | beam hub-to-hub (portal: raised by the offset), diff housing, coils or curved leaf packs | `atan2(liftL − liftR, track)` |

Tie-rods follow the steer angle. Anti-roll bars are drawn on HIGH.

**Tyre deformation** (visual only):
- Per wheel: `squash = clamp(s0·Fz/Fz_static, 0, 3·s0)` (s0 0.018 m road, 0.03–0.045 off-road / tall sidewalls)
  and `shear = clamp(Fy/max(Fz, 1), −1, 1)·0.03` (HIGH).
- Lower the rendered hub by `squash`.
- Shader inputs: `uTyre[k] = vec4(wheel-local down, squash/scale)`, `uTyreR` = tread radius, per-vertex
  `tyreW = smoothstep(rimR, tyreR, radial distance)`:

```glsl
// `flat` is reserved in GLSL ES 3.0 — don't use it as a name. Clamp the index to the wheel count.
if (tyreW > 0.0) {
  vec4 ty = uTyre[min(gl_InstanceID, WHEELS - 1)];
  float plane = uTyreR - ty.w;
  float d = dot(transformed, ty.xyz);
  transformed -= ty.xyz * max(d - plane, 0.0) * tyreW;                       // flat contact patch
  float band = smoothstep(plane - 0.35 * uTyreR, plane, d);
  transformed.x += sign(transformed.x) * ty.w * 0.6 * band * tyreW;          // sidewall bulge
  #ifdef TYRE_SHEAR
  transformed.x += uTyreShear[min(gl_InstanceID, WHEELS - 1)] * band * tyreW;
  #endif
}
```

Normals are computed before `begin_vertex`, so repeat the test in `beginnormal_vertex` to bend them.

**Openings:** each door/hood/trunk swings on its hinge (or slides) from the extras. It is held by the entry
animation, latched shut, or swinging free from the car's acceleration and the wind, and slams.

### 8.10 Cockpit, lights, audio, camera, effects

- **Controls:** throttle / brake-reverse / steer, handbrake, boost, gear up/down (manual mode), low range,
  lockers, hazards, high beam. Touch shows a button only when the car has the feature. Settings → Driving:
  Handling, Gearbox (Auto/Manual), Aids, Units.
- **HUD** (DOM refs, written only on change):
  - tachometer with a red zone, or a power/regen meter for EVs;
  - gear `P R N D3` / `M4`, with shift hints in manual;
  - ABS/TCS/ESC, low range, locks, high-beam lamps.
- **Gauges:** needles at the `gauge_*` empties, rotated by `sweep`; 2 instances on the running-gear draw; night
  backlight via a per-vertex flag.
- **Lights:** the lamp parts found by name become quads in ONE additive draw (head, tail, brake, reverse, fog,
  amber indicators blinking at 1.5 Hz). High beam re-aims the existing spot light. Reverse lamps read
  `gear === −1`; brake lamps read the sim deceleration.
- **Audio** (voice by power unit):
  - **I4 / V6 / V8 / diesel:** two layers (idle → drive) pitched by rpm, loudness by load, overrun crackle at
    load < −0.2, a limiter stutter;
  - **EV:** motor whine ∝ motor rpm plus an inverter tone, no shifts;
  - **plus:** shift clunk, turbo whine/blow-off, tyre squeal (asphalt only), gravel/sand/snow loops, suspension
    thumps (damper velocity > 1.2 m/s), ABS buzz.
  - New sounds: CC0 / credited, loaded after the first gesture.
- **Camera:**
  - chase follows 30 % velocity / 70 % heading in a slide;
  - first-person head offset `−a·0.004 m per m/s²` (≤ 4 cm, 80 ms) — the strongest in-cab cue;
  - seeded road shake by surface × speed; landing jolt;
  - Settings can turn shake off. Read only the interpolated pose.
- **Effects:**
  - exhaust from load/rpm, one or two tips per the empties (none on EVs);
  - smoke/dust from the real slip and surface;
  - skid marks on HIGH (256-quad ring buffer).
- **Haptics (verified):** `navigator.vibrate` works on Android Chrome only (iOS Safari has no Vibration API).
  Short pulses on shifts, ABS, landings and crashes; optional, behind a setting.

### 8.11 Damage (optional) and co-op

- **Damage:** contact impulses → dent amount per zone (front/rear/left/right), drawn as a vertex offset weighted by
  a baked `zone` attribute (+0 draws). A lamp goes dark when its zone passes a threshold. Mechanical effects only
  with a gameplay reason.
- **Co-op** (host-authoritative, `skills/multiplayer`):
  - The host simulates; drivers send inputs.
  - Per car at 20 Hz: position, smallest-three rotation, velocity, per wheel {lift i8, steer i8, ω i16},
    rpm, gear, bits ≈ 32 + 4·wheels bytes.
  - Remote cars interpolate ~100 ms behind; wheels spin from the replicated ω; audio and HUD read the replicated
    rpm/gear.
  - Surfaces, weather and terrain are seed-deterministic.

### 8.12 Adding a car (any class) — checklist

1. **Collect the spec sheet:** power/rpm, torque/rpm, kerb mass, wheelbase, track, tyre sizes, transmission kind and
   ratios, final drive, layout and diffs, suspension types, turning circle, 0–100, top speed, Cd, width, height.
2. **Prepare the model in Blender via the MCP** (§8.2): run the report, name everything to the standard, scale to
   the wheelbase, add hinges and empties, stay in budget, export, validate.
3. **Write the `VehicleSpec`:** sheet values + §8.4 derivations + §8.5 class defaults. Write no code; if something
   can't be expressed, add the variant to the shared model (§8.3) with a test.
4. **Add the catalogue entry:** model URL, spec, stock tuning, paints, engine voice, card image, credits.
5. **Run the tests:** the universal suite runs on every car automatically (§10). Tune only the spec until it passes.
6. **Shots** on LOW and HIGH; record the cost; check side by side against the references.

### 8.13 Integration in DARK (where the shared model lives)

| Concern | Where | Status |
|---|---|---|
| Catalogue (model, tuning, paints, voice; add `spec`) | `src/gameplay/vehicle/catalogue.ts` | exists; `spec` planned |
| Model bake / normalise / part splitting | `src/assets/loadModels.ts` `bakeVehicle` | exists; reads `wheelRegex`, `door_FL/FR` + `hinge`, `steering_wheel`, lamps, glass, `inner`. Planned: the full §8.2 standard (rear doors, hood/trunk, calipers, empties, `lamp_ind_*`) |
| Blender prep scripts | `scripts/blender/vehicle_doors.py`, `vehicle_finish.py` | exist |
| Sim | `src/gameplay/vehicle/VehicleSim.ts` (`VehicleBase`, `TruckSim`) | exists (legacy power-curve + Rapier friction, arcade). Planned: `model: 'drivetrain'`, powertrain in `src/gameplay/vehicle/drivetrain/`, driven by `VehicleSpec` |
| Render | `src/gameplay/vehicle/Car.ts` (one instanced program: body, wheels, steering, doors, axles, struts, lamps) | exists; linkages per type, calipers, deformation, gauges planned |
| Entry / exit animation | `src/gameplay/vehicle/CarEntry.ts` | exists (front doors) |
| Effects / audio / HUD | `rendering/particles/VehicleFx.ts`, `audio/AudioSystem.ts` (fakes a gearbox today), `ui/GameHud.tsx` | exist; read sim outputs when the drivetrain lands |
| Tests | `tests/vehicle.test.ts` (Node + real Rapier, `check(name, ok, detail)`) | exists; universal suite planned |

DARK specifics:
- **Rapier `@dimforge/rapier3d-compat` 0.21:** `DynamicRayCastVehicleController`. Forces go in before
  `world.step`; velocity edits only in `afterWheels`. Retune in place, never rebuild the body. Wheel rays see
  `Terrain | Static` only. Keep CCD, `keepAbove` and the physics-ring freeze.
- **World `GRAVITY = 20`:** the realistic model uses the body gravity scale (§8.8); arcade keeps 20.
- **Settings default handling is `'sim'`;** it maps to the drivetrain model once the universal suite passes. Arcade
  stays.
- **Keys in use:** E F G L N O R T V, arrows, Space, Shift, F3–F8, [ ]. Free for cars: X Z (gears), Q (low range),
  K (lockers), H (hazards).
- **Validator:** `npm run validate:assets` with NO directory argument (with a directory, cars are judged by the 5 k
  prop budget). The car's line must say `vehicles lod0 ✓`.

## 9. Common mistakes

- **Per-car code or per-car magic numbers in code.** Everything is `VehicleSpec` data plus shared variants.
- **Fixing a car's acceleration or top speed with grip.** Use the power curve, then efficiency, then C_dA.
- **Trusting the physics engine's wheel rotation**, or leaving its friction on under our tyre forces (double grip).
- **Integrating ω at 60 Hz with no caps.**
- **Real-world numbers under a non-real gravity.**
- **A second gearbox anywhere** (audio, HUD, "gear from speed").
- **Digital keys straight into the throttle.**
- **Shift thresholds without hysteresis;** shifting mid-corner or airborne.
- **Aids that set velocities.**
- **Physics reading the quality tier.**
- **Faking body roll on the render side.** The pose is simulated.
- **Calipers spinning with the wheel**, or solid-axle wheels staying upright while the beam tilts.
- **Mirroring right wheels with a negative scale.**
- **A second material/program**, or a new attribute only on some geometries.
- **Per-frame allocations** in the car or the powertrain.
- **Blind Blender MCP edits;** `separate by loose parts` on a body.
- **Wrong tyre radius** (a diameter used as a radius, or sidewall forgotten). Check the model's wheel against
  §8.4.

## 10. Verification

**Universal suite** (`tests/vehicle.test.ts`): `for (const def of VEHICLES)`, every expected value computed from
the car's own spec:

- **Static:**
  - settles level (ride height ± 2 cm, roll/pitch < 1°);
  - parked on 15°: < 0.02 m drift in 6 s;
  - 0.5 m/s straight for 10 s: lateral < 0.05 m/s, no κ/α oscillation.
- **Springs:** heave frequency ± 10 % of each axle's spec f; roll gradient within the class range; dive 1.5–3° at 1 g.
- **Powertrain:**
  - top speed = min(gearing `v_top`, drag limit) ± 5 %, and ± 10 % of `published.topSpeed`;
  - 0–100 ± 15 % of `published.zeroTo100`;
  - stepped boxes shift at upRpm(1) ± 5 %, ≤ 1 shift in 10 s on a steady 5° climb, kickdown within 0.3 s, never
    above the redline;
  - CVT holds rpm_target ± 5 %;
  - EV: no shifts, regen decelerates on lift.
- **Traction:**
  - launch on grip 0.15 → wheelspin (rim > 1.5 × ground) with TCS off, κ < 0.3 with TCS on;
  - low range (if any) climbs 35° where high range fails;
  - an open diff with one wheel lifted barely moves; with the locker it climbs.
- **Grip:**
  - skidpad lateral ≈ μ·g ± 15 % on asphalt; surfaces in the table's ratios ± 20 %;
  - handbrake slides the rear (|α| > 15°) without rollover.
- **Brakes:**
  - ABS 100→0 stops straight (< 3°), distance ± 15 % of `v²/(2·maxDecel·g)`;
  - braking while steering turns > 15° with ABS;
  - ESC (Full) lane change at 25 m/s on dirt < 35° slip.
- **Body:** 1.5 m drop never passes through the ground.
- **Feedback:** audio rpm = sim rpm ± 2 % through every shift; HUD gear = sim gear; 0 React re-renders per frame.
- **Arcade:** every existing arcade test unchanged.

**Visual + cost:** `npm run dev`, then `npm run shot -- <outdir> <shots.json>`, per car (`"query": "car=<id>"`):

```json
[
  { "name": "chase_high", "seed": 7, "x": 69.2, "z": 8, "yaw": 3.1416, "pitch": -0.15, "cam": "tpp", "drive": true, "hour": 11 },
  { "name": "chase_low", "seed": 7, "tier": "low", "x": 69.2, "z": 8, "yaw": 3.1416, "pitch": -0.15, "cam": "tpp", "drive": true, "hour": 11 },
  { "name": "launch", "seed": 7, "x": -92, "z": 72, "yaw": 3.1416, "cam": "tpp", "drive": true, "keys": ["KeyW"], "keysMs": 4000,
    "eval": "const s = g.car.sim; return { v: s.speed, rpm: s.rpm, gear: s.gear }" },
  { "name": "corner", "seed": 7, "x": -92, "z": 72, "yaw": 3.1416, "cam": "tpp", "drive": true, "keys": ["KeyW", "KeyD"], "keysMs": 2500 },
  { "name": "night", "seed": 7, "x": -92, "z": 72, "yaw": 3.1416, "cam": "tpp", "drive": true, "hour": 22, "keys": ["KeyW"], "keysMs": 1500 }
]
```

- Compare with `main`; record the per-tier delta in ARCHITECTURE.md §6. Side-by-side against
  `refer/roads/road-power-lines-truck.png`.
- In game: F3 (the program count must not rise), F6 (rays, colliders), `window.__game.car.sim` in DevTools.
- Phone: `npm run dev:lan`, LOW, automatic + manual; every touch button works.
- Probe ideas headless first: bundle a scratch `.ts` with rolldown as `test:vehicle` does.

## 11. Sources (checked 2026-10-09)

- Rapier raycast vehicle source: wheel rotation, suspension force × chassis mass, friction budget —
  git.nea.moe/github/rapier.git `src/control/ray_cast_vehicle_controller.rs`
- Magic Formula: MathWorks *Tire-Road Interaction (Magic Formula)* (dry tarmac B 10, C 1.9, D 1, E 0.97); JuliaHub
  Dyad `PacejkaSlippingWheel` (lateral B 10, C 1.3, D 0.9, E 0.97)
- Ride frequency / damping: NVIDIA DriveOS suspension parameters (cars 0.5–1.5 Hz, ζ 0.2–0.6); Atlantis Press
  (trucks/off-road 1.5–2 Hz); Fiesta ST forum table (comfort 1.0, sporty 1.25–1.75, rally 1.5–2.0 Hz)
- ABS: US patent 5570935 (μ peak at 8–30 % slip); ASE A5 study guide (15–20 % target, up to 15–20 cycles/s)
- Suspension kinematics: US patent 8235404 (MacPherson camber), HP Academy *suspension types*, Delphi, RealTruck,
  AutoDeal (wishbone, multi-link, torsion beam, solid axle)
- Steering: Firgelli *Steering gear* (12:1–20:1), Wikipedia *Steering ratio*
- CG / drag: VUT Brno thesis (SUV CG 0.606–0.697 m, up to 0.874 m), Firgelli mass-centre calculator (sports
  < 0.5 m), Wikipedia *Automobile drag coefficient* (Cd 0.25–0.30, SUVs 0.35–0.45; C_dA 0.57–1.56 m²)
- Tyre size → radius: Inch Calculator *Tire size calculator* (225/45R17 → 317 mm)
- Transmissions: Wikipedia *Toyota W transmission* (W56), Wikipedia *Mercedes-Benz 7G-Tronic*, Trail-Gear RF1A
  (2.28 low), Tesla Model 3 owner's manual (9.03:1), Nissan XTRONIC CVT / CVT ratio-spread references (≈ 6:1,
  ≈ 2.5 → 0.4)
- Web haptics: MDN browser-compat-data issue 29166, web-haptics browser support (no Vibration API on iOS Safari)
- Simulator feature sets: Godot AdvancedVehicle, racinggames.gg *How racing game physics engines work*
