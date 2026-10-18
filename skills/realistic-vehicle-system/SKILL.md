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
the car: **one shader program, ≤ ~18 draws on HIGH (≤ ~16 on LOW/MEDIUM: no skid marks, no anti-roll-bar draws),
≈ 0.15 ms CPU per frame including its physics**, on every tier. The shared effects draw and the boat hull (drawn
only while deployed, §8.11) are counted separately.

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
- **Boat mode** (the amphibious hull, `BoatHull.ts`; buoyancy and water-jet handling in `VehicleSim`): it takes
  over the Rapier setup as soon as the hull moves (boat > 0) and the handling from `boat ≥ 0.5` (§8.11). Don't
  route it through the drivetrain.
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
| **Powertrain + tyres + aids** (8 substeps × wheels) | — | — | measured +0.015–0.04 ms / step (4 wheels; sim.step 22–48 µs vs legacy 6–9 µs, Node, RTX 4050 laptop CPU) | — | < 10 KB |
| **Brake hardware** (`caliper_*`, one draw per axle, no shadow pass) | +2 | +1.1–1.3 k (≈ 280–330 per corner) | ≈ 0 (4 matrix composes) | within noise (hidden behind solid rims) | +60–70 KB GLB |
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
  generic value. New attributes (`matClass`, `tyreW`, `wheelIdx`, `zone`) go on every car geometry, with zeros where unused.
- **`gl_InstanceID` restarts at 0 per draw.** With one wheel mesh per axle (§2) it is NOT the wheel index. Bake the
  wheel index into a `wheelIdx` attribute (per instance, or per-vertex axle base + `gl_InstanceID` for a per-axle
  mesh), gate per-wheel uniform arrays with a per-vertex flag, and clamp the index to the wheel count.
- **No per-draw uniforms on a shared material.** three.js re-uploads material uniforms only when the material
  changes between draws, so setting a uniform in `onBeforeRender` silently fails across the car's parts. Per-part
  data goes into attributes, or into a per-car uniform array indexed by an attribute.
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
| `caliper_<A><S>` | brake hardware: disc + hat + caliper, or drum + backing plate (`scripts/blender/vehicle_brakes.py`) | steers and lifts with the wheel, never spins; caliper at 12 o'clock (symmetric: the right side is the left turned 180°, one geometry per axle); vertex colours on one material `brake_hw` |
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

**Tyre temperature** (implemented, `Drivetrain.ts` `TYRE`): two lumps per tyre (tread surface on tread bulk) heated
by the tyre's share of the sliding power |Fx·(ωr − vx)| + |Fy·vy| (share by which surface moves through the contact:
a burnout heats the tyre, a locked skid the road), cooled by air speed; grip −30 % from 120 → 300 °C; smoke from
140 °C; FIRE at a 360 °C surface over a ≥ 170 °C bulk, kept alight by its own flame at rest, blown out by driving.
Both pedals (W + S; touch DRIFT + stick forward at a standstill) = foot brake 0.75 with the gas → a brake-stand
burnout (the driven wheels the engine turns against their brakes are free of the static hold; the braked ones
react their push up to pedal × brake torque / r; a manual's clutch is held in to ~75 % of the redline and dumped).

Out of scope on purpose: tyre wear, brake fade, fuel, clutch pedal, hybrids, camber thrust,
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
  (engine braking). `thr` = a progressive pedal map `1 − (1 − pedal)²` (half pedal ≈ 75 % demand — a linear map
  can't beat engine friction against a torque converter at part throttle: the G500 crawled at 6 km/h on 25 %).
  Idle P control (never stalls); rev limiter 50 ms fuel cut; turbo boost builds from ½ the onset rpm to the onset
  with the throttle, lagging by τ (an off-boost turbo engine keeps its NA base curve — penalise it once, not twice).
  A manual shift lifts off (upshift) or blips to match revs (downshift).
- **Electric:** `T = thr·min(T_max, P/ω)`. Lift-off regen `−regen·T_max·sign(ω)·clamp((|v| − 0.5)/1.5, 0, 1)`
  (regen 0.1–0.3): it fades out between 2 and 0.5 m/s and never reverses ω (like the brakes, §8.7); the friction
  brakes and hill hold take over below that. Blended with the friction brakes under pedal. No idle, no clutch, no limiter bounce (smooth cut at max motor rpm).
- **Scaling:** the curve is scaled so its peak power = the garage power slider.

**Coupling:**
- **Auto-clutch** (manual / DCT): a velocity CONSTRAINT `ω_e = G·Σa_i·ω_i` (a_i = each wheel's share of the gearbox
  output through the diffs) solved as an impulse each substep and clamped to the clutch's torque capacity
  `1.3·T_peak·engagement` — locked, slipping or open with no stiff spring (a spring `k·Δω` stable at 8 substeps
  leaves ~250 rpm of permanent slip). Engagement bites over a narrow band just under the launch rpm
  (`0.85…1.0 × launch`, launch ≈ 0.75 × torque rpm at full throttle, just over idle when creeping): ramping it
  from idle parks the engine at ~1350 rpm with no torque (0–100 was 22 s instead of 15). 0 in N and mid-shift.
- **Torque converter** (auto): the impeller absorbs `T_imp = (ω_e/K)²·sign(ω_e)`, so the engine has a load at stall.
  Size the capacity factor from the stall speed (published, else ≈ 1.1–1.3 × torqueRpm at full throttle):
  `K_stall = ω_stall/√T_peak`, rising ≈ 1.5× towards SR 0.85. Turbine torque = `T_imp × TR(SR)`, with the
  multiplication `TR` 2.0 → 1.0 over speed ratio SR = ω_turbine/ω_e 0 → 0.85, `× (1 − SR²)` (no torque at 1:1, engine
  braking past it), then lock-up from 2nd (the clutch constraint). DARK holds the car at a standstill off the pedals
  (auto hold, §8.6 static hold) instead of creeping.
- **CVT:** converter at launch, then the ratio slews (≤ 1 ratio/s) to hold `rpm_target = lerp(1.3·idle, 0.9·powerRpm, thr)`.
- **EV:** direct.

**Shift logic** (stepped transmissions; rpm thresholds, `thr` smoothed):

```
upRpm(thr)   = lerp(0.42, 0.93, thr^0.8) · redline        downRpm(thr) = lerp(0.24, 0.42, thr) · redline
upshift   rpm > upRpm AND, at the pedal the NEXT gear needs for the same pull (demand × g[n]/g[n+1] × T(rpm)/T(rpm')),
          rpm' = rpm·g[n+1]/g[n] > downRpm(that pedal) + 0.10·redline      (load check → no hunting on a grade)
          (at ≥ 0.93·redline it always goes up)
downshift rpm < downRpm AND rpm·g[n−1]/g[n] < 0.9·redline               (never over-rev)
anti-hunt no part-throttle upshift 2.5 s after a downshift, no downshift 1.5 s after an upshift (unless the revs
          demand it: > 0.9 / < 0.25 × redline)
kickdown  the RAW pedal +0.5 within 0.2 s → down 1–2 gears if the result < 0.85·redline (the ramped pedal never
          jumps 0.5 — detect on the input)
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
- **Layouts** compose these per axle and between axles. **Low range** multiplies the ratio (only ≤ 8 km/h) and
  locks the centre (part-time: 4L; permanent 4×4s with a centre locker lock it with low range, like the G-Class).
  Lockers are toggled by the player. Never hand-write "traction split by load": diffs plus tyres produce it.
- **As impulses:** every diff is a friction clutch between its two sides — the impulse that would equalise their
  speeds, `Δω/(1/I_a + 1/I_b)`, clamped to the diff's torque capacity × h (open 0, LSD preload + bias·T_in, Torsen
  (TBR − 1)/(TBR + 1)·T_in, viscous c·Δω, locked unclamped). Unconditionally stable at any stiffness.

**Wheel ω stability:** slip stiffness (≈ B·C·D·Fz) makes the low-speed wheel time constant ≪ 1 ms. Use all three:
1. 8 substeps;
2. overshoot caps: `Fx·s ≤ s·((ωr − v_x)·I_eff/(r²·h) + T_other/r)` with s = sign(ωr − v_x), I_eff = I_w + the engine
   reflected through a locked clutch (`I_e·G²·a_i`) and T_other = the wheel's drive / brake / diff torque of the
   last substep — capping on the slip term alone starves a crawl (the G500's rear tyres gave half their grip on a
   35° climb); `|Fy| ≤ m_share·|v_y|/dt` (the frame step: the body only moves in the physics step);
3. a slip floor `max(|v_x|, 1.5 m/s)` + relaxation length σ 0.3–0.5 m.

**Static hold** (below 0.8 m/s, fully below 0.16, with the brake, the handbrake, P, or no throttle): per wheel
`F = −m_share·(v_hold/dt + g_t)`, capped at μ·Fz, where v_hold is the patch velocity from the body's TRAVEL AND
YAW ONLY and g_t gravity in the contact plane. Cancelling the full patch velocity (incl. pitch / roll rate) pivots
the body about its tyres every step and it walks — 1–7 cm per 6 s on 15°, even uphill; with travel + yaw: 0.0 cm.
Full gain: Rapier's spring impulse has already acted in this step, any less creeps. **Hill-start assist:** for
1.5 s after the hold lets go (still < 1.5 m/s), the static force may only push the way the car drives — it never
rolls back before the clutch bites.

**Outputs:** `rpm`, `gear` (−1 R, 0 N, 1…n; EV shows D), `selector`, `shifting`, `load`, `clutch`, `boost`, `regen`,
`lowRange`, `locks`, and per wheel `ω`, `κ`, `α`, `Fz`, `surface`.

### 8.7 Tyres, surfaces, brakes, steering, aids

**Tyre forces** (contact frame, per wheel, per substep):

```
κ  = (ω·r − v_x)/max(|v_x|, 1.5)      α_ss = atan2(v_y, max(|v_x|, 1.5));   α += ((|v| + 0.5)/σ)(α_ss − α)·h
μ  = tyreKind.μ · surface.μ · grip scale · max(0.6, 1 − 0.1·(Fz/Fz_static − 1))   (load sensitivity)
combined slip (Pacejka similarity): ρx = κ/κ_p, ρy = tan α / tan α_p, ρ = hypot(ρx, ρy)
  C = (1.6·ρx² + 1.3·ρy²)/ρ²,  B = tan(π/2C)  (peak at ρ = 1),  F = μ·Fz·sin(C·atan(B·ρ))
  Fx = F·ρx/ρ,  Fy = −0.95·F·ρy/ρ                 κ_p = 0.10 (× 1.3 off-road), α_p = kind peak / surface stiffness
  loose ground past the peak (ρ > 1): F += (1 − F)·0.75·offroad   (LOOSE_KEEP: soil keeps ~90 % of the peak)
  tread heat on loose ground × (1 − 0.8·offroad)                     (TYRE.looseHeat: the soil moves, not the rubber)
then the §8.6 caps; rolling resistance: friction torque on ω (c_rr·Fz·r), never reversing it
```

Why not the published dry-tarmac set (B 10, C 1.9, E 0.97) with a lateral twin (C 1.3, E 0.97) and a friction
ellipse: that longitudinal curve peaks at κ ≈ 0.18, the lateral one with E 0.97 never peaks at all (no breakaway),
and an ellipse lets a locked wheel keep ~70 % side grip (it steers instead of skidding straight). The similarity
method points the force along the slip vector: a locked wheel slides along its velocity, a spinning one loses side
grip. A locked wheel keeps ~65 % of the peak.
GTA-SMOOTH DEFAULT (2026-10-16, user: "make car driving smooth like in GTA; Space is for brake"): aids 'auto' = FULL
on keys and touch (Car.driveSettings). With aids on: GRIP-LIMITED steering (δ ≤ atan(L·1.05·μg/v²): a full key at speed
asks for the grip there is — before, half lock at 60 km/h asked ~3 g and a 0.5 s lane change spun the pickup 135°),
an ASSIST ABS on Full for cars without one, and the GTA HANDBRAKE: Space with the wheel straight (|steer| < 0.2) = a
hard stop on all four (brake 0.9, ABS), Space + steer = rear lock (handbrake turn). Measured (pickup, 60 km/h, game):
lane change heading ±3° (was a 135° spin), S 24 m / 9° yaw (33 m / 50°), Space 23 m / 8° (41 m / 572°), Space + A
turn 167°. Aids Off = the raw machine, unchanged. Tests: "aids Full — …" ×3 per car. Also: the frame clock is the
rAF vsync timestamp (scene/GameLoopDriver) — R3F's performance.now() delta jittered ±0.5 ms → the 60 Hz fixed step
ran 0/2 times per frame, chase camera 11 → 1.6 mm/frame² jitter.

LOOSE GROUND (2026-10-16, user: "even a small hill — the tyres just spin there"): with the asphalt falloff on every
surface, a floored aids-off rear-drive pickup spun at κ ≈ 8 on a 10° grass hill, lost ~40 % of its force, cooked the
tread to 200 °C (−30 % grip) and rolled back — in game 0 m up every 10° hillside tried. Soil traction–slip curves
plateau instead of dropping, and the soil, not the rubber, takes the slip energy: now it climbs (14–28 m in 8 s in
2H, tread ~60 °C); asphalt is unchanged. Test: every car floored up a 10° grass hill (tests/drivetrain.test.ts).

This produces, with no special cases:
- understeer from entering too fast;
- lift-off and power oversteer;
- burnouts;
- locked wheels skidding straight;
- handbrake turns;
- bogging in sand.

**Ground roughness** (`tyre.ts` `roughness`): the terrain mesh is smooth at wheel scale (heights every 2 m), so
without it the springs have nothing to work on and the suspension looks dead. Each wheel rides a deterministic bump
height h(x, z) of its surface — rolling noise (2.6 m + 0.8 m wavelengths) ± amplitude (asphalt 7 mm, dirt 35, grass
50, sand 30, snow 25, ice 4) plus sparse round stones on stony ground (dirt, grass) — by growing its Rapier rest
length by h (the spring sees the ground raised exactly as a taller ray hit would), lifting the rendered wheel by h,
and feeding dh/dt to the damper as a force at the hard point (Rapier's damper only sees its ray). Measured: on a
dirt road at 45 km/h each wheel moves ±5–9 cm on its own, the body rolls ±3–6° and pitches 3°. Tests run on a
smooth ground (roughness 0).

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
  ABS cars get 15 % headroom (the ABS uses it); without ABS the system is sized just under lock-up (× 0.92).
- **Bias for the DYNAMIC load:** `front = static front share + (COM height / wheelbase) × maxDecel` (0.5–0.85). Sized
  on the static share, a tall car's front brakes run out of torque before its front tyres run out of grip (the
  G500: 0.71 g instead of 0.9).
- **EBD / proportioning:** rear brake torque × clamp(Fz/Fz_static, 0.35, 1) — under hard braking a tall car's rear
  goes light (G500: 3.1 of 7.7 kN per tyre) and full rear pressure locks it and yaws the car around.
- **ABS (verified):** μ peaks at 8–30 % slip, target ≈ 15 %, cycling up to 15–20 Hz. Rule: κ < −0.15 → release
  (× 0.25) until κ > −0.06; off below 2 m/s.
- **Handbrake:** rear axle, 1.5 × its grip torque, bypasses ABS. Pulling it OPENS the auto-clutch (a driver's left
  foot goes down with the lever: the engine keeps its revs, the clutch bites again on release and kicks the slide
  on), and stands TCS and ESC back while it is held.
- **Drifting** (measured, aids off): a handbrake flick at 50 km/h can be CAUGHT (counter-steer + lift → straight)
  and HELD (balanced throttle + proportional counter-steer: the LSD pickup 15–57° for 2.3 s). What it took:
  (1) no gear changes while sliding (rear slip > 9°) or 1.2 s after the handbrake — a kickdown into 1st mid-slide
  spun every car; (2) full mechanical lock when steering INTO a slide (the speed-sensitive lock is for steering
  into a turn — with it a slide couldn't be caught above walking pace) at the crawl rack rate; (3) a rear LSD where
  the real car had one (an open diff spins only the inside wheel); (4) the REAL car's aids as its default: a 1989
  pickup or a 1972 van has no TCS / ESC (spec `aids`), so they slide like the real thing; touch still defaults to
  Full.
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
| TCS | BRAKE a driven wheel faster than the slowest driven one (across the axle or the centre: an open diff feeding a light wheel); ENGINE: PI on the mean driven slip SPEED vs max(1.5·κ_p·v, 0.4 m/s), off while rolling back against the drive (a hill beating the tyres: cutting power deadlocks the climb); LAUNCH CONTROL: clutch / converter output ≤ 0.95 × the driven tyres' μ·Fz·r | off / on / on |
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

**Tyre deformation** (visual only; implemented — `Car.ts` shader + `tyreW` from the loader, `rim` extra):
- Per wheel: `squash = s0·min(1.5, 0.6 + 0.4·Fz/Fz_static)` (0 off the ground), s0 = 6 % of the sidewall height
  ((1 − rim ratio)·r: ≈ 1.2 cm on the trucks' 31–36″ tyres), eased over ~80 ms — a pumped-up tyre barely changes
  with load (12 % fully load-following looked like a balloon), sidewall bulge 0.45·squash, and `shear = −clamp(Fy/max(Fz, 1), −1, 1)·0.03` (HIGH;
  the patch trails opposite the cornering force; negated on the right wheels).
- Lower the rendered hub by `squash`.
- Shader inputs: `uTyre[k] = vec4(wheel-local down, squash/scale)`, `uTyreR` = tread radius, per-vertex
  `tyreW = smoothstep(rimR, tyreR, radial distance)`, and `wheelIdx` (§6; 0 on non-wheel geometry):

```glsl
// `flat` is reserved in GLSL ES 3.0 — don't use it as a name. Index by the baked `wheelIdx` (§6): gl_InstanceID
// alone restarts per draw. Clamp the index to the wheel count.
if (tyreW > 0.0) {
  int wi = min(int(wheelIdx + 0.5), WHEELS - 1);
  vec4 ty = uTyre[wi];
  float plane = uTyreR - ty.w;
  float d = dot(transformed, ty.xyz);
  transformed -= ty.xyz * max(d - plane, 0.0) * tyreW;                       // flat contact patch
  float band = smoothstep(plane - 0.35 * uTyreR, plane, d);
  transformed.x += sign(transformed.x) * ty.w * 0.6 * band * tyreW;          // sidewall bulge
  #ifdef TYRE_SHEAR
  transformed.x += uTyreShear[wi] * band * tyreW;                           // negated for right wheels (§2)
  #endif
}
```

Normals are computed before `begin_vertex`, so repeat the test in `beginnormal_vertex` to bend them.

**Off-road assist** (gameplay, Settings, on by default; off = the real machine, which every realism test drives):
engine torque × 1.6 (× 2.2 on steep ground); on a slope over ~20° (contact normals) the part-time 4×4 goes into
4H / a permanent one locks its centre, the axles lock, 1st is held below 50 km/h, TCS and launch control run
whatever the aids, and a SLOPE LIMITER at the COM cancels the steeper part of the slope (uphill force + press into
the ground) so the tyres meet at most ~26° — less when the driven tyres can't hold that (a rear-drive van on grass)
— and the static hold only cancels what is left. Nothing acts below the COM, so it never back-flips; every car
crawls an 80° wall in 1st on asphalt and grass and holds still on it (tests). Gotcha found on the way: the
auto-righting rule ("up axis < 0.35 for 2 s") must require the wheels OFF the ground — on an 80° wall a climbing
car's up axis is 0.17. Also: the auto-clutch now launches at the torque peak at full throttle (0.75 × left the
1989 pickup unable to pull away on 26°).

**Tyre noise**: a rubber squeal only on hard ground (asphalt, ice), from the worst slide angle and wheelspin /
lock, nothing at a crawl; on loose ground a synthesized SCRUB (looping noise → band-pass: a gravel crunch on dirt,
a low hiss on grass / sand / snow) — `TruckSim.tyreNoise()` → `AudioSystem` `car.tyres`.

**Paint grade** (catalogue `grade`): toy-bright model textures are graded toward weathered real paint at load
(saturation × 0.5–0.55, brightness × 0.88–0.9), rust and grime kept.

**Working-vehicle details** (`scripts/blender/vehicle_details.py`, after the wheels — its kit is REMOVED again by the cabin step below: the player asked for the vehicles only): kit per car in metres from the
wheels and the body (heights / widths measured locally: a central strip for the roof, the sill band for sliders,
so antennas and mirrors don't throw it): pickup — LED light bar on the cage, spotlights + winch on the bull bar,
spare + jerrycans + toolbox in the bed, rock sliders, snorkel, tow hitch; G500 — the rear spare in a
hard cover, roof rack on feet with jerrycans and a bag; Żuk — roof rack with a tarp load and crates,
ladder, rear step (mud flaps were tried and removed: black slabs at game distance). One `acc_*` part per car (560–1270 tris) on the wheels' vertex-coloured material
(no extra material), never painted; AO re-baked (kit albedo × AO; wheels and brakes keep theirs). Re-imported
parts must have an ACTIVE colour attribute and the shared material's colour node must read their name ('Color'),
or the exporter drops their COLOR_0 (white tyres). Totals: pickup 18.7 k, Żuk 24.2 k, G500 38.6 k (its hidden
underbody details decimated 0.7) — all ≤ 40 k, ≤ 12 materials.

**Real wheels and finish** (`scripts/blender/vehicle_realism.py`): every car's wheels are rebuilt in Blender at the
model's size — a revolved carcass with a bulging sidewall, staggered tread blocks + shoulder lugs (mud-terrain /
all-terrain / road by the car), and a steel (dish, vents, lug nuts), alloy (spokes: the brakes show) or capped
rim — 2.4–2.9 k tris per wheel, named `wheel_<FL|FR|RL|RR>` with a `rim` extra. Then Cycles AMBIENT OCCLUSION is
baked into every part's vertex colours (glass-only parts hidden so the cabin gets light); the loader multiplies it
into the material colour (scene extra `vertex_ao`), divides the neutral texel's tint out of untextured parts and
keeps untextured interiors dark. In the car shader: a soft terminator (stylize toon 0.3, rim 0.14 — the cel look
made the cars read as toys), a DIRT coat by height above the ground (thick on tyres and the lowest 30 cm, broken
by noise, thickening off-road, washed by rain, tinted by the ground under the car — mud, desert dust, snow slush)
and paint GLOSS on MEDIUM+ (sun highlight + sky Fresnel; none under dirt or on rubber). Coil springs are black,
not toy-blue.

**Cabin, glass and cockpit** (`scripts/blender/vehicle_cabin.py`, MODE=BUILD, after the details; SRC = the
pre-cabin GLBs, never the game folder it writes — a re-run would stack a second cockpit). The `acc_*` kit is
REMOVED (the cars carry only their own parts). Every window face goes on ONE material `glass` (the Żuk's painted
windows — dark low-saturation texels in the window band — become real glass). Built from the measured frame and
rays cast from the game's eye (`Car.eyeLocal`): `steering_wheel` rebuilt (Hilux 4-spoke grey, G-Class 3-spoke
leather + star, Żuk thin 2-spoke bus wheel), `cab_<car>` static cabin (Żuk: dash up to the screen, engine hump,
seats, benches, floor, visors, mirror; G500: vents, grab handle, console + wood, diff-lock buttons), `dial_<car>`
gauge faces UV-mapped onto a canvas (material `dial`), and moving parts with `pivot` / `axis` extras:
`pedal_gas|brake|clutch`, `gear_lever`, `wiper_L|R`. Totals: pickup 18.1 k, Żuk 24.5 k, G500 39.0 k (its hidden
underbody decimated to fit), ≤ 12 materials. In game: `loadModels` keeps the cabin out of the collider and puts the
controls in pivot space; `Cockpit.ts` draws the instruments like the real dash (Hilux round speedo + tacho, Żuk
cream speedo + lamp strip, G-Class wide twin screen) only when they change and only in first person (≤ 15 Hz), and
moves the pedals (throttle / brake / clutch), the lever (H gate / P R N D) and the wipers (with the rain). The body
draws both faces (from inside the shell is the cab's walls); `carGlass` is UNLIT tinted glass (a lit pane read as a
milky window), visible from inside — first person no longer hides it. Cost: +1 draw (dials) + ≤ 6 small control
draws, 1 transparent program.

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

### 8.11 Damage (optional), boat mode and co-op

- **Boat mode** (O while driving, `Car.toggleBoat`; hull `BoatHull.ts`, handling in `VehicleSim`): `sim.boat`
  0 → 1 follows the hull deploy. As soon as the hull moves (boat > 0) — and while flying — `TruckSim` switches
  Rapier back to the LEGACY setup (world gravity 20, collider masses, Rapier tyre friction): the buoyancy, the keel
  crawl and the hover were tuned for it. The drivetrain keeps its state; from boat 0.5 the boat handling drives
  (buoyancy, the water jet, the keel on land raised by `KEEL`). Back to boat = 0 (not flying) the drivetrain setup
  returns, each wheel's ω set to the ground speed and the box back in gear. The handoff is the same for every car;
  the only per-car boat data is the fitted hull. Tested: keel crawl ≤ 16 km/h with the hull out, drives off after.

- **Damage (GTA-style, `gameplay/vehicle/Damage.ts`):** an impact = the chassis' velocity change over the last 4
  fixed steps (67 ms) with gravity added back, above 6 m/s (tyres, brakes and suspension never change it that fast;
  walls, trees, rocks and hard landings do) → damage ≈ 4 % per m/s over (≤ 45 % a hit, 0.3 s cooldown; a 12 m drop ≈
  24 %). The hit DENTS the car where the push came from: shell, door and glass vertices within 0.35–0.95 m of the
  contact (body box exit along −Δv) move inward up to 24 cm with crumple noise, flat normals on the crumpled faces
  (each car has its own geometry copies). 0.4 s after the last hit the exact trimesh collider is rebuilt from the
  dented shape (`VehicleSim.replaceMesh`). 50 %: the engine bay smokes (VehicleFx `engine`), 90 %: it burns (+ HUD
  warnings, the DAMAGE bar under the speedometer), 100 %: it EXPLODES — fireball / smoke / debris burst, a boom,
  anyone within 9 m hurt (the driver, thrown out, ~90), the car thrown up and burnt black (`uBurn` in the car
  shader), undrivable; 12 s later a fresh car of the same model waits on the road (`Game.respawnCar`). Cost: a
  velocity ring per step; a dent ≈ 1–3 ms CPU; a collider rebuild ≈ 5–20 ms (only after hits).
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
| Spec sheets | `src/gameplay/vehicle/specs.ts` (`SPECS`: Node-importable), referenced by `catalogue.ts` `spec` | exists: pickup (1989 Hilux 22R-E / W56 / RF1A), G500 4×4² (M176 / 7G-Tronic / 3 lockers), Żuk A06 |
| Spec → numbers | `src/gameplay/vehicle/drivetrain/spec.ts` (`resolveSpec`, class defaults, tyre sizes, torque curves) | exists |
| Drivetrain | `drivetrain/Drivetrain.ts` (engine, clutch / converter / CVT / EV, shift map, diffs, tyres, brakes, ABS / EBD / TCS / ESC, static hold), `drivetrain/tyre.ts` (combined slip, surfaces), `drivetrain/surface.ts` (DARK's road / region / ice / wet sampling) | exists; render-free, Rapier-free |
| Sim glue | `VehicleSim.ts` `TruckSim`: `setDrivetrain`, `configure('drivetrain' \| 'legacy')`, `afterReal` (contacts, ARB, bump stops, forces at the patches, aero), `real` | exists; Simulation handling on the wheels; arcade / legacy / boat / hover unchanged |
| Model bake / normalise / part splitting | `src/assets/loadModels.ts` `bakeVehicle` | exists; reads `wheelRegex`, `door_FL/FR` + `hinge`, `steering_wheel`, lamps, glass, `inner`, `caliper_*` (→ `brakes` per axle, vertex colours kept). Planned: rear doors, hood/trunk, empties, `lamp_ind_*` |
| Blender prep scripts | `scripts/blender/vehicle_doors.py`, `vehicle_finish.py`, `vehicle_brakes.py` (disc + hat + caliper / drum per corner, budget pass), `bl.mjs` (runs a script over the MCP socket) | exist |
| Render | `src/gameplay/vehicle/Car.ts` (one instanced program: body, wheels, brakes, steering, doors, axles, struts, lamps) | exists; wheel spin = the drivetrain's ∫ω, lamps from its brake / gear; linkages per type, deformation, gauges planned |
| Controls / settings | `Car.shift` / `toggleLowRange` / `cycleLockers` / `driveSettings`; keys X Z Q K (`Game`); Settings → Controls: Gearbox (auto / manual), Driving aids (car default / off / std / full) | exists; touch buttons for gears / low / lockers planned |
| Entry / exit animation | `src/gameplay/vehicle/CarEntry.ts` | exists (front doors) |
| Effects / audio / HUD | `rendering/particles/VehicleFx.ts` (per-wheel slip), `audio/AudioSystem.ts` (`car.sim`: rpm / load / shift from the drivetrain; the fake gearbox stays for arcade), `ui/GameHud.tsx` (tacho bar, gear, ABS / TCS / ESC / LOW / 4WD / LOCK lamps) | exists |
| Boat mode | `src/gameplay/vehicle/BoatHull.ts` (hull fit + deploy pose), `VehicleSim` `boat` (buoyancy, jet), `Car.boatStep` | exists; handoff per §8.11 |
| Tests | `tests/drivetrain.test.ts` (`npm run test:drivetrain`, part of `npm test`: the universal suite, 56 checks over the 3 cars), `tests/vehicle.test.ts` (arcade, legacy, bike, boat, flight, entry) | exist |

DARK specifics:
- **Rapier `@dimforge/rapier3d-compat` 0.21:** `DynamicRayCastVehicleController`. Forces go in before
  `world.step`; velocity edits only in `afterWheels`. Retune in place, never rebuild the body. Wheel rays see
  `Terrain | Static` only. Keep CCD, `keepAbove` and the physics-ring freeze.
- **World `GRAVITY = 20`:** the realistic model uses the body gravity scale (§8.8); arcade keeps 20.
- **Settings default handling is `'sim'`** = the drivetrain (the legacy realistic model remains only for cars with no
  `spec` and for the boat / hover). Arcade stays. The garage sliders scale the spec relative to the car's stock
  tuning (power, mass, grip, springs as √, tyre size); arcade keeps reading them directly.
- **Keys in use:** E F G L N O R T V X Z Q K, arrows, Space, Shift, F3–F8, [ ]. Free for cars: H (hazards).
  Shift in Simulation = nitrous (engine torque × 1 + (boost − 1)/2).
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

**Universal suite** (`tests/drivetrain.test.ts`): for every car in `SPECS` (models measured from the loader), every
expected value computed from the car's own spec. Implemented now (56 checks, all passing): settle level, heave
frequency (damped, ± 12 %), parked on 15° (< 2 cm), hill hold, 0–100, top speed, redline, upshift rpm, kickdown (or
none when the gear below would over-rev), steady 5° climb, TCS off / on launch on grip 0.15, 35° in low range with
the car's lockers, skidpad, handbrake slide, braking distance (no-ABS target × 0.92), ABS steering, ESC lane change
on dirt, 1.5 m drop, boat handoff. Not yet: the items below marked (planned).

- **Static:**
  - settles level (ride height ± 2 cm, roll/pitch < 1°);
  - parked on 15°: < 0.02 m drift in 6 s;
  - 0.5 m/s straight for 10 s: lateral < 0.05 m/s, no κ/α oscillation (planned).
- **Springs:** heave frequency ± 12 % of the axles' damped frequencies; roll gradient within the class range and
  dive 1.5–3° at 1 g (planned).
- **Powertrain:**
  - top speed = min(gearing `v_top`, drag limit) ± 5 %, and ± 10 % of `published.topSpeed`;
  - 0–100 ± 15 % of `published.zeroTo100`;
  - stepped boxes shift at upRpm(1) ± 5 %, ≤ 1 shift in 10 s on a steady 5° climb, kickdown within 0.3 s, never
    above the redline;
  - CVT holds rpm_target ± 5 % (planned: no CVT car yet);
  - EV: no shifts, regen decelerates on lift, and the car comes to rest on the flat without rolling backwards
    (planned: no EV yet);
  - auto: full-throttle stall rpm with the brake held = the spec's ± 10 % (planned); off the pedals it holds still.
- **Traction:**
  - launch on grip 0.15 → wheelspin (rim > 1.5 × ground) with TCS off, κ < 0.3 with TCS on;
  - low range (if any) climbs 35° with the car's lockers engaged;
  - an open diff with one wheel lifted barely moves; with the locker it climbs (planned).
- **Grip:**
  - skidpad lateral ≈ μ·g ± 25 % on asphalt (tall AT-tyred trucks sit at the low end); surfaces in the table's
    ratios ± 20 % (planned);
  - handbrake slides the rear (|α| > 15°) without rollover.
- **Brakes:**
  - 80→0 stops straight (< 3°) in −15 … +25 % of `v²/(2·a·g)`, a = maxDecel (× 0.92 without ABS; the pedal ramp
    adds a few %);
  - braking while steering turns > 15° with ABS;
  - ESC (Full) lane change at 25 m/s on dirt < 35° slip.
- **Body:** 1.5 m drop never passes through the ground.
- **Boat handoff:** deploy → retract, on land and in water: no torque reaches the wheels while `boat ≥ 0.5`, and the
  car drives off normally afterwards.
- **Feedback:** audio rpm = sim rpm ± 2 % through every shift; HUD gear = sim gear; 0 React re-renders per frame
  (planned as tests; the code reads the sim directly: `TruckSim.real`).
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
  `refer/roads/forest-road-evening-hero.png` (required, CLAUDE.md) and `refer/roads/road-power-lines-truck.png`
  (vehicle scale and read on the road).
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
