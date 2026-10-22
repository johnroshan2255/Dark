//! SERVER VEHICLE PHYSICS for a map room (docs/VEHICLE_PHYSICS.md): the map's terrain as a Rapier heightfield and the
//! game's car model (`dark_vehicle`). Only fixed maps: an endless world's terrain exists only in the clients.

use crate::map::MapData;
use crate::noise::WATER;
use dark_protocol::{Input, InputFrame, VehicleState, buttons, drive_opts, m_to_cm, mps_to_cms};
use dark_vehicle::rapier3d::prelude::{Pose, Rotation, SharedShape, Vector};
use dark_vehicle::spec::AidLevel;
use dark_vehicle::truck::Controls;
use dark_vehicle::tyre::{SurfaceMix, surf};
use dark_vehicle::world::{group, groups};
use dark_vehicle::{Truck, World};
use std::sync::Arc;

/// What every room on a map shares (built once per map, like the bots' road graph): the terrain shape, the bridge
/// decks, and the road index the tyre-surface sampler uses.
pub struct MapPhysics {
    terrain: SharedShape,
    terrain_at: Vector,
    decks: Vec<(Vector, Vector, Rotation)>,
    /// The game's static colliders (statics.bin): shape, pose, friction, packed groups.
    solids: Vec<Solid>,
    /// Road segments per 32 m cell: (road, segment).
    cells: crate::fasthash::FastMap<(i32, i32), Vec<(u32, u32)>>,
}

const SURF_CELL: f32 = 32.0;
/// A static collider for every room: shape, pose, friction, the game's packed groups.
type Solid = (SharedShape, Vector, Rotation, f32, u32);

/// Statics are merged per cell of this size (m).
const SOLID_CELL: f32 = 64.0;

/// The map's static colliders for a room: trunks and boulders merged into one compound per SOLID_CELL cell and kind
/// (groups, friction) — a room holds ~1.4 k colliders, not ~50 k — meshes on their own; breakable props left out
/// (the game breaks them off when hit: a car drives through).
fn solids(map: &MapData) -> Vec<Solid> {
    let Some(st) = &map.statics else { return Vec::new() };
    let mut out = Vec::new();
    // (cell x, cell z, groups, friction bits) → the pieces, relative to the cell's corner
    type Cells = std::collections::BTreeMap<(i32, i32, u32, u32), Vec<(Pose, SharedShape)>>;
    let mut cells = Cells::default();
    for s in st.items.iter().filter(|s| !s.breakable) {
        if s.mesh {
            out.push((s.shape.clone(), s.at, s.rot, s.friction, s.groups));
            continue;
        }
        let (cx, cz) = (
            (s.at.x / SOLID_CELL).floor() as i32,
            (s.at.z / SOLID_CELL).floor() as i32,
        );
        let origin = Vector::new(cx as f32 * SOLID_CELL, 0.0, cz as f32 * SOLID_CELL);
        cells
            .entry((cx, cz, s.groups, s.friction.to_bits()))
            .or_default()
            .push((Pose::from_parts(s.at - origin, s.rot), s.shape.clone()));
    }
    for ((cx, cz, g, f), parts) in cells {
        let origin = Vector::new(cx as f32 * SOLID_CELL, 0.0, cz as f32 * SOLID_CELL);
        out.push((
            SharedShape::compound(parts),
            origin,
            Rotation::IDENTITY,
            f32::from_bits(f),
            g,
        ));
    }
    out
}

impl MapPhysics {
    pub fn get(map: &MapData) -> Arc<MapPhysics> {
        map.physics.get_or_init(|| Arc::new(MapPhysics::build(map))).clone()
    }

    fn build(map: &MapData) -> MapPhysics {
        // TERRAIN: the map's 2 m grid (the clients' chunk heightfields are cut from it) with the ICE at the water level
        // where the water is frozen (the game's `solidHeight`).
        let (n, step, origin, heights) = map.height_grid();
        let solid: Vec<f32> = heights
            .iter()
            .enumerate()
            .map(|(k, &h)| {
                let (x, z) = (origin[0] + (k % n) as f32 * step, origin[1] + (k / n) as f32 * step);
                if h < WATER && map.frozen(x, z) { WATER } else { h }
            })
            .collect();
        let (terrain, terrain_at) = World::heightfield_shape(n, step, origin, &solid);
        // BRIDGES: a deck along each road's bridge samples, its top at the road surface, as wide as the road (the
        // client's plank deck is a trimesh there).
        // (with the game's own colliders exported, its plank bridges come with them)
        let mut decks = Vec::new();
        for r in map.roads.iter().filter(|_| map.statics.is_none()) {
            for i in 1..r.pts.len() {
                if !(r.bridge[i] || r.bridge[i - 1]) {
                    continue;
                }
                let (a, b) = (r.pts[i - 1], r.pts[i]);
                let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
                let len = (dx * dx + dz * dz).sqrt();
                if len < 0.05 {
                    continue;
                }
                let rot = Rotation::from_rotation_y(dx.atan2(dz)) * Rotation::from_rotation_x(-(dy / len).atan());
                let up = rot * Vector::new(0.0, 1.0, 0.0);
                let mid = Vector::new((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0) - up * 0.2;
                decks.push((Vector::new(r.half_width, 0.2, len / 2.0 + 0.3), mid, rot));
            }
        }
        let mut cells: crate::fasthash::FastMap<(i32, i32), Vec<(u32, u32)>> = Default::default();
        for (ri, r) in map.roads.iter().enumerate() {
            for si in 1..r.pts.len() {
                let (a, b) = (r.pts[si - 1], r.pts[si]);
                let pad = r.half_width + 20.0;
                let (x0, x1) = (a[0].min(b[0]) - pad, a[0].max(b[0]) + pad);
                let (z0, z1) = (a[2].min(b[2]) - pad, a[2].max(b[2]) + pad);
                for cx in (x0 / SURF_CELL).floor() as i32..=(x1 / SURF_CELL).floor() as i32 {
                    for cz in (z0 / SURF_CELL).floor() as i32..=(z1 / SURF_CELL).floor() as i32 {
                        cells.entry((cx, cz)).or_default().push((ri as u32, si as u32));
                    }
                }
            }
        }
        MapPhysics {
            terrain,
            terrain_at,
            decks,
            solids: solids(map),
            cells,
        }
    }

    /// A physics world with this map's terrain, bridges and (statics.bin) trunks, boulders and set pieces — the shapes
    /// are shared, not copied. Not (yet) here, unlike the client: the road ribbon's ruts, the rock formations, the
    /// desert pools.
    pub fn world(&self) -> World {
        let mut w = World::new();
        w.add_terrain(self.terrain.clone(), self.terrain_at);
        let deck = group(groups::STATIC | groups::STATIC_MESH, 0xffff & !groups::VEHICLE_MESH);
        for &(half, at, rot) in &self.decks {
            w.add_static_box(half, at, rot, deck);
        }
        for (shape, at, rot, friction, g) in &self.solids {
            w.add_static(shape.clone(), *at, *rot, *friction, group(*g >> 16, *g & 0xffff));
        }
        w
    }

    /// Distance to the nearest road's edge (− = on it) within ~20 m (`fields.netRoad(x, z, 20)`).
    fn road_edge(&self, map: &MapData, x: f32, z: f32) -> f32 {
        let mut best = f32::INFINITY;
        let Some(segs) = self
            .cells
            .get(&((x / SURF_CELL).floor() as i32, (z / SURF_CELL).floor() as i32))
        else {
            return best;
        };
        for &(ri, si) in segs {
            let r = &map.roads[ri as usize];
            let (a, b) = (r.pts[si as usize - 1], r.pts[si as usize]);
            let (ex, ez) = (b[0] - a[0], b[2] - a[2]);
            let l2 = (ex * ex + ez * ez).max(1e-6);
            let t = (((x - a[0]) * ex + (z - a[2]) * ez) / l2).clamp(0.0, 1.0);
            let d = ((x - a[0] - ex * t).powi(2) + (z - a[2] - ez * t).powi(2)).sqrt();
            best = best.min(d - r.half_width);
        }
        best
    }

    /// What the tyres stand on — the game's `sampleSurface` (gameplay/vehicle/drivetrain/surface.ts) with a map's
    /// fields: water (frozen or not) is ice, the roads are packed dirt, off them the region's ground (the map's
    /// desert → sand, snow → snow, the rest grass). Not ported: a track's mud stretches / ruts / potholes / gutters
    /// (RoadDetail) and the weather's wetness (each client's own) — the server's ground is dry.
    pub fn sample(&self, map: &MapData, x: f64, z: f64, out: &mut SurfaceMix) {
        let (x, z) = (x as f32, z as f32);
        out.w = [0.0; dark_vehicle::tyre::SURFACE_COUNT];
        out.wet = 0.0;
        out.wash = 0.0;
        if map.height(x, z) < WATER {
            out.w[surf::ICE] = 1.0;
            return out.blend_roughness();
        }
        let on = (0.5 - self.road_edge(map, x, z)).clamp(0.0, 1.0);
        out.w[surf::DIRT] += on;
        let off = 1.0 - on;
        if off > 0.0 {
            let (d, s) = (map.desert(x, z), map.snow(x, z));
            out.w[surf::SAND] += off * d;
            out.w[surf::SNOW] += off * s;
            out.w[surf::GRASS] += off * (1.0 - d - s).max(0.0);
        }
        out.blend_roughness();
    }
}

/// One room's physics: its Rapier world on the map, the cars in it, and what the last ticks cost.
pub struct RoomPhysics {
    pub world: World,
    pub map: Arc<MapData>,
    mp: Arc<MapPhysics>,
    /// Bodies to take out at the next step (cars whose bot left).
    graveyard: Vec<Truck>,
    /// Vehicles simulated last tick (metrics).
    pub vehicles: usize,
}

impl RoomPhysics {
    pub fn new(map: Arc<MapData>) -> Self {
        let mp = MapPhysics::get(&map);
        Self {
            world: mp.world(),
            map,
            mp,
            graveyard: Vec::new(),
            vehicles: 0,
        }
    }

    /// A car of wire model `model` (catalogue index + 1) standing at (x, y, z) facing `yaw`, set up as the game's
    /// defaults drive it (Simulation handling, aids Full, off-road assist on) and feeling this map's surfaces.
    pub fn new_car(&mut self, model: u8, x: f32, y: f32, z: f32, yaw: f32) -> Truck {
        let cars = dark_vehicle::cars();
        let def = &cars[(model.max(1) as usize - 1).min(cars.len() - 1)];
        let mut t = Truck::new(&mut self.world, def, None);
        t.drivetrain.aids = dark_vehicle::spec::AidLevel::Full;
        t.offroad_assist = true;
        let (map, mp) = (self.map.clone(), self.mp.clone());
        t.surface = Some(Box::new(move |x, z, out| mp.sample(&map, x, z, out)));
        t.place(&mut self.world, x as f64, y as f64, z as f64, yaw as f64, 0.0);
        t
    }

    /// Take a car out of the world (at the next physics step).
    pub fn bury(&mut self, car: Truck) {
        self.graveyard.push(car);
    }

    /// Remove the buried cars' bodies.
    pub fn sweep(&mut self) {
        for c in self.graveyard.drain(..) {
            c.dispose(&mut self.world);
        }
    }

    /// The solid ground (terrain or ice) under (x, z) — the streaming guard's floor.
    pub fn ground(&self, x: f32, z: f32) -> f32 {
        self.map.surface(x, z)
    }

    /// The solid surface under (x, z) looking down from `from_y` — a bridge deck, a set piece, the terrain — where a
    /// car is set down (`ground` alone put a car spawned on a bridge into the gorge under it).
    pub fn surface_below(&self, x: f32, z: f32, from_y: f32) -> f32 {
        use dark_vehicle::rapier3d::prelude::{QueryFilter, Ray};
        let g = self.ground(x, z);
        if from_y <= g {
            return g;
        }
        let filter = QueryFilter::new().groups(group(0xffff, groups::TERRAIN | groups::STATIC));
        let ray = Ray::new(Vector::new(x, from_y, z), Vector::new(0.0, -1.0, 0.0));
        self.world
            .pw
            .cast_ray(&ray, from_y - g + 0.5, true, filter)
            .map_or(g, |(_, t)| from_y - t)
    }
}

/// A person's server-simulated car (stage D): the server owns its state; the driver's [`Input`] frames are its
/// controls. Never a pose from the client.
///
/// FRAME CLOCK: physics step k applies frame k — the numbering the client predicted with — so the state acked for
/// frame k is comparable with the client's prediction of frame k. A frame not here in time is stood in for by the
/// last controls (it still counts as frame k; arriving late it is dropped): a jittery link costs a step of stale
/// controls, not a shift of every later frame. The clock starts BUFFER frames behind the newest frame and re-aligns
/// when the client stalls (its frames all arrive behind the clock) or a burst piles up after a network pause.
pub struct HumanCar {
    pub car: Truck,
    /// Wire model (catalogue index + 1).
    pub model: u8,
    /// Seated and driving (inputs apply); false = parked where the driver got out.
    pub driving: bool,
    /// The driver's settings (`Input.opts`).
    pub opts: u8,
    /// Frames received, not yet applied, by seq.
    queue: std::collections::BTreeMap<u32, InputFrame>,
    /// The frame the next physics step applies (0 = not aligned yet).
    next: u32,
    /// Newest frame received.
    newest: u32,
    /// The last frame applied, and its seq (acked in `VehicleState`).
    last: InputFrame,
    pub ack: u32,
    /// Steps in a row stood in for (the last controls repeat ≤ STARVE_REPEAT, then the controls go neutral).
    starved: u32,
    /// Frames that arrived after their step (stood in for) and re-alignments — metrics.
    pub late: u64,
    pub resyncs: u64,
    /// Recent frames whose step went by without them.
    stood_in: std::collections::VecDeque<u32>,
}

/// Steps a missing frame is covered by repeating the last one (0.25 s at 60 Hz).
const STARVE_REPEAT: u32 = 15;
/// The jitter buffer: the clock runs this many frames behind the newest frame received.
const BUFFER: u32 = 3;
/// Re-align when the newest frame is this far behind the clock (the client stalled) or ahead of it (a burst).
const RESYNC_BEHIND: u32 = 12;
const RESYNC_AHEAD: u32 = 20;

impl HumanCar {
    pub fn new(car: Truck, model: u8) -> Self {
        Self {
            car,
            model,
            driving: true,
            opts: 2 | drive_opts::OFFROAD,
            queue: Default::default(),
            next: 0,
            newest: 0,
            last: InputFrame::default(),
            ack: 0,
            starved: 0,
            late: 0,
            resyncs: 0,
            stood_in: Default::default(),
        }
    }

    /// Take an input packet's frames (the redundant copies of frames already here or past are ignored).
    pub fn push(&mut self, input: &Input) {
        self.opts = input.opts;
        let n = input.frames.len() as i64;
        for (k, f) in input.frames.iter().enumerate() {
            // (frames are numbered from 1; a first packet's redundant copies can reach below that)
            let seq = input.seq as i64 - (n - 1 - k as i64);
            if seq < 1 || seq > u32::MAX as i64 {
                continue;
            }
            let seq = seq as u32;
            self.newest = self.newest.max(seq);
            if self.next != 0 && seq < self.next {
                if let Some(i) = self.stood_in.iter().position(|&s| s == seq) {
                    self.stood_in.remove(i);
                    self.late += 1; // (its step went by on the last controls)
                }
                continue;
            }
            self.queue.entry(seq).or_insert(*f);
        }
        // align / re-align the clock to the stream
        if self.next == 0 && self.newest != 0 {
            self.next = self.newest.saturating_sub(BUFFER - 1).max(1);
        } else if self.newest + RESYNC_BEHIND < self.next || self.newest > self.next + RESYNC_AHEAD {
            self.next = self.newest.saturating_sub(BUFFER - 1).max(1);
            self.resyncs += 1;
        }
        self.queue.retain(|&s, _| s >= self.next);
        while self.queue.len() > 64 {
            self.queue.pop_first();
        }
    }

    /// The controls for the next physics step (frame `next`; parked when nobody is in it).
    pub fn next_controls(&mut self) -> Controls {
        if !self.driving {
            let rolling = self.car.speed.abs() > 1.5;
            return Controls {
                throttle: if rolling { -1.0 } else { 0.0 },
                parked: !rolling,
                ..Default::default()
            };
        }
        if self.next == 0 {
            return Controls::default(); // (nothing received yet)
        }
        let f = match self.queue.remove(&self.next) {
            Some(f) => {
                self.starved = 0;
                self.last = f;
                f
            }
            None => {
                self.starved += 1;
                if self.stood_in.len() >= 32 {
                    self.stood_in.pop_front();
                }
                self.stood_in.push_back(self.next);
                if self.starved <= STARVE_REPEAT {
                    // (one-shot buttons don't repeat)
                    InputFrame {
                        buttons: self.last.buttons & 0x0f,
                        ..self.last
                    }
                } else {
                    InputFrame::default()
                }
            }
        };
        self.ack = self.next;
        self.next += 1;
        let d = &mut self.car.drivetrain;
        d.aids = match self.opts & drive_opts::AIDS_MASK {
            0 => AidLevel::Off,
            1 => AidLevel::Std,
            _ => AidLevel::Full,
        };
        d.manual = self.opts & drive_opts::MANUAL != 0 && d.stepped();
        self.car.offroad_assist = self.opts & drive_opts::OFFROAD != 0;
        if f.buttons & buttons::SHIFT_UP != 0 && d.manual {
            d.shift_up();
        }
        if f.buttons & buttons::SHIFT_DOWN != 0 && d.manual {
            d.shift_down();
        }
        if f.buttons & buttons::LOW_RANGE != 0 {
            let v = self.car.speed;
            self.car.drivetrain.toggle_low(v);
        }
        if f.buttons & buttons::LOCKERS != 0 {
            self.car.drivetrain.cycle_lockers();
        }
        Controls {
            parked: false,
            neutral: false,
            throttle: (f.throttle as f64 / 127.0).clamp(-1.0, 1.0),
            steer: (f.steer as f64 / 127.0).clamp(-1.0, 1.0),
            handbrake: f.buttons & buttons::HANDBRAKE != 0,
            boost: f.buttons & buttons::BOOST != 0,
            brake: f.buttons & buttons::BRAKE != 0,
            foot_brake: f.foot_brake as f64 / 255.0,
            lift: (f.lift as f64 / 127.0).clamp(-1.0, 1.0),
        }
    }

    /// The wire state for the driver (after this tick's physics).
    pub fn state(&self, world: &World, tick: u32, server_time: u32) -> VehicleState {
        let b = &world.pw.bodies[self.car.body];
        let (t, q, v, w) = (b.translation(), b.rotation(), b.linvel(), b.angvel());
        let qi = |x: f32| (x * 32767.0).round().clamp(-32767.0, 32767.0) as i16;
        let mr = |x: f32| (x * 1000.0).round().clamp(-32768.0, 32767.0) as i16;
        let d = &self.car.drivetrain;
        VehicleState {
            tick,
            server_time,
            ack: self.ack,
            pos: [m_to_cm(t.x), m_to_cm(t.y), m_to_cm(t.z)],
            rot: [qi(q.x), qi(q.y), qi(q.z), qi(q.w)],
            vel: [mps_to_cms(v.x), mps_to_cms(v.y), mps_to_cms(v.z)],
            angvel: [mr(w.x), mr(w.y), mr(w.z)],
            gear: d.gear.clamp(-128, 127) as i8,
            engine: (d.we * 10.0).round().clamp(0.0, 65535.0) as u16,
            omega: std::array::from_fn(|i| {
                (d.omega.get(i).copied().unwrap_or(0.0) * 10.0)
                    .round()
                    .clamp(-32768.0, 32767.0) as i16
            }),
        }
    }
}

/// Follows a road polyline: the nearest point near the last one, a look-ahead target, a bend speed.
#[derive(Clone, Debug)]
pub struct RoadFollower {
    pts: Vec<[f32; 3]>,
    closed: bool,
    /// Index of the nearest sample last step; direction along the line (+1 / −1).
    pub at: usize,
    pub dir: i32,
}

impl RoadFollower {
    pub fn new(pts: Vec<[f32; 3]>, closed: bool, at: usize, dir: i32) -> Self {
        Self { pts, closed, at, dir }
    }

    fn idx(&self, i: i64) -> Option<usize> {
        let n = self.pts.len() as i64;
        if self.closed {
            Some(i.rem_euclid(n) as usize)
        } else if (0..n).contains(&i) {
            Some(i as usize)
        } else {
            None
        }
    }

    /// Advance to the car at (x, z); the target point `ahead` m on and the bend-limited speed (≤ `cruise`).
    /// None: the end of an open road (the caller turns round or picks another).
    pub fn update(&mut self, x: f64, z: f64, ahead: f64, cruise: f64) -> Option<([f64; 2], f64)> {
        let mut best = (f64::INFINITY, self.at);
        for k in -6i64..=12 {
            if let Some(i) = self.idx(self.at as i64 + k * self.dir as i64) {
                let p = self.pts[i];
                let d = (p[0] as f64 - x).hypot(p[2] as f64 - z);
                if d < best.0 {
                    best = (d, i);
                }
            }
        }
        self.at = best.1;
        // walk `ahead` m along the line
        let (mut i, mut left) = (self.at as i64, ahead);
        let mut target = None;
        while left > 0.0 {
            let (a, b) = (self.idx(i)?, self.idx(i + self.dir as i64)?);
            let (pa, pb) = (self.pts[a], self.pts[b]);
            let seg = (pb[0] as f64 - pa[0] as f64).hypot(pb[2] as f64 - pa[2] as f64);
            if seg >= left {
                let t = left / seg.max(1e-6);
                target = Some([
                    pa[0] as f64 + (pb[0] - pa[0]) as f64 * t,
                    pa[2] as f64 + (pb[2] - pa[2]) as f64 * t,
                ]);
                break;
            }
            left -= seg;
            i += self.dir as i64;
        }
        // bend speed: the sharpest turn in the next ~40 m at ≤ 3.5 m/s² sideways
        let mut v = cruise;
        let heading = |i: i64| -> Option<f64> {
            let (a, b) = (self.idx(i)?, self.idx(i + self.dir as i64)?);
            Some((self.pts[b][0] - self.pts[a][0]).atan2(self.pts[b][2] - self.pts[a][2]) as f64)
        };
        for k in 1..8i64 {
            let i = self.at as i64 + k * self.dir as i64;
            if let (Some(h0), Some(h1)) = (heading(i - self.dir as i64), heading(i + self.dir as i64)) {
                let mut da = h1 - h0;
                da = da.sin().atan2(da.cos());
                if da.abs() > 1e-3 {
                    v = v.min((3.5 * (10.0 / da.abs())).sqrt().max(4.0));
                }
            }
        }
        target.map(|t| (t, v))
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use dark_vehicle::Truck;
    use dark_vehicle::control::{Intent, drive};
    use dark_vehicle::spec::CarDef;
    use std::path::Path;
    use std::time::Instant;

    fn pickup() -> CarDef {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../vehicle/golden/drive-pickup.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        serde_json::from_value(v["def"].clone()).unwrap()
    }

    struct Bot {
        car: Truck,
        road: RoadFollower,
    }

    /// `n` cars on the island's roads: spread over every road (`spread`) or nose to tail on a few (`packed`: lots
    /// of contacts). Returns (µs per physics step: cars, world; per car; mean speed; upright share).
    fn run(map: &MapData, n: usize, packed: bool, secs: f64) -> (f64, f64, f64, f64, f64) {
        let mut world = MapPhysics::get(map).world();
        // BOXES=1: the golden traces' pickup (frame boxes); else the game's exported car (convex body hulls)
        let def = if std::env::var("BOXES").is_ok() {
            pickup()
        } else {
            dark_vehicle::cars()[0].clone()
        };
        let roads: Vec<_> = map.roads.iter().filter(|r| r.pts.len() > 40).collect();
        let mut bots: Vec<Bot> = (0..n)
            .map(|k| {
                let (r, at, dir) = if packed {
                    // 4 roads, nose to tail every ~12 m (road samples are ~4 m apart), alternating directions
                    let r = roads[k % 4];
                    (r, 10 + (k / 4) * 3, if k % 8 < 4 { 1 } else { -1 })
                } else {
                    let r = roads[k % roads.len()];
                    let slot = k / roads.len();
                    (
                        r,
                        (r.pts.len() / 7 * (slot + 1)) % r.pts.len(),
                        if k % 2 == 0 { 1 } else { -1 },
                    )
                };
                let at = at.min(r.pts.len() - 2);
                let p = r.pts[at];
                let q = r.pts[if dir > 0 { at + 1 } else { at.saturating_sub(1) }];
                let heading = (-(q[0] - p[0]) as f64).atan2(-(q[2] - p[2]) as f64);
                let mut car = Truck::new(&mut world, &def, None);
                let y = map.height(p[0], p[2]) as f64;
                car.place(&mut world, p[0] as f64, y + 0.1, p[2] as f64, heading, 0.0);
                Bot {
                    car,
                    road: RoadFollower::new(r.pts.clone(), r.closed, at, dir),
                }
            })
            .collect();
        let steps = (secs * 60.0) as usize;
        let (mut t_cars, mut t_world) = (0.0, 0.0);
        let mut vsum = 0.0;
        for s in 0..steps {
            let t0 = Instant::now();
            for b in bots.iter_mut() {
                let p = b.car.position(&world);
                let v = b.car.speed;
                let intent = match b.road.update(p[0], p[2], 4.0 + v.abs() * 0.6, 15.0) {
                    Some((target, speed)) => Intent {
                        target,
                        speed,
                        boost: false,
                    },
                    None => {
                        b.road.dir = -b.road.dir;
                        Intent {
                            target: [p[0], p[2]],
                            speed: 0.0,
                            boost: false,
                        }
                    }
                };
                let heading = b.car.heading(&world);
                b.car.controls = drive(&intent, p[0], p[2], heading, v);
                b.car.step(&mut world, 1.0 / 60.0);
            }
            let t1 = Instant::now();
            world.step();
            let t2 = Instant::now();
            if s >= 60 {
                t_cars += (t1 - t0).as_secs_f64();
                t_world += (t2 - t1).as_secs_f64();
            }
            if s + 1 == steps {
                vsum = bots.iter().map(|b| b.car.speed).sum::<f64>();
            }
        }
        let m = (steps - 60) as f64;
        let upright = bots.iter().filter(|b| b.car.axes(&world).u[1] > 0.7).count() as f64 / n as f64;
        let (c, w) = (t_cars / m * 1e6, t_world / m * 1e6);
        (c, w, (c + w) / n as f64, vsum / n as f64, upright)
    }

    /// Profiling target: `PROFILE_SECS=60 cargo test --release -p dark-sim profile_cars -- --ignored` (+ `sample`).
    #[test]
    #[ignore]
    fn profile_cars() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        let map = MapData::load(&dir).unwrap();
        let secs = std::env::var("PROFILE_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60.0);
        let r = run(&map, 10, false, secs);
        println!("{r:?}");
    }

    /// `cargo test --release -p dark-sim bench_vehicle_physics -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_vehicle_physics() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        if !dir.exists() {
            return;
        }
        let map = MapData::load(&dir).unwrap();
        println!("island, 60 Hz physics, the game's pickup (drivetrain mode, tyre envelope), 10 s per case:");
        for (n, packed) in [(1, false), (10, false), (100, false), (100, true)] {
            let (c, w, per, v, up) = run(&map, n, packed, 10.0);
            println!(
                "  {n:>3} cars {:<7}: cars {c:>7.0} µs + world {w:>7.0} µs = {:>7.0} µs per step ({:.2} ms per 30 Hz tick, {:.0} % of 33 ms) · {per:.1} µs per car · mean speed {v:.1} m/s · upright {:.0} %",
                if packed { "packed" } else { "spread" },
                c + w,
                2.0 * (c + w) / 1000.0,
                2.0 * (c + w) / 1000.0 / 33.3 * 100.0,
                up * 100.0
            );
        }
    }
}

#[cfg(test)]
mod rooms {
    use crate::game::{Match, MatchConfig, Mode};
    use crate::map::MapData;
    use crate::nav::Nav;
    use dark_protocol::*;
    use std::path::Path;
    use std::sync::Arc;

    /// What a room's bots did over a run (driving bots only for speed / road / ground).
    #[derive(Debug, Default)]
    struct Report {
        ticks: usize,
        vehicles: usize,
        driving_samples: usize,
        mean_speed: f64,
        on_road: f64,
        below_ground: f32,
        above_ground: f32,
        respawns: u64,
        moved: f64,
        tick_us: f64,
        worst_tick_us: f64,
        /// Where the highest driving car was (x, y, z, ground) and where bots were respawned from (x, y, z).
        above_at: [f32; 4],
        jumps: Vec<[f32; 3]>,
    }

    fn island() -> Option<Arc<MapData>> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        dir.exists().then(|| Arc::new(MapData::load(&dir).unwrap()))
    }

    /// A room on the island with one person standing at the map's start and `bots` bots, run for `secs`.
    fn run(map: &Arc<MapData>, bots: u8, secs: f32) -> Report {
        let room = RoomSettings {
            code: "PHYS01".into(),
            name: "p".into(),
            flags: 0,
            max_players: 100,
            owner: 1,
            bots,
        };
        let cfg = MatchConfig {
            mode: Mode::FreeRoam,
            max_players: 100,
            ..Default::default()
        };
        let mut m = Match::new(9, 7, Some(map.clone()), cfg, Some(room), 0);
        m.join(1, "human").unwrap();
        let nav = Nav::get(map);
        let (lx, lz) = (map.lobby[0], map.lobby[1]);
        let mut snaps = Vec::new();
        let mut r = Report::default();
        let mut start: std::collections::HashMap<u16, [f32; 3]> = Default::default();
        let mut last: std::collections::HashMap<u16, [f32; 3]> = Default::default();
        let mut prev: std::collections::HashMap<u16, [f32; 3]> = Default::default();
        let ticks = (secs * 30.0) as usize;
        let (mut sum_us, mut speed_sum, mut on_road) = (0.0, 0.0, 0usize);
        r.below_ground = f32::NEG_INFINITY;
        r.above_ground = f32::NEG_INFINITY;
        for t in 0..ticks {
            let now = (t as u64 + 1) * 33;
            let y = map.height(lx, lz);
            let s = State {
                seq: t as u32 + 1,
                client_time: 0,
                epoch: 0,
                flags: 0,
                model: 0,
                pos: [m_to_cm(lx), m_to_cm(y), m_to_cm(lz)],
                yaw: 0,
                pitch: 0,
                vel: [0, 0, 0],
            };
            m.on_state(1, &s);
            let t0 = std::time::Instant::now();
            m.step(now);
            let us = t0.elapsed().as_secs_f64() * 1e6;
            m.snapshots(&mut snaps);
            m.drain().for_each(drop);
            // (a car stepped before Rapier had its mass once went NaN on its first step: never again)
            assert_eq!(m.first_bad_bot(), None, "a car's state is not finite at tick {t}");
            if t < 90 {
                continue; // (the bots arrive 4 per tick and settle)
            }
            sum_us += us;
            r.worst_tick_us = r.worst_tick_us.max(us);
            r.vehicles = r.vehicles.max(m.physics_vehicles());
            for p in m.players() {
                if p.id < BOT_ID_BASE {
                    continue;
                }
                let pose = m.pose_of(p.id).expect("a bot");
                start.entry(p.id).or_insert(p.pos);
                if let Some(l) = last.insert(p.id, p.pos) {
                    prev.insert(p.id, l);
                }
                if pose.flags & flags::DRIVING == 0 || pose.flags & (flags::BOAT | flags::FLYING) != 0 {
                    continue;
                }
                r.driving_samples += 1;
                speed_sum += (pose.vel[0].powi(2) + pose.vel[2].powi(2)).sqrt() as f64;
                let ground = map.surface(p.pos[0], p.pos[2]);
                r.below_ground = r.below_ground.max(ground - p.pos[1]);
                if p.pos[1] - ground > r.above_ground {
                    r.above_ground = p.pos[1] - ground;
                    r.above_at = [p.pos[0], p.pos[1], p.pos[2], ground];
                }
                if let Some(q) = prev.get(&p.id)
                    && ((q[0] - p.pos[0]).powi(2) + (q[2] - p.pos[2]).powi(2)).sqrt() > 30.0
                {
                    r.jumps.push([q[0], q[1], q[2]]);
                }
                if nav.nearest(p.pos[0], p.pos[2], 9.0).is_some() {
                    on_road += 1;
                }
            }
        }
        r.ticks = ticks;
        r.tick_us = sum_us / (ticks - 90) as f64;
        r.mean_speed = speed_sum / r.driving_samples.max(1) as f64;
        r.on_road = on_road as f64 / r.driving_samples.max(1) as f64;
        r.respawns = m.bot_stats().map_or(0, |s| s.respawns);
        r.moved = start
            .iter()
            .map(|(id, a)| {
                let b = last[id];
                (((a[0] - b[0]).powi(2) + (a[2] - b[2]).powi(2)) as f64).sqrt()
            })
            .sum::<f64>()
            / start.len().max(1) as f64;
        r
    }

    /// Stage C acceptance (CI size): bots drive the physical car along the roads — moving, on the roads, on the ground.
    #[test]
    fn bots_drive_physical_cars_on_the_island() {
        let Some(map) = island() else { return };
        let r = run(&map, 20, 40.0);
        println!("{r:#?}");
        assert!(r.vehicles >= 15, "only {} cars in the physics", r.vehicles);
        assert!(r.mean_speed > 4.0, "bots barely move ({:.1} m/s)", r.mean_speed);
        assert!(r.moved > 40.0, "bots got nowhere ({:.0} m on average)", r.moved);
        assert!(
            r.on_road > 0.75,
            "only {:.0} % of driving bots on a road",
            r.on_road * 100.0
        );
        assert!(
            r.below_ground < 0.6,
            "a car sank {:.2} m into the ground",
            r.below_ground
        );
        assert!(r.respawns <= 10, "{} respawns (stuck cars)", r.respawns);
    }

    /// The 100-bot room: `cargo test --release -p dark-sim bench_physics_room -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_physics_room() {
        let Some(map) = island() else { return };
        let r = run(&map, 100, 90.0);
        println!("{r:#?}");
        println!(
            "100 bots, physics: {:.0} µs per tick (worst {:.0} µs), {:.1} % of the 33 ms tick",
            r.tick_us,
            r.worst_tick_us,
            r.tick_us / 333.3
        );
    }
}

#[cfg(test)]
mod human_cars {
    use super::*;
    use crate::game::{Match, MatchConfig, Mode};
    use dark_protocol::*;
    use dark_vehicle::control::{Intent, drive};
    use std::path::Path;

    fn island() -> Option<Arc<MapData>> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        dir.exists().then(|| Arc::new(MapData::load(&dir).unwrap()))
    }

    /// A room on the island (no bots) with player 1 standing on a road, its spawn (x, y, z, yaw).
    fn room(map: &Arc<MapData>) -> (Match, [f32; 4]) {
        let r = map.roads.iter().max_by_key(|r| r.pts.len()).unwrap();
        room_at(map, r.pts[20], r.pts[21])
    }

    /// The same, the player on the road at `a` facing `b`.
    fn room_at(map: &Arc<MapData>, a: [f32; 3], b: [f32; 3]) -> (Match, [f32; 4]) {
        let room = RoomSettings {
            code: "DRIVE1".into(),
            name: "d".into(),
            flags: 0,
            max_players: 8,
            owner: 1,
            bots: 0,
        };
        let cfg = MatchConfig {
            mode: Mode::FreeRoam,
            ..Default::default()
        };
        let mut m = Match::new(3, 7, Some(map.clone()), cfg, Some(room), 0);
        m.join(1, "driver").unwrap();
        let yaw = (-(b[0] - a[0])).atan2(-(b[2] - a[2]));
        let at = [a[0], map.height(a[0], a[2]), a[2], yaw];
        // (from the room's start to the road: one move the server allows, like the game's respawn "R")
        m.on_state(
            1,
            &state(
                1,
                [map.lobby[0], map.height(map.lobby[0], map.lobby[1]), map.lobby[1], 0.0],
                0,
            ),
        );
        m.step(33);
        m.on_action(1, ActionKind::RespawnVehicle, 0);
        m.on_state(1, &state(2, at, 0));
        m.step(66);
        let p = m.pose_of(1).unwrap().pos;
        assert!(
            (p[0] - at[0]).abs() < 0.1 && (p[2] - at[2]).abs() < 0.1,
            "the player is not at the road: {p:?}"
        );
        (m, at)
    }

    fn state(seq: u32, at: [f32; 4], model: u8) -> State {
        State {
            seq,
            client_time: 0,
            epoch: 0,
            flags: if model > 0 { flags::DRIVING } else { 0 },
            model,
            pos: [m_to_cm(at[0]), m_to_cm(at[1]), m_to_cm(at[2])],
            yaw: yaw_to_u16(at[3]),
            pitch: 0,
            vel: [0, 0, 0],
        }
    }

    fn enter(m: &mut Match, at: [f32; 4]) {
        m.on_vehicle(
            1,
            &VehicleMsg {
                enter: true,
                model: 1,
                pos: [m_to_cm(at[0]), m_to_cm(at[1]), m_to_cm(at[2])],
                yaw: yaw_to_u16(at[3]),
            },
        );
    }

    /// Ticks at 30 Hz sending two 60 Hz frames per tick (with the previous two again: redundancy); returns the last
    /// VehicleState.
    fn drive_for(m: &mut Match, secs: f32, seq: &mut u32, frame: InputFrame) -> Option<VehicleState> {
        let mut last = None;
        let mut out = Vec::new();
        let mut now = 33 * 2;
        for _ in 0..(secs * 30.0) as usize {
            *seq += 2;
            let frames = vec![frame; 4];
            m.on_input(
                1,
                &Input {
                    seq: *seq,
                    opts: 2 | drive_opts::OFFROAD,
                    frames,
                },
            );
            now += 33;
            m.step(now);
            m.drain().for_each(drop);
            out.clear();
            m.vehicle_states(&mut out);
            for (id, b) in out.drain(..) {
                assert_eq!(id, 1);
                if let Ok(ServerMsg::Vehicle(v)) = ServerMsg::decode(&b) {
                    last = Some(v);
                }
            }
        }
        last
    }

    fn gas() -> InputFrame {
        InputFrame {
            throttle: 127,
            ..Default::default()
        }
    }

    #[test]
    fn a_drivers_inputs_move_their_server_car() {
        let Some(map) = island() else { return };
        let (mut m, at) = room(&map);
        enter(&mut m, at);
        let mut seq = 0;
        let v = drive_for(&mut m, 5.0, &mut seq, gas()).expect("vehicle states for the driver");
        let p = m.pose_of(1).unwrap();
        let moved = ((p.pos[0] - at[0]).powi(2) + (p.pos[2] - at[2]).powi(2)).sqrt();
        println!(
            "5 s full throttle: moved {moved:.1} m, ack {} of {seq}, speed {:.1} m/s",
            v.ack,
            (p.vel[0].powi(2) + p.vel[2].powi(2)).sqrt()
        );
        assert!(moved > 25.0, "the car barely moved ({moved:.1} m)");
        assert!(p.flags & flags::DRIVING != 0 && p.model == 1);
        // every frame applied once, in order: the ack trails the newest frame by at most the jitter buffer
        assert!(v.ack + 8 >= seq && v.ack <= seq, "ack {} vs sent {seq}", v.ack);
        let car = [cm_to_m(v.pos[0]), cm_to_m(v.pos[1]), cm_to_m(v.pos[2])];
        // (the snapshot pose is carried ≤ one physics step along the velocity to the tick's time; the vehicle state is
        // the car at its last step — what the driver reconciles with)
        let step = (p.vel[0].powi(2) + p.vel[2].powi(2)).sqrt() / 60.0 + 0.02;
        assert!(
            (car[0] - p.pos[0]).abs() < step && (car[2] - p.pos[2]).abs() < step,
            "pose and vehicle state agree"
        );
    }

    #[test]
    fn duplicate_and_old_inputs_apply_once() {
        let Some(map) = island() else { return };
        let (mut m, at) = room(&map);
        enter(&mut m, at);
        let mut seq = 0;
        drive_for(&mut m, 1.0, &mut seq, gas());
        let before = m.pose_of(1).unwrap().pos;
        // the same packet five times, and an old one: nothing new to apply → the car rolls on its last frame only
        let pkt = Input {
            seq,
            opts: 2,
            frames: vec![gas(); 8],
        };
        for _ in 0..5 {
            m.on_input(1, &pkt);
        }
        m.on_input(
            1,
            &Input {
                seq: seq - 20,
                opts: 2,
                frames: vec![
                    InputFrame {
                        throttle: -127,
                        ..Default::default()
                    };
                    8
                ],
            },
        );
        let mut out = Vec::new();
        m.step(10_000);
        m.vehicle_states(&mut out);
        let v = match ServerMsg::decode(&out[0].1) {
            Ok(ServerMsg::Vehicle(v)) => v,
            other => panic!("{other:?}"),
        };
        // (the frame clock runs on: this tick's ≤ 8 physics steps stood in for frames not sent — never re-applied)
        assert!(
            v.ack <= seq + 8,
            "ack {} beyond the newest frame {seq} + this tick's steps",
            v.ack
        );
        let after = m.pose_of(1).unwrap().pos;
        let d = ((after[0] - before[0]).powi(2) + (after[2] - before[2]).powi(2)).sqrt();
        assert!(d < 3.0, "replayed packets moved the car {d:.1} m in one tick");
    }

    #[test]
    fn a_client_cannot_place_its_car() {
        let Some(map) = island() else { return };
        let (mut m, at) = room(&map);
        enter(&mut m, at);
        let mut seq = 0;
        drive_for(&mut m, 1.0, &mut seq, InputFrame::default());
        // poses 200 m away while driving: ignored
        let far = [at[0] + 200.0, at[1], at[2], at[3]];
        for k in 0..30 {
            m.on_state(1, &state(1000 + k, far, 1));
        }
        drive_for(&mut m, 0.5, &mut seq, InputFrame::default());
        let p = m.pose_of(1).unwrap();
        assert!(
            (p.pos[0] - at[0]).abs() < 5.0,
            "a client pose moved the server car to x {}",
            p.pos[0]
        );
        // getting in "200 m away": the car appears where the server has the player instead
        m.on_vehicle(
            1,
            &VehicleMsg {
                enter: false,
                model: 1,
                pos: [0; 3],
                yaw: 0,
            },
        );
        m.on_vehicle(
            1,
            &VehicleMsg {
                enter: true,
                model: 2,
                pos: [m_to_cm(far[0]), m_to_cm(far[1]), m_to_cm(far[2])],
                yaw: 0,
            },
        );
        drive_for(&mut m, 0.3, &mut seq, InputFrame::default());
        let p = m.pose_of(1).unwrap();
        assert!(
            (p.pos[0] - at[0]).abs() < 8.0,
            "the car was created where the client said: x {}",
            p.pos[0]
        );
        assert_eq!(p.model, 2);
    }

    #[test]
    fn without_inputs_the_car_coasts_to_a_stop() {
        let Some(map) = island() else { return };
        let (mut m, at) = room(&map);
        enter(&mut m, at);
        let mut seq = 0;
        drive_for(&mut m, 3.0, &mut seq, gas());
        let v0 = m.pose_of(1).unwrap().vel;
        // the client goes silent for 6 s
        let mut now = 100_000;
        for _ in 0..180 {
            now += 33;
            m.step(now);
            m.drain().for_each(drop);
        }
        let v1 = m.pose_of(1).unwrap().vel;
        let (s0, s1) = (
            (v0[0].powi(2) + v0[2].powi(2)).sqrt(),
            (v1[0].powi(2) + v1[2].powi(2)).sqrt(),
        );
        println!("silent client: {s0:.1} → {s1:.1} m/s");
        assert!(
            s1 < s0 * 0.5,
            "a car without inputs kept its gas on ({s0:.1} → {s1:.1} m/s)"
        );
        let _ = at;
    }

    #[test]
    fn leaving_takes_the_car_out() {
        let Some(map) = island() else { return };
        let (mut m, at) = room(&map);
        enter(&mut m, at);
        let mut seq = 0;
        drive_for(&mut m, 0.5, &mut seq, gas());
        assert_eq!(m.physics_vehicles(), 1);
        m.leave(1);
        m.step(200_000);
        assert_eq!(m.physics_vehicles(), 0, "the car stayed after its driver left");
    }

    /// A bot-driven car and a person's car in the same room world: the bot runs into the parked human car and pushes it.
    #[test]
    fn a_bot_car_hits_a_human_car() {
        let Some(map) = island() else { return };
        let mut ph = RoomPhysics::new(map.clone());
        let r = map.roads.iter().max_by_key(|r| r.pts.len()).unwrap();
        let (a, b) = (r.pts[30], r.pts[31]);
        let yaw = (-(b[0] - a[0])).atan2(-(b[2] - a[2]));
        let mut human = HumanCar::new(ph.new_car(1, a[0], map.height(a[0], a[2]), a[2], yaw), 1);
        human.driving = false; // parked
        let (fx, fz) = (-yaw.sin(), -yaw.cos());
        let (bx, bz) = (a[0] - fx * 40.0, a[2] - fz * 40.0);
        let mut bot = ph.new_car(2, bx, map.height(bx, bz), bz, yaw);
        let h0 = human.car.position(&ph.world);
        let mut pushed = 0.0f64;
        for _ in 0..(8 * 60) {
            human.car.controls = human.next_controls();
            human.car.step(&mut ph.world, 1.0 / 60.0);
            let p = bot.position(&ph.world);
            let target = human.car.position(&ph.world);
            bot.controls = drive(
                &Intent {
                    target: [target[0], target[2]],
                    speed: 12.0,
                    boost: false,
                },
                p[0],
                p[2],
                bot.heading(&ph.world),
                bot.speed,
            );
            bot.step(&mut ph.world, 1.0 / 60.0);
            ph.world.step();
            let h = human.car.position(&ph.world);
            pushed = pushed.max(((h[0] - h0[0]).powi(2) + (h[2] - h0[2]).powi(2)).sqrt());
        }
        println!("bot rammed the parked human car: it moved {pushed:.1} m");
        assert!(
            pushed > 1.0,
            "the human car was not pushed ({pushed:.2} m) — no contact?"
        );
    }

    /// TOW ROPES on the server: out of the car, take its front hook, tie it to a trunk, back in, hold the winch —
    /// the server pulls the car toward the tree; the room hears about every step (Ropes).
    #[test]
    fn a_winch_on_a_tree_pulls_the_server_car() {
        use crate::tow::hook_pts;
        let Some(map) = island() else { return };
        let Some(st) = map.statics.as_ref() else { return };
        // a road spot with a trunk 8–14 m off it
        let trunks: Vec<[f32; 2]> = st
            .items
            .iter()
            .filter(|i| i.shape.as_cylinder().is_some() && !i.breakable)
            .map(|i| [i.at.x, i.at.z])
            .collect();
        let (a, b) = map
            .roads
            .iter()
            .flat_map(|r| r.pts.windows(2).step_by(7).map(|w| (w[0], w[1])))
            .find(|(a, _)| {
                trunks
                    .iter()
                    .any(|t| (8.0..14.0).contains(&(t[0] - a[0]).hypot(t[1] - a[2])))
            })
            .expect("a road by the trees");
        let (mut m, at) = room_at(&map, a, b);
        enter(&mut m, at);
        let now = std::cell::Cell::new(66u64);
        let tick = |m: &mut Match, n: usize, ropes: &mut Vec<Vec<Rope>>| {
            for _ in 0..n {
                now.set(now.get() + 33);
                m.step(now.get());
                for o in m.drain() {
                    if let crate::game::Out::All(ServerMsg::Ropes(r)) = o {
                        ropes.push(r);
                    }
                }
            }
        };
        let mut heard = Vec::new();
        tick(&mut m, 30, &mut heard);
        let car = m.pose_of(1).unwrap();
        m.on_vehicle(
            1,
            &VehicleMsg {
                enter: false,
                model: 1,
                pos: [0; 3],
                yaw: 0,
            },
        );
        // the front hook, world (the car stands where its driver's pose is)
        let (eye, _) = hook_pts(1, tow_end::FRONT).unwrap();
        let (s, c) = car.yaw.sin_cos();
        let (fx, fz) = (-s, -c); // forward
        let hook = [car.pos[0] + fx * (-eye[2] as f32), car.pos[2] + fz * (-eye[2] as f32)];
        // walk there, 25 cm a tick (the server checks the pace)
        let mut seq = 100u32;
        let mut pos = [car.pos[0] - fz * 1.6, car.pos[2] + fx * 1.6]; // (out beside the door)
        let mut walk = |m: &mut Match, to: [f32; 2], heard: &mut Vec<Vec<Rope>>| {
            loop {
                let (dx, dz) = (to[0] - pos[0], to[1] - pos[1]);
                let d = dx.hypot(dz);
                let k = (0.25 / d.max(1e-3)).min(1.0);
                pos = [pos[0] + dx * k, pos[1] + dz * k];
                seq += 1;
                m.on_state(1, &state(seq, [pos[0], map.height(pos[0], pos[1]), pos[1], 0.0], 0));
                tick(m, 1, heard);
                if d < 0.3 {
                    break;
                }
            }
        };
        walk(&mut m, [hook[0] + fx * 0.6, hook[1] + fz * 0.6], &mut heard);
        m.on_tow(
            1,
            &TowMsg {
                op: tow_op::TAKE,
                car: 1,
                end: tow_end::FRONT,
                ..Default::default()
            },
        );
        tick(&mut m, 2, &mut heard);
        assert!(
            heard
                .last()
                .is_some_and(|r| r.len() == 1 && r[0].kind == rope_kind::HAND && r[0].who == 1),
            "took the hook: {heard:?}"
        );
        // the nearest trunk 5–21 m from the hook (the line is 25 m)
        let tree = st
            .items
            .iter()
            .filter(|i| i.shape.as_cylinder().is_some() && !i.breakable)
            .map(|i| (i, (i.at.x - hook[0]).hypot(i.at.z - hook[1])))
            .filter(|(_, d)| (5.0..21.0).contains(d))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .expect("a tree near the road")
            .0;
        let r = tree.shape.as_cylinder().unwrap().radius;
        let (dx, dz) = (hook[0] - tree.at.x, hook[1] - tree.at.z);
        let dl = dx.hypot(dz);
        let stand = [tree.at.x + dx / dl * (r + 0.7), tree.at.z + dz / dl * (r + 0.7)];
        walk(&mut m, stand, &mut heard);
        let tie = [
            tree.at.x + dx / dl * r,
            map.height(stand[0], stand[1]) + 0.9,
            tree.at.z + dz / dl * r,
        ];
        m.on_tow(
            1,
            &TowMsg {
                op: tow_op::HANG_FIXED,
                car: 1,
                end: tow_end::FRONT,
                pos: [m_to_cm(tie[0]), m_to_cm(tie[1]), m_to_cm(tie[2])],
                ..Default::default()
            },
        );
        tick(&mut m, 2, &mut heard);
        let tied = heard.last().unwrap()[0];
        assert_eq!(tied.kind, rope_kind::FIXED, "tied to the tree");
        // back in, the winch held
        walk(&mut m, [car.pos[0] - fz * 1.6, car.pos[2] + fx * 1.6], &mut heard);
        enter(&mut m, [car.pos[0], car.pos[1], car.pos[2], car.yaw]);
        m.on_tow(
            1,
            &TowMsg {
                op: tow_op::WINCH,
                car: 1,
                end2: 1,
                ..Default::default()
            },
        );
        let d0 = (car.pos[0] - tree.at.x).hypot(car.pos[2] - tree.at.z);
        tick(&mut m, 30 * 8, &mut heard);
        let p = m.pose_of(1).unwrap().pos;
        let d1 = (p[0] - tree.at.x).hypot(p[2] - tree.at.z);
        let line = heard.last().unwrap()[0].len as f32 / 100.0;
        println!(
            "tree {d0:.2} → {d1:.2} m from the car, line {:.2} → {line:.2} m, {} rope updates",
            tied.len as f32 / 100.0,
            heard.len()
        );
        assert!(line < tied.len as f32 / 100.0 - 2.0, "the winch reeled the line in");
        assert!(d1 < d0 - 1.0, "the car was pulled toward the tree: {d0:.2} → {d1:.2}");
    }

    /// TOWING A CAR: player 1 sits in their car, no input; player 2 parks ahead, takes their rear hook to player 1's
    /// front hook, gets back in and drives off — player 1's car comes along.
    #[test]
    fn one_players_car_tows_anothers() {
        tow_test(false);
    }

    /// The same with player 1 OUT of their car (parked, brakes locked — player 1 hooks it on themselves, player 2
    /// tows): the taut line puts it in neutral, brakes off, and it rolls along like a towed car does.
    #[test]
    fn a_parked_car_rolls_free_when_towed() {
        tow_test(true);
    }

    fn tow_test(parked: bool) {
        use crate::tow::hook_pts;
        let Some(map) = island() else { return };
        let (mut m, at) = room(&map);
        let (s, c) = at[3].sin_cos();
        let (fx, fz) = (-s, -c);
        let ahead = |d: f32| {
            [
                at[0] + fx * d,
                map.height(at[0] + fx * d, at[2] + fz * d),
                at[2] + fz * d,
                at[3],
            ]
        };
        // player 2 into the room, onto the road 10 m ahead (one allowed move), into a G500 there
        m.join(2, "tow").unwrap();
        m.on_state(
            2,
            &State {
                seq: 1,
                ..state(
                    1,
                    [map.lobby[0], map.height(map.lobby[0], map.lobby[1]), map.lobby[1], 0.0],
                    0,
                )
            },
        );
        m.step(99);
        m.on_action(2, ActionKind::RespawnVehicle, 0);
        let b0 = ahead(10.0);
        m.on_state(
            2,
            &State {
                epoch: 1,
                ..state(2, b0, 0)
            },
        ); // (after the server's correction of the lobby pose)
        m.step(132);
        enter(&mut m, at);
        m.on_vehicle(
            2,
            &VehicleMsg {
                enter: true,
                model: 2,
                pos: [m_to_cm(b0[0]), m_to_cm(b0[1]), m_to_cm(b0[2])],
                yaw: yaw_to_u16(b0[3]),
            },
        );
        let now = std::cell::Cell::new(132u64);
        let seq = std::cell::Cell::new(10u32);
        let tick = |m: &mut Match, n: usize, gas2: bool| {
            for _ in 0..n {
                if gas2 {
                    seq.set(seq.get() + 2);
                    let frame = InputFrame {
                        throttle: 127,
                        ..Default::default()
                    };
                    m.on_input(
                        2,
                        &Input {
                            seq: seq.get(),
                            opts: 2 | drive_opts::OFFROAD,
                            frames: vec![frame; 4],
                        },
                    );
                }
                now.set(now.get() + 33);
                m.step(now.get());
                m.drain().for_each(drop);
            }
        };
        tick(&mut m, 30, false);
        let a_car = m.pose_of(1).unwrap();
        let b_car = m.pose_of(2).unwrap();
        let a_body = m.car_of(1).unwrap().0;
        let a_pos = |m: &Match| {
            let t = m.physics.as_ref().unwrap().world.pw.bodies[a_body].translation();
            [t.x, t.y, t.z]
        };
        m.on_vehicle(
            2,
            &VehicleMsg {
                enter: false,
                model: 2,
                pos: [0; 3],
                yaw: 0,
            },
        );
        // player 2 walks (25 cm a tick) round to their rear hook, then to player 1's front hook
        let mut pos = [b_car.pos[0] - fz * 1.8, b_car.pos[2] + fx * 1.8];
        let walk = |m: &mut Match, pos: &mut [f32; 2], to: [f32; 2]| loop {
            let (dx, dz) = (to[0] - pos[0], to[1] - pos[1]);
            let d = dx.hypot(dz);
            let k = (0.25 / d.max(1e-3)).min(1.0);
            *pos = [pos[0] + dx * k, pos[1] + dz * k];
            seq.set(seq.get() + 1);
            m.on_state(
                2,
                &State {
                    epoch: 1,
                    ..state(seq.get(), [pos[0], map.height(pos[0], pos[1]), pos[1], 0.0], 0)
                },
            );
            tick(m, 1, false);
            if d < 0.3 {
                break;
            }
        };
        let rear_b = hook_pts(2, tow_end::REAR).unwrap().0[2] as f32; // (+: behind)
        let front_a = -hook_pts(1, tow_end::FRONT).unwrap().0[2] as f32;
        let b_hook = [b_car.pos[0] - fx * rear_b, b_car.pos[2] - fz * rear_b];
        let a_hook = [a_car.pos[0] + fx * front_a, a_car.pos[2] + fz * front_a];
        walk(
            &mut m,
            &mut pos,
            [
                b_car.pos[0] - fz * 1.8 - fx * (rear_b + 0.5),
                b_car.pos[2] + fx * 1.8 - fz * (rear_b + 0.5),
            ],
        );
        walk(&mut m, &mut pos, [b_hook[0] - fx * 0.6, b_hook[1] - fz * 0.6]);
        m.on_tow(
            2,
            &TowMsg {
                op: tow_op::TAKE,
                car: 2,
                end: tow_end::REAR,
                ..Default::default()
            },
        );
        walk(&mut m, &mut pos, [a_hook[0] + fx * 0.6, a_hook[1] + fz * 0.6]);
        m.on_tow(
            2,
            &TowMsg {
                op: tow_op::HANG_CAR,
                car: 2,
                end: tow_end::REAR,
                car2: 1,
                end2: tow_end::FRONT,
                ..Default::default()
            },
        );
        walk(&mut m, &mut pos, [b_car.pos[0] - fz * 1.8, b_car.pos[2] + fx * 1.8]);
        m.on_vehicle(
            2,
            &VehicleMsg {
                enter: true,
                model: 2,
                pos: [m_to_cm(b_car.pos[0]), m_to_cm(b_car.pos[1]), m_to_cm(b_car.pos[2])],
                yaw: yaw_to_u16(b_car.yaw),
            },
        );
        if parked {
            // player 1 gets out and stands aside: their car is parked (brakes locked) — and stays hooked
            m.on_vehicle(
                1,
                &VehicleMsg {
                    enter: false,
                    model: 1,
                    pos: [0; 3],
                    yaw: 0,
                },
            );
            tick(&mut m, 30, false);
            assert!(m.car_of(1).is_some_and(|c| !c.2), "player 1's car parked");
        }
        let a0 = a_pos(&m);
        tick(&mut m, 30 * 6, true);
        let (a1, b1) = (a_pos(&m), m.pose_of(2).unwrap().pos);
        let moved = |p: [f32; 3], q: [f32; 3]| (q[0] - p[0]) * fx + (q[2] - p[2]) * fz;
        println!(
            "parked {parked}: towing car moved {:.1} m, towed car {:.1} m forward",
            moved(b_car.pos, b1),
            moved(a0, a1)
        );
        // (parked with its brakes locked it was dragged only ~7 m in these 6 s; rolling free in neutral it keeps up)
        let want = if parked { 20.0 } else { 3.0 };
        assert!(moved(a0, a1) > want, "player 1's car was towed: {:.2} m", moved(a0, a1));
    }

    /// CARS COLLIDE: player 2's car stands on the road 12 m ahead of player 1's; player 1 drives into it at full
    /// throttle — the cars meet (player 1 stops against it instead of passing through; the parked car is shoved).
    #[test]
    fn a_car_driven_into_another_hits_it() {
        let Some(map) = island() else { return };
        let (mut m, at) = room(&map);
        let (s, c) = at[3].sin_cos();
        let (fx, fz) = (-s, -c);
        let b0 = [
            at[0] + fx * 12.0,
            map.height(at[0] + fx * 12.0, at[2] + fz * 12.0),
            at[2] + fz * 12.0,
            at[3],
        ];
        m.join(2, "parked").unwrap();
        m.on_state(
            2,
            &State {
                seq: 1,
                ..state(
                    1,
                    [map.lobby[0], map.height(map.lobby[0], map.lobby[1]), map.lobby[1], 0.0],
                    0,
                )
            },
        );
        m.step(99);
        m.on_action(2, ActionKind::RespawnVehicle, 0);
        m.on_state(
            2,
            &State {
                epoch: 1,
                ..state(2, b0, 0)
            },
        );
        m.step(132);
        m.on_vehicle(
            2,
            &VehicleMsg {
                enter: true,
                model: 2,
                pos: [m_to_cm(b0[0]), m_to_cm(b0[1]), m_to_cm(b0[2])],
                yaw: yaw_to_u16(b0[3]),
            },
        );
        m.on_vehicle(
            2,
            &VehicleMsg {
                enter: false,
                model: 2,
                pos: [0; 3],
                yaw: 0,
            },
        );
        enter(&mut m, at);
        let b_body = m.car_of(2).unwrap().0;
        let b_pos = |m: &Match| {
            let t = m.physics.as_ref().unwrap().world.pw.bodies[b_body].translation();
            (t.x - at[0]) * fx + (t.z - at[2]) * fz
        };
        let b_start = b_pos(&m);
        let mut seq = 0;
        drive_for(&mut m, 5.0, &mut seq, gas());
        let a = m.pose_of(1).unwrap().pos;
        let a_along = (a[0] - at[0]) * fx + (a[2] - at[2]) * fz;
        let b_along = b_pos(&m);
        println!("car 1 at {a_along:.1} m, car 2 from {b_start:.1} to {b_along:.1} m");
        assert!(
            a_along < b_along,
            "car 1 drove through car 2 ({a_along:.1} vs {b_along:.1})"
        );
        // (it ran into it — a car length short — and shoved the parked car, brakes locked, along a little)
        assert!(a_along > b_start - 6.0, "car 1 reached car 2 ({a_along:.1} m)");
        assert!(
            b_along > b_start + 0.3,
            "car 2 was hit and shoved ({b_start:.1} → {b_along:.1})"
        );
    }

    /// A BOT DOESN'T RAM A STOPPED CAR: a room with one bot (rooms are deterministic by seed); a first run records where
    /// the bot drives 3 s on; a second run parks player 1's car across the road there just before it comes — the bot
    /// brakes and goes round without touching it.
    #[test]
    fn a_bot_stops_for_a_car_across_its_lane() {
        let Some(map) = island() else { return };
        let new_room = || {
            let room = RoomSettings {
                code: "BOTCAR".into(),
                name: "b".into(),
                flags: 0,
                max_players: 8,
                owner: 1,
                bots: 1,
            };
            let cfg = MatchConfig {
                mode: Mode::FreeRoam,
                ..Default::default()
            };
            let mut m = Match::new(3, 7, Some(map.clone()), cfg, Some(room), 0);
            m.join(1, "p").unwrap();
            let lobby = [map.lobby[0], map.height(map.lobby[0], map.lobby[1]), map.lobby[1], 0.0];
            m.on_state(1, &state(1, lobby, 0));
            m
        };
        let bot = BOT_ID_BASE;
        let run = |m: &mut Match, from: u64, ticks: u64| {
            for k in 1..=ticks {
                m.step(from + k * 33);
                m.drain().for_each(drop);
            }
            from + ticks * 33
        };
        // first run: the bot cruising, then where it is 3 s later
        let mut a = new_room();
        let now = run(&mut a, 0, 30 * 20);
        let p0 = a.pose_of(bot).expect("the bot");
        assert!(
            p0.flags & flags::DRIVING != 0 && hspeed(&p0) > 4.0,
            "the bot is driving ({:.1} m/s)",
            hspeed(&p0)
        );
        run(&mut a, now, 90);
        let spot = a.pose_of(bot).unwrap();
        // second run: the same room to the same moment, then a car parked across the road at that spot
        let mut b = new_room();
        let t1 = run(&mut b, 0, 30 * 20);
        assert_eq!(b.pose_of(bot).unwrap().pos, p0.pos, "rooms replay the same");
        let at = [
            spot.pos[0],
            map.height(spot.pos[0], spot.pos[2]),
            spot.pos[2],
            spot.yaw + std::f32::consts::FRAC_PI_2,
        ];
        b.on_action(1, ActionKind::RespawnVehicle, 0);
        b.on_state(1, &state(2, at, 0));
        let t2 = run(&mut b, t1, 1);
        enter(&mut b, at);
        b.on_vehicle(
            1,
            &VehicleMsg {
                enter: false,
                model: 1,
                pos: [0; 3],
                yaw: 0,
            },
        );
        let car = b.car_of(1).unwrap().0;
        let car_pos = |m: &Match| {
            let t = m.physics.as_ref().unwrap().world.pw.bodies[car].translation();
            [t.x, t.z]
        };
        let c0 = car_pos(&b);
        let mut closest = f32::INFINITY;
        let mut t = t2;
        for _ in 0..30 * 10 {
            t = run(&mut b, t, 1);
            let p = b.pose_of(bot).unwrap().pos;
            closest = closest.min((p[0] - c0[0]).hypot(p[2] - c0[1]));
        }
        let c1 = car_pos(&b);
        let shoved = (c1[0] - c0[0]).hypot(c1[1] - c0[1]);
        println!("bot came within {closest:.1} m of the parked car; the car moved {shoved:.2} m");
        assert!(closest < 25.0, "the bot came up to the car ({closest:.1} m)");
        assert!(shoved < 0.05, "the bot ran into the parked car ({shoved:.2} m)");
    }

    fn hspeed(p: &crate::validate::Pose) -> f32 {
        p.vel[0].hypot(p.vel[2])
    }

    /// THE FULL ROOM, SERVER PHYSICS: 60 players each driving their own server-simulated car (inputs, like the game)
    /// and 40 bots on the island (BENCH_DRIVERS / BENCH_BOTS to change); µs per tick, where it goes, bytes per player.
    /// `cargo test --release -p dark-sim bench_full_physics_room -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_full_physics_room() {
        let Some(map) = island() else { return };
        let env = |k: &str, d: usize| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (drivers, bots) = (env("BENCH_DRIVERS", 60), env("BENCH_BOTS", 40));
        let room = RoomSettings {
            code: "BENCH2".into(),
            name: "b".into(),
            flags: room_flags::ROADKILL,
            max_players: 100,
            owner: 1,
            bots: bots as u8,
        };
        let cfg = MatchConfig {
            mode: Mode::FreeRoam,
            max_players: 100,
            ..Default::default()
        };
        let mut m = Match::new(3, 7, Some(map.clone()), cfg, Some(room), 0);
        let t0 = std::time::Instant::now();
        m.set_clock(Box::new(move || t0.elapsed().as_nanos() as u64));
        // spawn points: every 40 m along the roads
        let mut spots = Vec::new();
        'roads: for r in &map.roads {
            let mut acc = 0.0;
            for w in r.pts.windows(2) {
                acc += (w[1][0] - w[0][0]).hypot(w[1][2] - w[0][2]);
                if acc > 40.0 {
                    acc = 0.0;
                    let yaw = (-(w[1][0] - w[0][0])).atan2(-(w[1][2] - w[0][2]));
                    spots.push([w[0][0], map.height(w[0][0], w[0][2]), w[0][2], yaw]);
                    if spots.len() == drivers {
                        break 'roads;
                    }
                }
            }
        }
        let lobby = [map.lobby[0], map.height(map.lobby[0], map.lobby[1]), map.lobby[1], 0.0];
        for id in 1..=drivers as u16 {
            m.join(id, &format!("p{id}")).unwrap();
            m.on_state(id, &state(1, lobby, 0));
        }
        m.step(33);
        for (i, at) in spots.iter().enumerate() {
            let id = i as u16 + 1;
            m.on_action(id, ActionKind::RespawnVehicle, 0);
            m.on_state(id, &state(2, *at, 0));
        }
        m.step(66);
        for (i, at) in spots.iter().enumerate() {
            m.on_vehicle(
                i as u16 + 1,
                &VehicleMsg {
                    enter: true,
                    model: 1 + (i % 3) as u8,
                    pos: [m_to_cm(at[0]), m_to_cm(at[1]), m_to_cm(at[2])],
                    yaw: yaw_to_u16(at[3]),
                },
            );
        }
        let (mut now, mut seq) = (66u64, 0u32);
        let (mut step_t, mut snap_t, mut bytes, mut worst) = (0f64, 0f64, 0usize, 0f64);
        let (mut cars, mut solver, mut ai, mut steps) = (0f64, 0f64, 0f64, 0u32);
        let mut snaps = Vec::new();
        let mut start: Vec<[f32; 3]> = Vec::new();
        let ticks = 30 * 40;
        let warm = 150;
        for t in 0..ticks {
            seq += 2;
            for id in 1..=spots.len() as u16 {
                // full throttle, weaving (every car moving: contacts, tyre rays, drivetrains all busy)
                let frame = InputFrame {
                    throttle: 127,
                    steer: ((t as f32 * 0.03 + id as f32).sin() * 18.0) as i8,
                    ..Default::default()
                };
                m.on_input(
                    id,
                    &Input {
                        seq,
                        opts: 2 | drive_opts::OFFROAD,
                        frames: vec![frame; 4],
                    },
                );
            }
            now += 33;
            let a = std::time::Instant::now();
            m.step(now);
            let b = std::time::Instant::now();
            m.snapshots(&mut snaps);
            let c = std::time::Instant::now();
            m.drain().for_each(drop);
            let mut vs = Vec::new();
            m.vehicle_states(&mut vs);
            if t == warm {
                start = (1..=spots.len() as u16)
                    .map(|id| m.pose_of(id).map_or([0.0; 3], |p| p.pos))
                    .collect();
            }
            if t >= warm {
                step_t += (b - a).as_secs_f64();
                snap_t += (c - b).as_secs_f64();
                worst = worst.max((c - a).as_secs_f64());
                bytes += snaps.iter().map(|s| s.1.len()).sum::<usize>() + vs.iter().map(|v| v.1.len()).sum::<usize>();
                let p = m.profile();
                (cars, solver, ai, steps) = (cars + p.cars_us, solver + p.solver_us, ai + p.ai_us, steps + p.steps);
            }
        }
        let n = (ticks - warm) as f64;
        eprintln!(
            "{} drivers + {} bots, {} vehicles in physics: step {:.0} µs (cars {:.0} + solver {:.0} + bot AI {:.0}, {:.2}              physics steps/tick) + snapshots {:.0} µs = {:.0} µs per tick (worst {:.0} µs, budget 33 333); {:.1} KB/s              per player",
            spots.len(),
            m.bot_count(),
            m.physics_vehicles(),
            step_t / n * 1e6,
            cars / n,
            solver / n,
            ai / n,
            steps as f64 / n,
            snap_t / n * 1e6,
            (step_t + snap_t) / n * 1e6,
            worst * 1e6,
            bytes as f64 / n * 30.0 / spots.len() as f64 / 1024.0
        );
        // (driven the whole time: covered real distance — not stuck on a tree at the first bend)
        let moving = (1..=spots.len() as u16)
            .filter(|&id| {
                let (a, p) = (start[id as usize - 1], m.pose_of(id).unwrap().pos);
                (p[0] - a[0]).hypot(p[2] - a[2]) > 30.0
            })
            .count();
        eprintln!("{moving} of {} drivers covered > 30 m", spots.len());
        // (full throttle, no driver AI: some end up against a tree — they cost the same; the rest must really drive)
        assert!(moving > spots.len() / 4, "the drivers' cars are simulated and moving");
    }
}

#[cfg(test)]
mod empty_room {
    use crate::game::{Match, MatchConfig, Mode};
    use crate::map::MapData;
    use dark_protocol::*;
    use std::path::Path;
    use std::sync::Arc;

    /// A room's bots after the last person left: `cargo test --release -p dark-sim empty_room -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bots_after_everyone_left() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        let map = Arc::new(MapData::load(&dir).unwrap());
        let room = RoomSettings {
            code: "EMPTY1".into(),
            name: "e".into(),
            flags: 0,
            max_players: 100,
            owner: 1,
            bots: 100,
        };
        let mut m = Match::new(
            5,
            7,
            Some(map.clone()),
            MatchConfig {
                mode: Mode::FreeRoam,
                ..Default::default()
            },
            Some(room),
            0,
        );
        m.join(1, "h").unwrap();
        let (lx, lz) = (map.lobby[0], map.lobby[1]);
        let mut now = 0;
        for phase in 0..2 {
            let (mut worst, mut sum, mut n) = (0.0f64, 0.0, 0);
            for t in 0..900u32 {
                now += 33;
                if phase == 0 {
                    let y = map.height(lx, lz);
                    m.on_state(
                        1,
                        &State {
                            seq: t + 1,
                            client_time: 0,
                            epoch: 0,
                            flags: 0,
                            model: 0,
                            pos: [m_to_cm(lx), m_to_cm(y), m_to_cm(lz)],
                            yaw: 0,
                            pitch: 0,
                            vel: [0; 3],
                        },
                    );
                }
                let t0 = std::time::Instant::now();
                m.step(now);
                let us = t0.elapsed().as_secs_f64() * 1e6;
                m.drain().for_each(drop);
                (worst, sum, n) = (worst.max(us), sum + us, n + 1);
                if let Some(id) = m.first_bad_bot() {
                    panic!("phase {phase} tick {t}: bot {id} not finite");
                }
            }
            println!(
                "{}: mean {:.0} µs, worst {:.0} µs, vehicles {}",
                if phase == 0 { "with a person" } else { "after they left" },
                sum / n as f64,
                worst,
                m.physics_vehicles()
            );
            if phase == 0 {
                m.leave(1);
            }
        }
    }
}

#[cfg(test)]
mod statics {
    use super::*;
    use dark_vehicle::rapier3d::prelude::{QueryFilter, Ray};
    use std::path::Path;

    /// The game's static colliders on the server hit where the client's do: the exporter's level rays at trunks,
    /// boulders and set pieces (cast in the game's scratch world) give the same first hit here.
    #[test]
    fn statics_match_the_game() {
        // (each map's trunks and boulders: well over this many)
        for (id, min_solid) in [("island", 40_000), ("highlands", 15_000), ("zhangjiajie", 20_000)] {
            statics_match(id, min_solid);
        }
    }

    fn statics_match(id: &str, min_solid: usize) {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"));
        let dir = base.join("../../../game/public/maps").join(id);
        if !dir.join("statics.bin").exists() {
            return;
        }
        let map = MapData::load(&dir).unwrap();
        let st = map.statics.as_ref().unwrap();
        let golden: serde_json::Value =
            serde_json::from_slice(&std::fs::read(base.join(format!("golden/statics-probe-{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(
            golden["seed"].as_u64(),
            Some(st.seed as u64),
            "statics.bin and its probes come from one export"
        );
        let solid = st.items.iter().filter(|s| !s.breakable).count();
        assert!(solid > min_solid, "{id}: the trunks and boulders ({solid})");
        let ph = MapPhysics::get(&map);
        let mut w = ph.world();
        w.step(); // (scene queries see colliders from the first step on)
        let filter = QueryFilter::new().groups(group(0xffff, groups::STATIC));
        let (mut n, mut hits, mut worst) = (0, 0, 0.0f32);
        for p in golden["probes"].as_array().unwrap() {
            let v: Vec<f32> = p
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap() as f32)
                .collect();
            let ray = Ray::new(Vector::new(v[0], v[1], v[2]), Vector::new(v[3], v[4], v[5]));
            let toi = w.pw.cast_ray(&ray, 12.0, true, filter).map_or(-1.0, |(_, t)| t);
            let err = (toi - v[6]).abs();
            assert!(err < 2e-3, "{id} probe {n}: server {toi}, game {}", v[6]);
            worst = worst.max(err);
            n += 1;
            hits += usize::from(toi >= 0.0);
        }
        assert!(n > 300, "{id}: {n} probes");
        assert!(
            hits > n * 3 / 4,
            "{hits} of {n} probes hit (the export's rays must see its colliders)"
        );
        println!("{id}: {n} probes, worst {:.2} mm", worst * 1000.0);
    }
}
