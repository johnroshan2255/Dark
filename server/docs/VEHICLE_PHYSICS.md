# Server-authoritative vehicle physics — audit, design, plan

Status: **Stage A (audit + design) done 2026-10-22.** Later stages are tracked in the table at the end; nothing is
marked done until its acceptance test passes.

## 1. What exists today (audit)

| area | where | how it works |
|---|---|---|
| Client physics | `game/src/physics/PhysicsWorld.ts` | `@dimforge/rapier3d-compat` **0.21.0** (WASM build of Rust rapier3d **0.36.1** / parry3d 0.31.1). Fixed **60 Hz** step, accumulator, ≤ 4 substeps, gravity 20 (2× real; the drivetrain car runs at 9.81 via gravity scale). |
| Terrain colliders | `PhysicsWorld.addChunk` | one **heightfield per 64 m chunk, 32 × 32 cells = 2 m** (on maps: the map's `heights.bin` grid, desert pools carved ~1 m at load), a road-ribbon **trimesh** over it (`Terrain\|TerrainMesh`), rock formations as trimeshes (`StaticMesh`), boulders as convex hulls, tree trunks as cylinders, props as boxes / cylinders. Only within the physics ring round the player (+ where a moving car will be in ~1.5 s). |
| Map set pieces | `world/map/MapProps.ts` | `props.json` instanced per 200 m tile; fixed colliders within 140 m; plank bridges as trimeshes from `map.json` `bridges`. |
| Collision groups | `PhysicsWorld.Groups` | Terrain 0x1, Static 0x2, Player 0x4, Monster 0x8, Vehicle 0x10, Debris 0x20, VehicleMesh 0x40, StaticMesh 0x80, TerrainMesh 0x100 (`(member << 16) \| filter`). |
| Vehicle model | `gameplay/vehicle/VehicleSim.ts` `TruckSim` (1 754 lines) + `drivetrain/` (1 805) | Rapier **dynamic body + `DynamicRayCastVehicleController`** used for **springs and wheel contacts only**. In the default *Simulation* handling (`mode 'drivetrain'`) Rapier's tyre friction and damping are OFF: our own damper (digressive, bump/rebound), anti-roll bars, bump + hard stops, a **tyre envelope** (8–18 ray casts per wheel per step: tyres roll over stones), and `Drivetrain` (engine curve, turbo, gearbox / CVT / converter, clutch, open / LSD / Torsen / viscous / locked diffs, per-wheel ω, combined-slip tyre forces, tyre heat, ABS / TCS / ESC, cornering assist) apply every tyre force with `addForceAtPoint`. Other modes on the same body: *legacy* (Rapier friction; used by **arcade** handling, the **hover**/flying car and the **boat**). Plus a BMX (`BikeSim`). |
| Car data | `gameplay/vehicle/catalogue.ts`, `specs.ts`, `drivetrain/spec.ts` | 3 cars (pickup, gwagen, zuk). A spec sheet → `resolveSpec()` → `Resolved` (plain SI numbers, JSON-able). Body geometry (`TruckDims`: wheel positions, radius, half extents, convex hulls, exact trimesh) is baked from the GLBs at load (`assets/loadModels.ts`). |
| Per-step extras | `Car.fixedUpdate` | input → pedals (`keyPedals` smoothing), `unhook`, `Damage.step` (dents, wreck), fly / boat transforms, freeze when no ground collider streamed, `keepAbove`. |
| Server | `server/` Rust, tokio + axum, one task per match | `Match` ticks at **30 Hz** (`MatchConfig.tick_hz`), WebSocket binary protocol v3, interest management (≤ 64 entities, 30 / 15 / 5 Hz by distance), rooms, HMAC tickets, Prometheus metrics. |
| Authority (v1) | `sim/src/validate.rs` | **Client-authoritative movement with server validation**: the client streams its own pose (`State`, 30 Hz); the server checks speed caps, teleport, ground (heightfield, 2.5 m tolerance), bounds, flying, and answers a `Correction` (snap + epoch) or kicks. Server owns lifecycle, zone, HP, roadkill, eliminations. |
| Bots | `sim/src/bots.rs` (2 288 lines) | **Kinematic, no physics.** AI (cruise with IDM car-following, overtakes, junctions, races, convoys, explore, boat, fly, stroll, hang out, AFK) **writes the pose directly**: snapped to a lane on the road graph (`nav.rs`), speed integrated with lateral-acceleration caps, heading eased at 3 rad/s. Bots pass through each other, players and props. Far bots update at ¼ rate and are recycled near humans. |
| Client remotes | `net/RemotePlayers.ts`, `RemoteCar.ts` | Snapshots buffered, rendered **100 ms in the past** on the server clock, ≤ 200 ms extrapolation. The near car is drawn like the player's (wheels roll with speed, fronts steer from yaw rate), but with **no suspension / roll** (the wire has yaw + pitch only) and **no collider**: your car passes through remote cars and bots. |
| Prediction / reconciliation | — | None (the client IS the authority for its own car). `Correction` = hard snap. |
| Measured (before) | `cargo test --release -p dark-sim bench_room -- --ignored` | 100 players + 100 bots in one room: **step 50 µs + snapshots 433 µs = 483 µs per 30 Hz tick**, 34 KB/s per player (M4). Client: 60 fps headless with 12 bots online (LOW). |

## 2. Findings that shape the design

1. **The physics engine already matches.** rapier3d 0.36.1 is the Rust source of the client's WASM build: the same
   raycast-vehicle controller, the same heightfield / trimesh / hull contact code. Porting is a port of OUR code
   (TruckSim drivetrain mode + Drivetrain + tyre + surface ≈ 2 400 lines of TypeScript), not of Rapier's.
2. **The car is data.** `Resolved` specs and `TruckDims` are plain numbers / float arrays. The server must load them
   from a file the game **exports** (one source of truth), not re-type them.
3. **The world the server knows is incomplete.** It has `heights.bin` + roads + biome + bridges. It does NOT have the
   client-generated colliders: trees and boulders scattered by the chunk workers (deterministic from seed + map),
   rock formations, the road ribbon, pool carving, map props. Server-authoritative collisions need them → export a
   per-map static-collider file from the game's own generator (deterministic, so it is the same world).
4. **Endless-world rooms can't be server-simulated**: their terrain exists only in the client generator (a port of
   the whole generator is out of scope). They stay on the v1 validation model. Fixed maps (island, highlands) get
   authority. Battle royale already runs only on fixed maps.
5. **Cost is unknown and must be measured**: the drivetrain mode casts up to 72 rays per car per step; 100 bots ×
   60 Hz = up to 432 k ray casts/s per room plus the solver. No number goes in the docs until measured.
6. **Determinism**: JS and Rust Rapier won't produce bit-identical trajectories (different float paths, WASM vs native
   SIMD). Prediction must assume divergence and reconcile; parity tests use tolerances.
7. **PUBG note**: PUBG's vehicles were in practice client-simulated with server checks (Unreal's replicated movement)
   — what DARK v1 already does. This plan goes further: the server simulates every vehicle.

## 3. Risks (most significant first)

| risk | impact | mitigation |
|---|---|---|
| Port drifts from the client model (two implementations) | predicted car ≠ server car → constant corrections, "rubber-banding" | golden traces: the TS model run in Node (as `tests/drivetrain.test.ts` already does) writes per-step inputs/outputs; Rust must match within tolerance. Pure `Drivetrain` math is checked step-by-step; full vehicles by trajectory. CI runs both. |
| Server world ≠ client world (missing trees / rocks / props / pools) | server car drives through a tree the client crashed into, or vice versa | export static colliders from the game generator per map (`colliders.bin`), checked by a test that compares counts / bounds with the client chunks. Until then: terrain + bridges only, documented. |
| CPU for 100 physical bots | room overruns its 33 ms tick | measure per room / per vehicle first (Stage C). Options, in order: Rapier sleeping for parked bots; fewer tyre-envelope rays (centre line only) for bots no human is within N m of — **documented, measured, never silent**; per-room budget + `dark_tick_overruns_total`; one room per core. |
| Input latency without prediction | sluggish steering | client predicts its own car with the existing TS sim (it already runs it); server corrects. |
| Reconciliation with a shared Rapier world (client) | replaying N steps steps the whole world | start with error-state smoothing (blend position / rotation / velocity errors over ~100–200 ms, snap above a threshold); add input replay of the car alone only if measured error needs it. |
| Arcade handling, flying car, boat, BMX, on foot | not ported in the first stages | stay on v1 (client-reported + validated) per mode, flagged in the protocol; port later. Not silently dropped. |
| Protocol change | old clients break | `PROTOCOL_VERSION` 4, golden vectors, server rejects v3 with VersionMismatch as today. |
| Bandwidth: full vehicle state for 64 entities | more bytes per snapshot | quantised quaternion (smallest-three, 4 B), angular velocity i16×3, 4 wheel compressions u8; only for vehicles within the near interest tier; measure KB/s per player. |

## 4. Target architecture

```
server/crates/
  protocol/   + Input packet, vehicle state in snapshots, own-vehicle ack (v4)
  vehicle/    NEW dark-vehicle: pure Rust, no I/O. rapier3d =0.36.1.
              spec.rs (Resolved + TruckDims, serde) · tyre.rs · drivetrain.rs · truck.rs (TruckSim drivetrain mode)
              world.rs (Rapier pipeline, heightfield + static colliders, groups = client's, fixed 60 Hz)
              control.rs (bot driver: target path + speed → throttle / steer / brake)
  sim/        Match owns a vehicle::World for map rooms; bots.rs AI emits DriveIntent instead of poses (car mode)
  server/     unchanged I/O; new metrics: dark_physics_seconds, vehicles per room
game/
  scripts/export-vehicles.mjs  → public/vehicles/physics.json (Resolved + dims per car)  [shared data]
  scripts/export-colliders.mjs → public/maps/<id>/colliders.bin (static colliders)        [shared data]
  tests/vehicle-golden.test.ts → server/crates/vehicle/golden/*.json (TS traces the Rust port must match)
  src/net/  Input sending, prediction (own car = TruckSim as today), reconciliation, remote vehicle state
```

- **Rates (configurable, chosen by measurement)**: physics 60 Hz (= the client's `FIXED_DT`, so predicted and
  authoritative steps line up), match/net tick 30 Hz = 2 physics steps per tick, snapshots by interest tier as today.
- **Inputs, not poses**: `Input {seq, throttle i8, steer i8, foot_brake u8, buttons}` at 60 Hz, sent in 30 Hz packets
  carrying the last few inputs (redundancy against loss). Server clamps, keeps a short per-player queue (jitter
  buffer), consumes one per physics step, repeats the last on a gap, drops stale / duplicate seqs.
- **Authoritative state out**: per vehicle position, rotation (quaternion), linear + angular velocity, wheel
  compression + steer (visuals); the own vehicle's packet also carries the last input seq applied.
- **Client**: own car predicted with the TS sim at once; on each own-vehicle state, compare with the predicted state
  stored for that seq: small error → smoothed away, large → snap (visible, not hidden). Remote vehicles: snapshot
  buffer + interpolation (exists), now with full rotation and wheel state; optionally a kinematic collider so your
  predicted car meets them.
- **Bots**: AI unchanged in what it decides (routes, lanes, IDM, races…); it outputs a target (look-ahead point,
  desired speed) and a driver controller turns that into throttle / steer / brake for the SAME vehicle model.
  Physics decides where the bot actually ends up; the AI follows from there (no snapping onto the lane).
- **WASM**: deferred, deliberately. The client's whole world (terrain chunks, props, destruction, character
  controller, debris) lives in rapier-compat; a Rust-WASM vehicle would need its own world mirroring all of it. Until
  the client's `PhysicsWorld` itself moves to Rust, the golden traces keep the two implementations honest.

## 5. Stages and acceptance criteria

| stage | deliverable | accepted when | status |
|---|---|---|---|
| A | this audit + plan | written, reviewed | **done** |
| B | `dark-vehicle`: tyre + drivetrain port, one authoritative car on a heightfield | Drivetrain step-by-step matches TS golden; full car trajectory (accelerate, brake, turn) matches TS within tolerance; suspension over bumps, stable on slopes, two-car collision tests; benchmark 1 / 10 / 100 cars on the island heightfield recorded here | **done** (§6) |
| C | bots drive the physical car | road following under physics (no teleports), 100-bot room benchmark (ms per tick, per vehicle, ray/solver split) | **done** (§7) |
| D | human inputs authoritative (protocol v4) | input validation, collisions bot ⇄ human ⇄ human on the server, join / leave / late join | **done** (§8) |
| E | client prediction + reconciliation + remote interpolation | headless drive with injected latency / loss: corrections measured, steering responsive | **done** (§8), with the world-parity gap below |
| F | profiling + impairment tests + docs | multi-room benchmark, overload strategy, limitations listed | — |

## 6. Stage B results (measured 2026-10-22, Apple M4, release build)

**What was ported** (`crates/vehicle`): `spec.rs` (the game's `Resolved` / `TruckDims` / `TruckTune` as serde data,
`curveTorque`), `tyre.rs` (tyre kinds, surfaces, grip blend, combined slip, ground roughness with the game's integer
hash), `drivetrain.rs` (all of `Drivetrain.ts`), `truck.rs` (`TruckSim` in drivetrain mode: Rapier raycast vehicle
for springs / contacts, our damper, anti-roll bars, bump + hard stops, tyre envelope, tyre forces at the contact
points, drag, cornering + climb assists, auto-righting, air-suspension ride height), `world.rs` (gravity 20, 1/60 s,
the game's collision groups, heightfield), `control.rs` (AI driver: target point + speed → the player's controls).

**Parity with the game** (`tests/golden.rs`, traces from `game/tests/vehicle-golden.ts` → `npm run golden:vehicle`):

| scenario | drivetrain replay (worst relative difference) | whole car vs game (worst position error) |
|---|---|---|
| pickup: 3 s full throttle, 2 s turn, 2 s brake, 1 s roll | 2.8e-13 over 480 steps | < 1 mm (velocity ≤ 1 mm/s) |
| G-Class, same | 4.8e-11 | < 1 mm |
| Żuk, same | 1.3e-8 over the first 14 steps (see below) | 5.4 cm over 8 s, ~70 m |
| pickup up a 15° ramp, 5 s | 1.7e-13 | < 1 mm |

The Żuk (no aids, open diff) pulls away with its rear wheels spinning. In that regime the game's OWN drivetrain
turns a 1e-12 nudge into 3 % by step 17 and 100 % by step 20 (TypeScript replayed against itself), so an open-loop
replay can't be followed past the onset by any implementation. **Consequence for the design:** client prediction
will diverge from the server during wheelspin and must be reconciled continuously (Stage E), never trusted.

A game quirk the port reproduces on purpose: `TruckSim.configure` sizes the brakes on the spec sheet's tyre radius
and only then sets every axle to the model's wheel radius (pickup: 0.3937 vs 0.391 m → brakes 0.7 % stronger).

**Behaviour** (`tests/physics.rs`): 0–6 s full throttle 16.4 m/s, brakes 0.67 g (a 1989 pickup without ABS);
over 12 cm planks every 6 m: wheels travel 11 cm, body stays level, never airborne; parked on 20°: slides 4 mm in
5 s; rear-ending a standing car at speed pushes it to 8 m/s, bodies never interpenetrate; an 8-car pile-up stays
upright and on the ground; on a ±3 m heightfield the body stays −0.07…0.15 m from the ground.

**Cost** (`cargo test --release -p dark-sim bench_vehicle_physics -- --ignored --nocapture`, island heightfield
1201², every car at full detail incl. the 8–18 ray tyre envelope per wheel):

| cars | per 60 Hz step (cars + solver) | per car | per 30 Hz tick | of the 33 ms tick |
|---|---|---|---|---|
| 1 | 16 µs (11 + 5) | 16 µs | 0.03 ms | 0.1 % |
| 10 | 110 µs (82 + 28) | 11 µs | 0.22 ms | 0.7 % |
| 100 spread over the roads | 1 319 µs (1 053 + 266) | 13 µs | 2.6 ms | 8 % |
| 100 packed nose to tail (contacts) | 1 187 µs (982 + 204) | 12 µs | 2.4 ms | 7 % |

**Decision:** all 100 bots get full-detail physics; no simplified far-away model is needed at this cost. ~80 % of
it is the per-car step (tyre-envelope ray casts + drivetrain), ~20 % Rapier's solver. Re-measure on the target
cloud vCPU (expect 2–3× an M4 core) before setting rooms per core.

**Not ported yet:** arcade handling, flying (hover), boat, BMX, on foot; the exact body trimesh + dents; the real
cars' convex hulls (needs the browser export, Stage D); the world's trees / rocks / props / road ribbon / pools
(server terrain is the heightfield only until the collider export).

## 7. Stage C results (measured 2026-10-22, Apple M4, release build)

**How bots drive now** (map rooms; `MatchConfig.vehicle_physics`, default on): the bot AI (`sim/src/bots.rs`) plans
exactly as before — lanes, bend speeds, IDM car-following, overtakes, junctions, races, convoys — but in a car its
kinematic step is only a PLAN: a target point (the lane ~4 m + 0.6 s ahead, or the terrain-checked heading off-road)
and a speed (where the AI's acceleration takes it over ~1.2 s). `dark_vehicle::control::drive` turns that into the
player's controls (stick steer, one-axis throttle/brake, park), the game's car model moves the car (60 Hz, 2 steps per
30 Hz tick, `Match::step_bots`), and the bot's pose, speed and road progress are READ BACK (`Bots::after_physics`:
re-projected onto its road edge; > 10 m off the road = thrown off → it drives back). A car that doesn't move while its
driver wants to for 6 s respawns on the road (the game's "R"). Spawns / respawns / landing from a flight or a boat
place the car. Walking, boats and flights stay kinematic (the car waits parked, or leaves the world while it sails /
flies). Endless-world rooms stay fully kinematic (no server terrain).

**The world** (`sim/src/physics.rs`, `MapPhysics` built once per map and shared by every room on it): the map's 2 m
height grid as one Rapier heightfield with the ice floor where water is frozen (the game's `solidHeight`), bridge
decks along the roads' bridge samples, and the tyre-surface sampler (water → ice, roads → packed dirt, else the map's
desert → sand / snow → snow / rest → grass; dry). Cars are the game's three, exported from the running game
(`game/scripts/export-vehicles.mjs` → `crates/vehicle/data/vehicles.json`: measured dims, 29–53 convex body hulls,
the catalogue's stock setup, the spec resolved against the model), with the game's default driving settings (aids
Full, off-road assist on). Collision shapes mirror the client's groups: the hulls meet the ground (friction 0.15), a
second copy stands in for the client's exact body mesh against other cars (0.35), each set ONE compound collider.

**Fixed on the way:** a bot's new car stepped before Rapier's first world step had mass 0 → NaN velocities on its
first step under throttle + steer (`Truck::configure` now has Rapier compute the mass at once; the room test asserts
every car state is finite every tick).

**Cost of the real cars** (`bench_vehicle_physics`, 100 cars on the island, per 30 Hz tick):

| collision setup | per tick | of 33 ms |
|---|---|---|
| frame boxes (golden traces' car) | 2.6 ms | 8 % |
| 2 × 53 separate hull colliders (as the client builds them) | 31 ms | 94 % |
| hulls as 2 compound colliders | 16 ms | 49 % |
| + no continuous collision (CCD) — **chosen** | **3.1 ms** | **9 %** |

Profiled with `sample`: Rapier 0.36 sweeps every "fast" dynamic body for CCD — one moving more than half its
thinnest collider piece per step, i.e. a car of thin hull pieces above walking pace — and recomputes every convex
piece's mass properties per sweep (+32 µs per car per step). The server world has CCD off (`World::new`): a car
(≤ 60 m/s, ≤ 1 m per step) can't tunnel the heightfield (speculative contacts); there are no thin static obstacles on
the server yet. Revisit when trees / posts are added (CCD with simple proxy shapes, or Rapier fixing the per-sweep
mass computation). The client keeps CCD for its one car.

**A room with 100 bots** (`cargo test --release -p dark-sim bench_physics_room -- --ignored --nocapture`, one person
at the island's start, 90 s): 100 cars in the physics; **3.9 ms per tick (11.7 % of 33 ms), worst 9 ms**; driving
bots average 11.1 m/s, 93 % of driving samples on a road, the deepest a body dipped into the ground 0.6 m (a hard
landing's suspension), cars on the 53 m high forest_far bridge deck stay on it; ~0.5 km covered per bot. CI runs the
20-bot version (`bots_drive_physical_cars_on_the_island`): 20 cars, 14 m/s, 96 % on a road, 1 respawn in 40 s.

### Checkpoint: 100 bots with the real game (2026-10-22, headless Chrome on the M4, release server)

- **Profiling in production:** the server injects a monotonic clock into each match (`Match::set_clock`; the rules
  stay clock-free) and records `dark_physics_seconds` (cars' own steps + Rapier) and `dark_bots_ai_seconds` per
  tick, `dark_vehicles_simulated`, and logs every overrun as `slow tick` with the split (AI / cars / solver, steps,
  vehicles, cars built / set down that tick).
- **Live room, 100 bots, the player driving the island's roads 60–90 s** (`bots-net` probe): server 5.4–6.0 ms per
  tick mean (physics ~5.2 ms of it), no overruns on a clean server; client 60 fps (LOW), worst frame 23–27 ms; the
  nearest bot cars move smoothly (largest frame-to-frame jump of a remote car 9 cm; none float or sink). Earlier
  runs that left several 100-bot rooms simulating on the same machine as the browser showed client stalls and a
  93 ms server tick — machine contention, gone on a clean run; the slow-tick log now says which part it is if it
  returns.
- **100 bots right around the player** (`game/scripts/crowd-probe.mjs`, the remote-rendering path with 100 cars
  [+ 100 people] within 70 m): 60 fps on every configuration — LOW desktop CPU 2.3 / GPU 5.6 ms, LOW phone viewport
  with 4× CPU throttle CPU 4.4 / GPU 4.6 ms (with 100 people too), ULTRA desktop CPU 2.4 / GPU 8.9 ms, 158 draws.
- **Known gap until stage D:** the player's own car is still client-simulated and does not collide with the bots
  (it passes through them); stage D puts the human cars into the same server world.

## 8. Stages D + E results (2026-10-22)

**Server (D).** In map rooms (`room_flags::PHYSICS`, server-set) a person's car is a `HumanCar` (`sim/src/physics.rs`)
in the same Rapier world as the bots' cars, driven only by `Input` frames (protocol v4, `docs/PROTOCOL.md`):
- *Frame clock:* physics step k applies frame k (the numbering the client predicts with). A missing frame is stood in
  for by the last controls (≤ 0.25 s, then neutral) and dropped if it arrives late; the clock starts 3 frames behind
  the newest and re-aligns when the stream stalls (12 behind) or bursts (20 ahead). (The first version queued frames
  and repeated without consuming the frame number: on a 60 ± 20 ms link every gap shifted all later frames — median
  prediction error 28 cm, p95 1.2 m; with the clock 2.5 cm / 4 cm.)
- *Validation:* frames clamped by type; duplicates and stale frames ignored; client `State` poses never move a
  driven car; `Vehicle` enter only where the player is (≤ 15 m, on the ground) — otherwise the car appears where the
  server has them; leaving / kick takes the car out; `RespawnVehicle` sets it upright where it is.
- *Out:* the driver's pose is the car's (others see it with roll); `VehicleState` to the driver each tick through a
  latest-only slot (`Conn.veh`), never the bounded reliable lane.
- Tests (`physics::human_cars`): inputs drive the car and are acked; duplicate / old packets apply once; a client
  can't place its car; a silent client's car coasts to a stop; leaving removes the car; a bot-driven car rams a parked
  human car and pushes it 32 m.

**Client (E).** `game/src/net/VehicleSync.ts`: the local car keeps running the game's model (instant steering); each
fixed step's controls become a numbered frame and its predicted body state is kept; each `VehicleState` is compared
with the prediction for its frame — < 2 cm ignored, else 30 % folded in per state (position, rotation, velocity, and
into the later predictions so it's never counted twice), > 3 m / 0.6 rad snapped (visible). Velocity corrections are
not crash damage (`Car.velocityCorrected`; before, corrections wrecked the car). `net/RemoteColliders.ts`: the 8
nearest remote cars as dynamic 1.8 t boxes in the client's world, steered along each remote's newest snapshot
extrapolated to when the server runs our current frame (half an RTT + the 3-frame buffer): the predicted car hits
them where the server's will (kinematic boxes had infinite mass: a head-on reversed our car — twice the server's
velocity change). Remote cars draw the server's roll; in PHYSICS rooms bot cars are no longer set on the client's
ground (their height / pitch / roll are physics on the same grid).

**Measured** (headless Chrome driving the island's roads at ~45 km/h, `auth-drive` probe, link impaired in the page):

| link | bots | prediction error at the acked frame p50 / p95 / p99 | snaps | fps |
|---|---|---|---|---|
| localhost | 0 | 2.8 / 4.6 / 43 cm | 0 | 60 |
| 60 ± 20 ms each way | 0 | 2.5 / 4.1 cm / 1.3 m (start-up) | 0 | 60 |
| 60 ± 20 ms, 5 % input packets dropped | 0 | 2.9 / 4.4 / 5.7 cm | 0 | 60 |
| 60 ± 20 ms, 5 % dropped | 100 | 2.4–2.8 cm / 8–37 cm / 60–90 cm | 0–1 | 60 |

**The open gap — world parity.** The client's world has collision geometry the server's doesn't: the road RIBBON
(gutters, wheel ruts: a trimesh over the terrain), trees, rocks, rock formations, map set pieces, the desert pools.
Driving in the lane near a road edge, the client car dips into a gutter and its body scrapes the ribbon while the
server car rolls on the smooth heightfield: the two drift apart, the correction pulls back, and the scrapes add
client-side crash damage (measured: every non-car hit in the 100-bot runs touched the ribbon). Next milestone:
export the client generator's static colliders per map (`game/scripts/export-colliders.mjs` → `colliders.bin`;
deterministic, the same world) into `MapPhysics`, then re-measure — and move crash damage to the server.

**Still client-side (validated poses, v1):** walking, the BMX, boats, flights, arcade handling, endless-world rooms;
garage tuning (the server runs the stock setup); weather wetness (server ground is dry).
