//! BOTS — server-run players for rooms (the owner picks how many, 0–100). To every client a bot is just another
//! player (`PlayerJoined`, snapshots, roadkill); here each one has a PERSONALITY and plays like a person would:
//!
//! | activity | what it does |
//! |---|---|
//! | cruise | drives the roads: keeps right, slows for bends, follows the car ahead (IDM), overtakes slow traffic when the other lane is clear, picks turns at junctions, U-turns at dead ends, brakes (and steers round) people on the road |
//! | convoy | drives in a line behind another bot (or a player) — on the road, off it, on the water, in the air |
//! | race | the race organiser gathers 3–6 drivers at a start, counts down and they race a route flat out (boost, late braking, aggressive overtakes) |
//! | explore | leaves the road for a far point cross-country (maps), gets stuck sometimes — and respawns like a player |
//! | boat | drives to the shore, into the water (the car's boat form), sails between open-water points, lands again |
//! | fly | takes off (rooms with flying cars), flies a few waypoints high over the land, lands on a road |
//! | stroll | pulls over, gets out, walks around, comes back and drives on |
//! | hang out | goes to a player nearby: follows them in the car, or parks and walks up to them |
//! | afk | stops for a while |
//!
//! Movement: on a MAP room with server physics ([`crate::physics::RoomPhysics`]) a bot in a car DRIVES the game's
//! car model (`dark_vehicle`): the AI below plans as before — lane, speed, the car in front, junctions, overtakes —
//! but its plan is only a target point and a speed for a driver ([`dark_vehicle::control`]); the physics moves the
//! car, and the bot's pose and road progress are read back from it (it can be blocked, pushed, run off the road).
//! Boats, flights and walking stay kinematic. Without physics (endless rooms, tests) all movement is kinematic:
//! road driving on the road graph (`nav`), point steering with terrain checks elsewhere (slope, water — the car
//! turns into a boat in the water and back on land), stuck detection → respawn on the nearest road. Bots far from every human update at a quarter rate and are RECYCLED
//! next to the humans when nobody is near them (GTA population management). The endless world: the server knows
//! its road and river exactly (`noise::Endless`) but not the terrain off them — bots stay near the road and the
//! clients set their feet / wheels on their own ground.

use crate::map::MapData;
use crate::nav::{Nav, OnEdge};
use crate::noise::{Endless, RIVER_HALF_WIDTH, WATER};
use crate::physics::RoomPhysics;
use crate::rng::Rng;
use crate::validate::Pose;
use dark_protocol::{BOT_ID_BASE, flags};
use dark_vehicle::Truck;
use dark_vehicle::control::{Intent, drive as drive_to};
use dark_vehicle::truck::Controls;
use std::collections::{HashMap, VecDeque};
use std::f32::consts::PI;
use std::sync::Arc;

/// Cars in the game's catalogue (`game/src/gameplay/vehicle/catalogue.ts`; wire model = index + 1).
pub const CAR_MODELS: u8 = 3;
/// Most bots a room can have.
pub const MAX_BOTS: usize = 100;

const NAMES: [&str; 64] = [
    "Aarav", "Meera", "Kabir", "Isha", "Rohan", "Anaya", "Vihaan", "Diya", "Arjun", "Saanvi", "Kiran", "Nila", "Dev",
    "Tara", "Zara", "Leo", "Mila", "Noah", "Ava", "Luca", "Emma", "Omar", "Lina", "Yuki", "Hana", "Ken", "Sora",
    "Mateo", "Lucia", "Diego", "Sofia", "Ivan", "Olga", "Niko", "Elsa", "Finn", "Ingrid", "Kofi", "Amara", "Tunde",
    "Zainab", "Ravi", "Priya", "Sana", "Ali", "Maya", "Eli", "Nora", "Jonah", "Iris", "Theo", "Ruby", "Max", "Ivy",
    "Jay", "Asha", "Neel", "Riya", "Om", "Kavya", "Adi", "Nina", "Sam", "Juno",
];

// ---------------------------------------------------------------- the world as bots see it

/// What the bots know of the room's world.
pub enum World {
    Map { map: Arc<MapData>, nav: Arc<Nav> },
    Endless(Box<Endless>),
}

impl World {
    pub fn for_map(map: Arc<MapData>) -> Self {
        let nav = Nav::get(&map);
        World::Map { map, nav }
    }

    /// Ground height (endless: the road's, off the road the clients use their own terrain).
    fn ground(&self, x: f32, z: f32) -> f32 {
        match self {
            World::Map { map, .. } => map.surface(x, z), // (the ice on a frozen lake / sea)
            World::Endless(e) => e.road_y(z as f64) as f32,
        }
    }

    /// Open water a boat can use here.
    fn water(&self, x: f32, z: f32) -> bool {
        match self {
            World::Map { nav, .. } => nav.water.as_ref().is_some_and(|w| w.dist_at(x, z) > 2.0),
            World::Endless(e) => (x as f64 - e.river_x(z as f64)).abs() < (RIVER_HALF_WIDTH - 2.0) as f64,
        }
    }

    /// Can a car (or a person: `foot`) go from a to b (slope, the map's edge, the endless road's corridor)?
    fn passable(&self, ax: f32, az: f32, bx: f32, bz: f32, foot: bool) -> bool {
        match self {
            World::Map { map, .. } => {
                if bx.abs() > map.half + 150.0 || bz.abs() > map.half + 150.0 {
                    return false;
                }
                let d = ((bx - ax).powi(2) + (bz - az).powi(2)).sqrt().max(0.5);
                let rise = (map.surface(bx, bz) - map.surface(ax, az)).abs();
                rise / d < if foot { 1.0 } else { 0.85 }
            }
            World::Endless(e) => {
                let rx = e.road_x(bz as f64) as f32;
                let river = e.river_x(bz as f64) as f32;
                // between the road and its river, and a little either side
                let (lo, hi) = (rx.min(river) - 60.0, rx.max(river) + 25.0);
                bx > lo && bx < hi
            }
        }
    }
}

// ---------------------------------------------------------------- what bots see of everyone

/// An entity bots react to (humans and bots alike).
#[derive(Clone, Copy, Debug)]
pub struct Seen {
    pub id: u16,
    pub pose: Pose,
    pub bot: bool,
}

fn dir_of(yaw: f32) -> (f32, f32) {
    (-yaw.sin(), -yaw.cos())
}
fn yaw_of(dx: f32, dz: f32) -> f32 {
    (-dx).atan2(-dz)
}
fn wrap(a: f32) -> f32 {
    (a + PI).rem_euclid(2.0 * PI) - PI
}
fn hspeed(p: &Pose) -> f32 {
    (p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]).sqrt()
}

// ---------------------------------------------------------------- a bot

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Foot,
    Car,
    Boat,
    Air,
}

#[derive(Clone, Copy, Debug)]
struct Persona {
    /// Speed, overtaking, racing (0–1).
    aggr: f32,
    /// Convoys, hanging out with players.
    social: f32,
    /// Off-road, water, air.
    adventure: f32,
    /// Strolls, AFK.
    calm: f32,
}

#[derive(Clone, Copy, Debug)]
enum Lane {
    Edge(OnEdge),
    /// The endless road at z, driving toward +z (dir 1) or −z (−1).
    Endless {
        z: f64,
        dir: f32,
    },
}

#[derive(Clone, Debug)]
struct OnRoad {
    lane: Lane,
    /// Lateral offset right of the centre line (m) and where it's heading (lane, overtaking lane, shoulder).
    lat: f32,
    lat_to: f32,
    /// Chosen way on at the next node; a planned route (races, trips) takes precedence.
    next: Option<(usize, bool)>,
    route: VecDeque<(usize, bool)>,
    /// Seconds into an overtake (0 = not overtaking).
    overtake: f32,
}

#[derive(Clone, Debug, PartialEq)]
enum Act {
    Cruise,
    Convoy {
        leader: u16,
    },
    Race {
        race: u32,
    },
    Explore {
        x: f32,
        z: f32,
    },
    Boat {
        stage: u8,
        pts: Vec<[f32; 2]>,
    },
    Fly {
        stage: u8,
        pts: Vec<[f32; 2]>,
        alt: f32,
    },
    Stroll {
        stage: u8,
        x: f32,
        z: f32,
    },
    Hangout {
        who: u16,
    },
    Afk,
    /// Knocked down (roadkill): on the ground, then gets up and runs.
    Down,
}

pub struct Bot {
    pub id: u16,
    pub name: String,
    pub pose: Pose,
    p: Persona,
    model: u8,
    mode: Mode,
    x: f32,
    y: f32,
    z: f32,
    /// Travel heading, speed along it (m/s), vertical speed (air).
    yaw: f32,
    speed: f32,
    vy: f32,
    /// What the clients see (turns smoothly).
    show_yaw: f32,
    road: Option<OnRoad>,
    /// Free-movement waypoints (off-road, water, air, on foot).
    path: VecDeque<[f32; 2]>,
    act: Act,
    act_until: u64,
    /// The car while on foot: x, z, yaw.
    parked: Option<[f32; 3]>,
    /// Stuck watch: where it was and when.
    prog: ([f32; 2], f32),
    lod: f32,
    braking: bool,
    boost: bool,
    /// Convoy / hang-out: the index into the leader's trail being chased.
    cursor: u64,
    /// Server physics: the bot's car (in the room's world), the AI's plan for it this tick (target point, speed),
    /// a placement the car must follow (spawn / respawn), and the body's pitch and velocity for the pose.
    car: Option<Truck>,
    plan: Option<([f32; 2], f32)>,
    placed: bool,
    pitch: f32,
    roll: f32,
    vel: [f32; 3],
}

impl Bot {
    fn fwd(&self) -> (f32, f32) {
        dir_of(self.yaw)
    }
}

// ---------------------------------------------------------------- races

#[derive(Clone, Debug)]
enum RaceStage {
    Gather,
    Countdown(u64),
    Run,
}

#[derive(Clone, Debug)]
struct Race {
    id: u32,
    stage: RaceStage,
    members: Vec<u16>,
    /// Map: start node and the route from it. Endless: start z, direction, length.
    start_node: usize,
    route: Vec<(usize, bool)>,
    endless: Option<(f64, f32, f64)>,
    started: u64,
    finished: Vec<u16>,
}

// ---------------------------------------------------------------- the population

/// A bot joined / left (the match turns these into roster packets).
pub enum BotEvent {
    Joined(u16, String),
    Left(u16),
}

/// What the bots have been up to (metrics, tests).
#[derive(Clone, Copy, Debug, Default)]
pub struct BotStats {
    pub respawns: u64,
    pub races: u64,
    pub race_finishes: u64,
    pub boat_trips: u64,
    pub flights: u64,
    pub walks: u64,
    pub convoys: u64,
    pub hangouts: u64,
    pub recycled: u64,
}

pub struct Bots {
    pub stats: BotStats,
    world: World,
    rng: Rng,
    pub bots: Vec<Bot>,
    target: usize,
    flying: bool,
    races: Vec<Race>,
    next_race_ms: u64,
    race_seq: u32,
    /// Breadcrumbs (x, y, z, mode) of whoever is being followed, every ~2 m; the absolute index of the newest.
    trails: HashMap<u16, (VecDeque<[f32; 4]>, u64)>,
    recycle_ms: u64,
    /// Scratch: vehicles near each bot (rebuilt per tick).
    cells: crate::fasthash::FastMap<(i32, i32), Vec<usize>>,
    seen: Vec<Seen>,
    /// Cars drive in the room's physics (a map room with [`RoomPhysics`]); false = kinematic.
    physics: bool,
    /// Cars of bots that left, to take out of the physics world.
    dead_cars: Vec<Truck>,
    /// Cars built / set down (spawn, respawn, back from a boat or a flight) since the last [`Bots::take_car_events`].
    built: u32,
    set_down: u32,
}

const CELL: f32 = 48.0;
const TRAIL_STEP: f32 = 2.0;
const TRAIL_MAX: usize = 400;

impl Bots {
    pub fn new(world: World, seed: u64) -> Self {
        Self {
            stats: BotStats::default(),
            world,
            rng: Rng::new(seed ^ 0xb075),
            bots: Vec::new(),
            target: 0,
            flying: false,
            races: Vec::new(),
            next_race_ms: 30_000,
            race_seq: 0,
            trails: HashMap::new(),
            recycle_ms: 0,
            cells: crate::fasthash::FastMap::default(),
            seen: Vec::new(),
            physics: false,
            dead_cars: Vec::new(),
            built: 0,
            set_down: 0,
        }
    }

    /// Cars built and set down since the last call (profiling).
    pub fn take_car_events(&mut self) -> (u32, u32) {
        let e = (self.built, self.set_down);
        (self.built, self.set_down) = (0, 0);
        e
    }

    /// Drive the cars through the room's physics ([`Bots::drive_cars`] / [`Bots::after_physics`] each tick).
    pub fn use_physics(&mut self, on: bool) {
        self.physics = on && matches!(self.world, World::Map { .. });
    }

    /// How many bots the room wants, and whether its rules allow flying.
    pub fn configure(&mut self, count: usize, flying: bool) {
        self.target = count.min(MAX_BOTS);
        self.flying = flying;
    }

    pub fn is_bot(id: u16) -> bool {
        id >= BOT_ID_BASE && id < BOT_ID_BASE + MAX_BOTS as u16
    }

    /// A bot on foot was run over: down for a moment, then it runs off.
    pub fn knocked(&mut self, id: u16, now: u64) {
        if let Some(b) = self.bots.iter_mut().find(|b| b.id == id)
            && b.mode == Mode::Foot
        {
            b.act = Act::Down;
            b.act_until = now + 3500;
            b.speed = 0.0;
            b.path.clear();
        }
    }

    /// Advance every bot by `dt` to `now`. `others` = every player (humans and bots) as of the last tick.
    pub fn step(&mut self, dt: f32, now: u64, others: &[Seen], events: &mut Vec<BotEvent>) {
        self.seen.clear();
        self.seen.extend_from_slice(others);
        let humans: Vec<[f32; 2]> = others
            .iter()
            .filter(|s| !s.bot)
            .map(|s| [s.pose.pos[0], s.pose.pos[2]])
            .collect();
        self.population(now, &humans, events);
        if self.bots.is_empty() || humans.is_empty() {
            return;
        }
        // vehicles + people by cell (for leaders, oncoming traffic, people in the road)
        for v in self.cells.values_mut() {
            v.clear();
        }
        for (i, s) in self.seen.iter().enumerate() {
            let k = (
                (s.pose.pos[0] / CELL).floor() as i32,
                (s.pose.pos[2] / CELL).floor() as i32,
            );
            self.cells.entry(k).or_default().push(i);
        }
        self.update_trails();
        if now >= self.next_race_ms {
            self.organise_race(now);
            self.next_race_ms = now + 40_000 + (self.rng.f32() * 50_000.0) as u64;
        }
        self.run_races(now);
        if now >= self.recycle_ms {
            self.recycle_ms = now + 3000;
            self.recycle(&humans);
        }
        for i in 0..self.bots.len() {
            let (bx, bz) = (self.bots[i].x, self.bots[i].z);
            let near = humans
                .iter()
                .map(|h| (h[0] - bx).powi(2) + (h[1] - bz).powi(2))
                .fold(f32::INFINITY, f32::min)
                .sqrt();
            // far from everyone: a quarter of the ticks (it still moves the same distance)
            let b = &mut self.bots[i];
            b.lod += dt;
            if near > 1000.0 && b.lod < 0.12 {
                continue;
            }
            let step = b.lod.min(0.5);
            b.lod = 0.0;
            // physics: the AI plans from where the car really is; its kinematic step becomes the plan, and the
            // bot stays where the car is (the car moves in drive_cars)
            let real = (b.car.is_some() && b.mode == Mode::Car).then_some((b.x, b.y, b.z, b.yaw, b.speed));
            b.plan = None;
            self.think(i, step, now);
            self.drive(i, step, now);
            let b = &mut self.bots[i];
            if let Some((x, y, z, yaw, speed)) = real
                && !b.placed
                && b.mode == Mode::Car
            {
                (b.x, b.y, b.z, b.yaw, b.speed) = (x, y, z, yaw, speed);
            }
            if !self.physics || b.mode != Mode::Car {
                self.write_pose(i, step);
            }
        }
    }

    // ------------------------------------------------------------ population

    fn population(&mut self, now: u64, humans: &[[f32; 2]], events: &mut Vec<BotEvent>) {
        while self.bots.len() > self.target {
            let mut b = self.bots.pop().expect("non-empty");
            if let Some(c) = b.car.take() {
                self.dead_cars.push(c);
            }
            self.trails.remove(&b.id);
            events.push(BotEvent::Left(b.id));
        }
        // new bots appear once someone is in the world to see them
        if humans.is_empty() {
            return;
        }
        let mut added = 0;
        while self.bots.len() < self.target && added < 4 {
            let slot = (0..MAX_BOTS as u16)
                .find(|k| !self.bots.iter().any(|b| b.id == BOT_ID_BASE + k))
                .unwrap_or(0);
            let id = BOT_ID_BASE + slot;
            let r = &mut self.rng;
            let p = Persona {
                aggr: r.f32(),
                social: r.f32(),
                adventure: r.f32(),
                calm: r.f32(),
            };
            let name = NAMES[(r.next_u64() % NAMES.len() as u64) as usize].to_owned();
            let model = 1 + (r.next_u64() % CAR_MODELS as u64) as u8;
            let anchor = humans[(r.next_u64() % humans.len() as u64) as usize];
            let mut b = Bot {
                id,
                name: name.clone(),
                pose: Pose::default(),
                p,
                model,
                mode: Mode::Car,
                x: anchor[0],
                y: 0.0,
                z: anchor[1],
                yaw: 0.0,
                speed: 0.0,
                vy: 0.0,
                show_yaw: 0.0,
                road: None,
                path: VecDeque::new(),
                act: Act::Cruise,
                act_until: now + 60_000,
                parked: None,
                prog: ([anchor[0], anchor[1]], 0.0),
                lod: 0.0,
                braking: false,
                boost: false,
                cursor: 0,
                car: None,
                plan: None,
                placed: false,
                pitch: 0.0,
                roll: 0.0,
                vel: [0.0; 3],
            };
            let dist = 120.0 + self.rng.f32() * 500.0;
            self.place_on_road(&mut b, anchor, dist);
            b.speed = 6.0;
            self.bots.push(b);
            let i = self.bots.len() - 1;
            self.write_pose(i, 0.0);
            events.push(BotEvent::Joined(id, name));
            added += 1;
        }
    }

    /// Put a bot on a road `dist` m from `anchor` (a random direction), driving.
    fn place_on_road(&mut self, b: &mut Bot, anchor: [f32; 2], dist: f32) {
        let a = self.rng.f32() * 2.0 * PI;
        let lane_side = if self.rng.f32() < 0.5 { 1.0 } else { -1.0 };
        match &self.world {
            World::Map { nav, .. } if nav.edges.is_empty() => {
                // a map without roads: on foot
                b.road = None;
                b.mode = Mode::Foot;
                b.x = anchor[0] + a.cos() * dist.min(60.0);
                b.z = anchor[1] + a.sin() * dist.min(60.0);
                b.y = self.world.ground(b.x, b.z);
                return;
            }
            World::Map { nav, .. } => {
                let mut on = None;
                for t in 0..8 {
                    let r = dist * (1.0 - t as f32 * 0.12);
                    let (x, z) = (
                        anchor[0] + (a + t as f32).cos() * r,
                        anchor[1] + (a + t as f32).sin() * r,
                    );
                    if let Some((e, t, _)) = nav.nearest(x, z, 300.0) {
                        on = Some((e, t));
                        break;
                    }
                }
                let (e, t) = on.unwrap_or((0, 0.0));
                let forward = lane_side > 0.0;
                let len = nav.edges[e].len();
                let lane = Lane::Edge(OnEdge {
                    edge: e,
                    forward,
                    t: if forward { t } else { len - t },
                });
                b.road = Some(OnRoad {
                    lane,
                    lat: 0.0,
                    lat_to: 0.0,
                    next: None,
                    route: VecDeque::new(),
                    overtake: 0.0,
                });
            }
            World::Endless(_) => {
                let z = anchor[1] as f64 + (a.sin() * dist) as f64;
                b.road = Some(OnRoad {
                    lane: Lane::Endless { z, dir: lane_side },
                    lat: 0.0,
                    lat_to: 0.0,
                    next: None,
                    route: VecDeque::new(),
                    overtake: 0.0,
                });
            }
        }
        let lw = self.lane_width(b);
        let r = b.road.as_mut().expect("just set");
        r.lat = lw;
        r.lat_to = lw;
        b.mode = Mode::Car;
        b.path.clear();
        b.parked = None;
        self.snap_to_road(b);
        b.show_yaw = b.yaw;
        b.prog = ([b.x, b.z], 0.0);
        b.placed = true;
    }

    /// GTA-style: a bot nobody is near (and isn't racing / following) reappears on a road near the humans.
    fn recycle(&mut self, humans: &[[f32; 2]]) {
        let far = match self.world {
            World::Endless(_) => 1800.0,
            World::Map { .. } => 2600.0,
        };
        for i in 0..self.bots.len() {
            let (x, z) = (self.bots[i].x, self.bots[i].z);
            let near = humans
                .iter()
                .map(|h| ((h[0] - x).powi(2) + (h[1] - z).powi(2)).sqrt())
                .fold(f32::INFINITY, f32::min);
            if near < far || matches!(self.bots[i].act, Act::Race { .. } | Act::Convoy { .. }) {
                continue;
            }
            let anchor = humans[(self.rng.next_u64() % humans.len() as u64) as usize];
            let mut b = std::mem::replace(&mut self.bots[i], Bot::placeholder());
            let d = 600.0 + self.rng.f32() * 400.0;
            self.place_on_road(&mut b, anchor, d);
            b.act = Act::Cruise;
            b.speed = 10.0;
            self.bots[i] = b;
            self.stats.recycled += 1;
        }
    }
}

impl Bot {
    fn placeholder() -> Bot {
        Bot {
            id: 0,
            name: String::new(),
            pose: Pose::default(),
            p: Persona {
                aggr: 0.0,
                social: 0.0,
                adventure: 0.0,
                calm: 0.0,
            },
            model: 1,
            mode: Mode::Car,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            yaw: 0.0,
            speed: 0.0,
            vy: 0.0,
            show_yaw: 0.0,
            road: None,
            path: VecDeque::new(),
            act: Act::Afk,
            act_until: 0,
            parked: None,
            prog: ([0.0, 0.0], 0.0),
            lod: 0.0,
            braking: false,
            boost: false,
            cursor: 0,
            car: None,
            plan: None,
            placed: false,
            pitch: 0.0,
            roll: 0.0,
            vel: [0.0; 3],
        }
    }
}

impl Bots {
    // ------------------------------------------------------------ trails (for followers)

    fn update_trails(&mut self) {
        // who is being followed
        let mut wanted: Vec<u16> = self
            .bots
            .iter()
            .filter_map(|b| match b.act {
                Act::Convoy { leader } => Some(leader),
                Act::Hangout { who } => Some(who),
                _ => None,
            })
            .collect();
        wanted.sort_unstable();
        wanted.dedup();
        self.trails.retain(|id, _| wanted.binary_search(id).is_ok());
        for id in wanted {
            let Some(s) = self.seen.iter().find(|s| s.id == id) else {
                continue;
            };
            let p = s.pose;
            let mode = if p.flags & flags::FLYING != 0 {
                3.0
            } else if p.flags & flags::BOAT != 0 {
                2.0
            } else if p.flags & flags::DRIVING != 0 {
                1.0
            } else {
                0.0
            };
            let (t, head) = self.trails.entry(id).or_insert_with(|| (VecDeque::new(), 0));
            let far = t
                .back()
                .is_none_or(|q| (q[0] - p.pos[0]).powi(2) + (q[2] - p.pos[2]).powi(2) >= TRAIL_STEP * TRAIL_STEP);
            if far {
                t.push_back([p.pos[0], p.pos[1], p.pos[2], mode]);
                *head += 1;
                if t.len() > TRAIL_MAX {
                    t.pop_front();
                }
            }
        }
    }

    // ------------------------------------------------------------ activities

    /// Pick / advance the bot's activity.
    fn think(&mut self, i: usize, _dt: f32, now: u64) {
        let act = self.bots[i].act.clone();
        match act {
            Act::Race { .. } => {} // the race organiser drives this
            Act::Down => {
                if now >= self.bots[i].act_until {
                    // up again: run away from the road for a few seconds, then carry on
                    let b = &mut self.bots[i];
                    let (fx, fz) = b.fwd();
                    let side = if self.rng.f32() < 0.5 { 1.0 } else { -1.0 };
                    b.path = VecDeque::from([[b.x - fz * side * 14.0 + fx * 4.0, b.z + fx * side * 14.0 + fz * 4.0]]);
                    b.act = Act::Stroll {
                        stage: 1,
                        x: b.x,
                        z: b.z,
                    };
                    b.act_until = now + 20_000;
                }
            }
            Act::Convoy { leader } | Act::Hangout { who: leader } => {
                let gone = !self.seen.iter().any(|s| s.id == leader);
                if gone || now >= self.bots[i].act_until {
                    self.end_activity(i, now);
                }
            }
            Act::Explore { x, z } => {
                let b = &self.bots[i];
                if (b.x - x).powi(2) + (b.z - z).powi(2) < 25.0 * 25.0 || now >= b.act_until {
                    // there: sometimes a walk round, otherwise back to the roads
                    if self.rng.f32() < 0.4 {
                        self.start_stroll(i, now);
                    } else {
                        self.end_activity(i, now);
                    }
                } else if self.bots[i].path.is_empty() {
                    self.bots[i].path.push_back([x, z]);
                }
            }
            Act::Boat { stage, .. } => self.boat_stage(i, stage, now),
            Act::Fly { stage, .. } => self.fly_stage(i, stage, now),
            Act::Stroll { stage, x, z } => self.stroll_stage(i, stage, x, z, now),
            Act::Afk => {
                if now >= self.bots[i].act_until {
                    self.end_activity(i, now);
                }
            }
            Act::Cruise => {
                if now >= self.bots[i].act_until {
                    self.choose(i, now);
                }
            }
        }
    }

    /// Back to cruising the roads (finding one first if off them).
    fn end_activity(&mut self, i: usize, now: u64) {
        let b = &mut self.bots[i];
        b.act = Act::Cruise;
        b.act_until = now + 40_000 + (self.rng.f32() * 80_000.0) as u64;
        if b.mode == Mode::Foot {
            // walk back to the car
            if let Some(c) = b.parked {
                b.act = Act::Stroll {
                    stage: 3,
                    x: c[0],
                    z: c[1],
                };
                b.path = VecDeque::from([[c[0], c[1]]]);
            }
        }
    }

    /// A new activity, by personality and what's around.
    fn choose(&mut self, i: usize, now: u64) {
        let (p, x, z, mode) = {
            let b = &self.bots[i];
            (b.p, b.x, b.z, b.mode)
        };
        if mode == Mode::Foot {
            self.end_activity(i, now);
            return;
        }
        let has_water = match &self.world {
            World::Map { nav, .. } => !nav.shores.is_empty(),
            World::Endless(_) => true,
        };
        // a person nearby who doesn't already have company (≤ 3 bots with each)
        let company = |id: u16| self.bots.iter().filter(|o| o.act == Act::Hangout { who: id }).count();
        let human_near = self.seen.iter().any(|s| {
            !s.bot && (s.pose.pos[0] - x).powi(2) + (s.pose.pos[2] - z).powi(2) < 400.0 * 400.0 && company(s.id) < 3
        });
        let leader_near = self.bots.iter().any(|o| {
            o.id != self.bots[i].id
                && o.act == Act::Cruise
                && o.mode == Mode::Car
                && (o.x - x).powi(2) + (o.z - z).powi(2) < 250.0 * 250.0
        });
        let maps = matches!(self.world, World::Map { .. });
        let w = [
            ("cruise", 3.0),
            ("convoy", if leader_near { 2.0 * p.social } else { 0.0 }),
            ("explore", if maps { 1.6 * p.adventure } else { 0.0 }),
            ("boat", if has_water { 1.4 * p.adventure } else { 0.0 }),
            ("fly", if self.flying { 1.5 * p.adventure } else { 0.0 }),
            ("stroll", 1.4 * p.calm),
            ("hangout", if human_near { 1.2 * p.social } else { 0.0 }),
            ("afk", 0.5 * p.calm),
        ];
        let total: f32 = w.iter().map(|x| x.1).sum();
        let mut r = self.rng.f32() * total;
        let mut pick = "cruise";
        for (name, wt) in w {
            r -= wt;
            if r <= 0.0 {
                pick = name;
                break;
            }
        }
        let b_until = now + 40_000 + (self.rng.f32() * 90_000.0) as u64;
        match pick {
            "convoy" => {
                let me = self.bots[i].id;
                let leader = self
                    .bots
                    .iter()
                    .filter(|o| o.id != me && o.act == Act::Cruise && o.mode == Mode::Car)
                    .min_by(|a, c| {
                        ((a.x - x).powi(2) + (a.z - z).powi(2)).total_cmp(&((c.x - x).powi(2) + (c.z - z).powi(2)))
                    })
                    .map(|o| o.id);
                if let Some(leader) = leader {
                    self.follow(i, leader, b_until);
                    return;
                }
            }
            "hangout" => {
                let who = self
                    .seen
                    .iter()
                    .filter(|s| !s.bot && company(s.id) < 3)
                    .min_by(|a, c| {
                        let da = (a.pose.pos[0] - x).powi(2) + (a.pose.pos[2] - z).powi(2);
                        let dc = (c.pose.pos[0] - x).powi(2) + (c.pose.pos[2] - z).powi(2);
                        da.total_cmp(&dc)
                    })
                    .map(|s| s.id);
                if let Some(who) = who {
                    self.stats.hangouts += 1;
                    let b = &mut self.bots[i];
                    b.act = Act::Hangout { who };
                    b.act_until = now + 60_000 + (self.rng.f32() * 120_000.0) as u64;
                    b.cursor = 0;
                    return;
                }
            }
            "explore" => {
                if let World::Map { map, .. } = &self.world {
                    for _ in 0..12 {
                        let a = self.rng.f32() * 2.0 * PI;
                        let d = 150.0 + self.rng.f32() * 350.0;
                        let (tx, tz) = (x + a.cos() * d, z + a.sin() * d);
                        if tx.abs() < map.half - 40.0 && tz.abs() < map.half - 40.0 && map.height(tx, tz) > WATER + 1.0
                        {
                            let b = &mut self.bots[i];
                            b.road = None;
                            b.act = Act::Explore { x: tx, z: tz };
                            b.act_until = now + 150_000;
                            b.path = VecDeque::from([[tx, tz]]);
                            return;
                        }
                    }
                }
            }
            "boat" => {
                if self.start_boat(i, now) {
                    return;
                }
            }
            "fly" => {
                self.start_fly(i, now);
                return;
            }
            "stroll" => {
                self.start_stroll(i, now);
                return;
            }
            "afk" => {
                let b = &mut self.bots[i];
                b.act = Act::Afk;
                b.act_until = now + 15_000 + (self.rng.f32() * 40_000.0) as u64;
                if let Some(r) = b.road.as_mut() {
                    r.lat_to = self_shoulder(&self.world, r);
                }
                return;
            }
            _ => {}
        }
        let b = &mut self.bots[i];
        b.act = Act::Cruise;
        b.act_until = b_until;
    }

    fn follow(&mut self, i: usize, leader: u16, until: u64) {
        self.stats.convoys += 1;
        let b = &mut self.bots[i];
        b.act = Act::Convoy { leader };
        b.act_until = until;
        b.cursor = 0;
    }

    // --- boat

    fn start_boat(&mut self, i: usize, now: u64) -> bool {
        let (x, z) = (self.bots[i].x, self.bots[i].z);
        let pts: Vec<[f32; 2]> = match &self.world {
            World::Map { nav, .. } => {
                // the nearest shore crossing, then 2–4 open-water points, then another shore
                let Some(s) = nav.shores.iter().min_by(|a, b| {
                    let da = (a.land[0] - x).powi(2) + (a.land[1] - z).powi(2);
                    let db = (b.land[0] - x).powi(2) + (b.land[1] - z).powi(2);
                    da.total_cmp(&db)
                }) else {
                    return false;
                };
                if (s.land[0] - x).powi(2) + (s.land[1] - z).powi(2) > 900.0 * 900.0 {
                    return false;
                }
                let mut v = vec![s.land, s.water];
                let n = 2 + (self.rng.next_u64() % 3) as usize;
                let near: Vec<[f32; 2]> = nav
                    .open_water
                    .iter()
                    .copied()
                    .filter(|p| (p[0] - s.water[0]).powi(2) + (p[1] - s.water[1]).powi(2) < 700.0 * 700.0)
                    .collect();
                if near.is_empty() {
                    return false;
                }
                for _ in 0..n {
                    v.push(near[(self.rng.next_u64() % near.len() as u64) as usize]);
                }
                // land at a shore near the last point
                let last = *v.last().expect("points");
                if let Some(e) = nav.shores.iter().min_by(|a, b| {
                    let da = (a.water[0] - last[0]).powi(2) + (a.water[1] - last[1]).powi(2);
                    let db = (b.water[0] - last[0]).powi(2) + (b.water[1] - last[1]).powi(2);
                    da.total_cmp(&db)
                }) {
                    v.push(e.water);
                    v.push(e.land);
                }
                v
            }
            World::Endless(e) => {
                // down to the river beside the road, along it a few hundred metres, back up
                let dir = if self.rng.f32() < 0.5 { 1.0 } else { -1.0 };
                let mut v = Vec::new();
                let z0 = z as f64;
                v.push([
                    e.river_x(z0) as f32 - 12.0 * (e.river_x(z0) - e.road_x(z0)).signum() as f32,
                    z,
                ]);
                let len = 300.0 + self.rng.f32() * 600.0;
                let mut d = 0.0;
                while d <= len {
                    let zz = z0 + (dir * d) as f64;
                    v.push([e.river_x(zz) as f32 + dir * 3.0, zz as f32]);
                    d += 40.0;
                }
                let ze = z0 + (dir * len) as f64;
                v.push([e.road_x(ze) as f32, ze as f32]);
                v
            }
        };
        let b = &mut self.bots[i];
        b.road = None;
        b.path = pts.iter().copied().collect();
        b.act = Act::Boat { stage: 0, pts };
        b.act_until = now + 300_000;
        self.stats.boat_trips += 1;
        true
    }

    fn boat_stage(&mut self, i: usize, _stage: u8, now: u64) {
        let b = &self.bots[i];
        if b.path.is_empty() || now >= b.act_until {
            self.end_activity(i, now);
        }
    }

    // --- fly

    fn start_fly(&mut self, i: usize, now: u64) {
        let (x, z) = (self.bots[i].x, self.bots[i].z);
        let n = 2 + (self.rng.next_u64() % 3) as usize;
        let mut pts = Vec::new();
        let mut alt: f32 = 0.0;
        for _ in 0..n {
            let a = self.rng.f32() * 2.0 * PI;
            let d = 300.0 + self.rng.f32() * 700.0;
            let (mut px, mut pz) = (x + a.cos() * d, z + a.sin() * d);
            match &self.world {
                World::Map { map, .. } => {
                    px = px.clamp(-map.half + 50.0, map.half - 50.0);
                    pz = pz.clamp(-map.half + 50.0, map.half - 50.0);
                    alt = alt.max(map.height(px, pz));
                }
                World::Endless(e) => {
                    pz = z + a.sin().signum() * d;
                    px = e.road_x(pz as f64) as f32 + a.cos() * 80.0;
                    alt = alt.max(e.road_y(pz as f64) as f32);
                }
            }
            pts.push([px, pz]);
        }
        // high enough over the highest ground on the way (endless: the hills beside the road are unknown — go high)
        let clear = if matches!(self.world, World::Endless(_)) {
            170.0
        } else {
            70.0
        };
        let alt = alt.max(self.world.ground(x, z)) + clear + self.rng.f32() * 60.0;
        let b = &mut self.bots[i];
        b.road = None;
        b.mode = Mode::Air;
        b.vy = 0.0;
        b.path = pts.iter().copied().collect();
        b.act = Act::Fly { stage: 0, pts, alt };
        b.act_until = now + 240_000;
        self.stats.flights += 1;
    }

    fn fly_stage(&mut self, i: usize, stage: u8, now: u64) {
        let b = &self.bots[i];
        if stage == 0 && (b.path.is_empty() || now >= b.act_until || !self.flying) {
            // land: on the nearest road
            let (x, z) = (b.x, b.z);
            let land = match &self.world {
                World::Map { nav, .. } => nav.nearest(x, z, 2000.0).map(|(e, t, _)| {
                    let p = nav.at(OnEdge {
                        edge: e,
                        forward: true,
                        t,
                    });
                    [p.x, p.z]
                }),
                World::Endless(e) => Some([e.road_x(z as f64) as f32, z]),
            };
            let b = &mut self.bots[i];
            if let Act::Fly { stage, .. } = &mut b.act {
                *stage = 1;
            }
            b.path = land.into_iter().collect();
        } else if stage == 1 && self.bots[i].mode == Mode::Car {
            self.end_activity(i, now);
        }
    }

    // --- stroll

    fn start_stroll(&mut self, i: usize, now: u64) {
        let b = &mut self.bots[i];
        b.act = Act::Stroll {
            stage: 0,
            x: b.x,
            z: b.z,
        };
        b.act_until = now + 120_000;
        if let Some(r) = b.road.as_mut() {
            r.lat_to = self_shoulder(&self.world, r);
        }
    }

    fn stroll_stage(&mut self, i: usize, stage: u8, sx: f32, sz: f32, now: u64) {
        match stage {
            // pulling over → stopped on the shoulder: get out
            0 => {
                let b = &self.bots[i];
                let pulled = b.road.as_ref().is_none_or(|r| (r.lat - r.lat_to).abs() < 0.3);
                if b.speed < 0.3 && pulled {
                    let b = &mut self.bots[i];
                    b.parked = Some([b.x, b.z, b.yaw]);
                    b.mode = Mode::Foot;
                    b.road = None;
                    b.speed = 0.0;
                    self.stats.walks += 1;
                    let n = 1 + (self.rng.next_u64() % 3) as usize;
                    let mut pts = VecDeque::new();
                    for _ in 0..n {
                        let a = self.rng.f32() * 2.0 * PI;
                        let d = 12.0 + self.rng.f32() * 40.0;
                        pts.push_back([sx + a.cos() * d, sz + a.sin() * d]);
                    }
                    let b = &mut self.bots[i];
                    b.path = pts;
                    b.act = Act::Stroll { stage: 1, x: sx, z: sz };
                    b.act_until = now + 60_000;
                }
            }
            // walking about → (path done) a pause
            1 => {
                let b = &mut self.bots[i];
                if b.path.is_empty() || now >= b.act_until {
                    b.act = Act::Stroll { stage: 2, x: sx, z: sz };
                    b.act_until = now + 4000 + (self.rng.f32() * 12_000.0) as u64;
                }
            }
            // pause → back to the car
            2 => {
                let b = &mut self.bots[i];
                if now >= b.act_until {
                    let c = b.parked.unwrap_or([b.x, b.z, b.yaw]);
                    b.path = VecDeque::from([[c[0], c[1]]]);
                    b.act = Act::Stroll {
                        stage: 3,
                        x: c[0],
                        z: c[1],
                    };
                    b.act_until = now + 60_000;
                }
            }
            // at the car: in, and back on the road
            _ => {
                let b = &self.bots[i];
                let at_car = (b.x - sx).powi(2) + (b.z - sz).powi(2) < 2.5 * 2.5;
                if at_car || now >= b.act_until || b.parked.is_none() {
                    let b = &mut self.bots[i];
                    if let Some(c) = b.parked.take() {
                        b.x = c[0];
                        b.z = c[1];
                        b.yaw = c[2];
                    }
                    b.mode = Mode::Car;
                    b.path.clear();
                    b.act = Act::Cruise;
                    b.act_until = now + 60_000 + (self.rng.f32() * 60_000.0) as u64;
                }
            }
        }
    }

    // ------------------------------------------------------------ races

    fn organise_race(&mut self, now: u64) {
        if self.races.len() >= 2 {
            return;
        }
        let cands: Vec<usize> = (0..self.bots.len())
            .filter(|&k| {
                let b = &self.bots[k];
                b.act == Act::Cruise && b.mode == Mode::Car && b.road.is_some() && b.p.aggr > 0.25
            })
            .collect();
        if cands.len() < 3 {
            return;
        }
        let seed = cands[(self.rng.next_u64() % cands.len() as u64) as usize];
        let (sx, sz) = (self.bots[seed].x, self.bots[seed].z);
        let mut group: Vec<usize> = cands
            .into_iter()
            .filter(|&k| (self.bots[k].x - sx).powi(2) + (self.bots[k].z - sz).powi(2) < 1200.0 * 1200.0)
            .collect();
        group.sort_by(|&a, &b| {
            let da = (self.bots[a].x - sx).powi(2) + (self.bots[a].z - sz).powi(2);
            let db = (self.bots[b].x - sx).powi(2) + (self.bots[b].z - sz).powi(2);
            da.total_cmp(&db)
        });
        group.truncate(3 + (self.rng.next_u64() % 4) as usize);
        if group.len() < 3 {
            return;
        }
        let id = {
            self.race_seq += 1;
            self.race_seq
        };
        let race = match &self.world {
            World::Map { nav, .. } => {
                // start: the node nearest the group; finish: a node 1.2–3 km of road away
                let start = (0..nav.nodes.len())
                    .filter(|&n| nav.nodes[n].out.len() >= 2)
                    .min_by(|&a, &b| {
                        let da = (nav.nodes[a].x - sx).powi(2) + (nav.nodes[a].z - sz).powi(2);
                        let db = (nav.nodes[b].x - sx).powi(2) + (nav.nodes[b].z - sz).powi(2);
                        da.total_cmp(&db)
                    });
                let Some(start) = start else { return };
                let mut best: Option<Vec<(usize, bool)>> = None;
                for _ in 0..16 {
                    let goal = (self.rng.next_u64() % nav.nodes.len() as u64) as usize;
                    if let Some(r) = nav.route(start, goal) {
                        let l = nav.route_len(&r);
                        if (1200.0..3200.0).contains(&l) {
                            best = Some(r);
                            break;
                        }
                    }
                }
                let Some(route) = best else { return };
                Race {
                    id,
                    stage: RaceStage::Gather,
                    members: group.iter().map(|&k| self.bots[k].id).collect(),
                    start_node: start,
                    route,
                    endless: None,
                    started: now,
                    finished: Vec::new(),
                }
            }
            World::Endless(_) => {
                let dir = if self.rng.f32() < 0.5 { 1.0 } else { -1.0 };
                Race {
                    id,
                    stage: RaceStage::Gather,
                    members: group.iter().map(|&k| self.bots[k].id).collect(),
                    start_node: 0,
                    route: Vec::new(),
                    endless: Some((sz as f64, dir, 1800.0 + self.rng.f32() as f64 * 1500.0)),
                    started: now,
                    finished: Vec::new(),
                }
            }
        };
        self.stats.races += 1;
        for &k in &group {
            self.bots[k].act = Act::Race { race: id };
            self.bots[k].act_until = now + 400_000;
            self.route_to_start(k, &race);
        }
        self.races.push(race);
    }

    /// Plan a racer's way to the start line.
    fn route_to_start(&mut self, k: usize, race: &Race) {
        let b = &mut self.bots[k];
        let Some(r) = b.road.as_mut() else { return };
        match (&self.world, race.endless) {
            (World::Map { nav, .. }, _) => {
                if let Lane::Edge(on) = r.lane {
                    let from = nav.end_node(on);
                    r.route = nav.route(from, race.start_node).map(VecDeque::from).unwrap_or_default();
                    r.next = None;
                }
            }
            (World::Endless(_), Some((z0, _, _))) => {
                // turn round if the start is behind
                if let Lane::Endless { z, dir } = &mut r.lane
                    && (z0 - *z).signum() as f32 != *dir
                {
                    *dir = -*dir;
                    b.yaw = wrap(b.yaw + PI);
                }
            }
            _ => {}
        }
    }

    fn run_races(&mut self, now: u64) {
        let mut done = Vec::new();
        for ri in 0..self.races.len() {
            let race = self.races[ri].clone();
            let members: Vec<usize> = race
                .members
                .iter()
                .filter_map(|id| self.bots.iter().position(|b| b.id == *id))
                .collect();
            if members.len() < 2 || now > race.started + 420_000 {
                done.push(ri);
                continue;
            }
            match race.stage {
                RaceStage::Gather => {
                    // everyone stopped near the start (or waited long enough) → countdown
                    let (gx, gz) = self.start_point(&race);
                    let all = members.iter().all(|&k| {
                        let b = &self.bots[k];
                        b.speed < 1.0 && (b.x - gx).powi(2) + (b.z - gz).powi(2) < 90.0 * 90.0
                    });
                    if all || now > race.started + 120_000 {
                        self.races[ri].stage = RaceStage::Countdown(now + 4000);
                    }
                }
                RaceStage::Countdown(go) => {
                    if now >= go {
                        self.races[ri].stage = RaceStage::Run;
                        for &k in &members {
                            let route = race.route.clone();
                            let b = &mut self.bots[k];
                            if let (Some(r), Some((_, rdir, _))) = (b.road.as_mut(), race.endless)
                                && let Lane::Endless { dir, .. } = &mut r.lane
                                && *dir != rdir
                            {
                                *dir = rdir;
                                b.yaw = wrap(b.yaw + PI);
                            }
                            if let (Some(r), World::Map { nav, .. }) = (b.road.as_mut(), &self.world) {
                                // from wherever it waits: to the start node, then the race route
                                if let Lane::Edge(on) = r.lane {
                                    let mut full = nav.route(nav.end_node(on), race.start_node).unwrap_or_default();
                                    full.extend(route);
                                    r.route = VecDeque::from(full);
                                    r.next = None;
                                }
                            }
                        }
                    }
                }
                RaceStage::Run => {
                    for &k in &members {
                        let b = &self.bots[k];
                        if race.finished.contains(&b.id) {
                            continue;
                        }
                        let finished = match (&self.world, race.endless) {
                            (World::Map { .. }, _) => {
                                b.road.as_ref().is_some_and(|r| r.route.is_empty()) && !self.in_gather_leg(b)
                            }
                            (World::Endless(_), Some((z0, dir, len))) => (b.z as f64 - z0) * dir as f64 >= len,
                            _ => true,
                        };
                        if finished {
                            self.stats.race_finishes += 1;
                            self.races[ri].finished.push(b.id);
                        }
                    }
                    if self.races[ri].finished.len() >= members.len() {
                        done.push(ri);
                    }
                }
            }
        }
        for &ri in done.iter().rev() {
            let race = self.races.remove(ri);
            for id in race.members {
                if let Some(k) = self.bots.iter().position(|b| b.id == id)
                    && self.bots[k].act == (Act::Race { race: race.id })
                {
                    // winners celebrate (a short stop), everyone goes back to cruising
                    self.bots[k].act = Act::Afk;
                    self.bots[k].act_until = now + 6000 + (self.rng.f32() * 8000.0) as u64;
                    if let Some(r) = self.bots[k].road.as_mut() {
                        r.route.clear();
                    }
                }
            }
        }
    }

    fn in_gather_leg(&self, _b: &Bot) -> bool {
        false
    }

    fn start_point(&self, race: &Race) -> (f32, f32) {
        match (&self.world, race.endless) {
            (World::Map { nav, .. }, _) => (nav.nodes[race.start_node].x, nav.nodes[race.start_node].z),
            (World::Endless(e), Some((z0, _, _))) => (e.road_x(z0) as f32, z0 as f32),
            _ => (0.0, 0.0),
        }
    }

    fn race_of(&self, b: &Bot) -> Option<&Race> {
        match b.act {
            Act::Race { race } => self.races.iter().find(|r| r.id == race),
            _ => None,
        }
    }

    // ------------------------------------------------------------ movement

    fn lane_width(&self, b: &Bot) -> f32 {
        match (&self.world, b.road.as_ref().map(|r| r.lane)) {
            (World::Map { nav, .. }, Some(Lane::Edge(on))) => {
                (nav.roads[nav.edges[on.edge].road].half_width * 0.45).min(2.2)
            }
            _ => 1.35,
        }
    }

    /// Where the bot's lane puts it: (x, y, z, travel dir x, z) for the current road state.
    fn lane_point(&self, r: &OnRoad) -> (f32, f32, f32, f32, f32, bool) {
        match (&self.world, r.lane) {
            (World::Map { nav, .. }, Lane::Edge(on)) => {
                let p = nav.at(on);
                (p.x - p.dz * r.lat, p.y, p.z + p.dx * r.lat, p.dx, p.dz, p.bridge)
            }
            (World::Endless(e), Lane::Endless { z, dir }) => {
                let x = e.road_x(z);
                let slope = ((e.road_x(z + 1.0) - e.road_x(z - 1.0)) * 0.5) as f32;
                let l = (1.0 + slope * slope).sqrt();
                let (dx, dz) = (slope * dir / l, dir / l);
                (
                    x as f32 - dz * r.lat,
                    e.road_y(z) as f32,
                    z as f32 + dx * r.lat,
                    dx,
                    dz,
                    false,
                )
            }
            _ => (0.0, 0.0, 0.0, 0.0, -1.0, false),
        }
    }

    fn snap_to_road(&self, b: &mut Bot) {
        let Some(r) = b.road.as_ref() else { return };
        let (x, y, z, dx, dz, bridge) = self.lane_point(r);
        b.x = x;
        b.z = z;
        b.y = if bridge {
            y
        } else {
            self.world.ground(x, z).max(y - 0.5)
        };
        b.yaw = yaw_of(dx, dz);
    }

    /// The lane `d` m ahead on the road (x, z), following the planned way at the next node.
    fn lane_point_ahead(&self, r: &OnRoad, d: f32) -> [f32; 2] {
        match (&self.world, r.lane) {
            (World::Map { nav, .. }, Lane::Edge(on)) => {
                let len = nav.edges[on.edge].len();
                let p = if on.t + d <= len {
                    nav.at(OnEdge { t: on.t + d, ..on })
                } else if let Some((e, fwd)) = r.route.front().copied().or(r.next) {
                    nav.at(OnEdge {
                        edge: e,
                        forward: fwd,
                        t: (on.t + d - len).min(nav.edges[e].len()),
                    })
                } else {
                    nav.at(OnEdge { t: len, ..on })
                };
                [p.x - p.dz * r.lat, p.z + p.dx * r.lat]
            }
            (World::Endless(e), Lane::Endless { z, dir }) => {
                let zz = z + (dir * d) as f64;
                let slope = ((e.road_x(zz + 1.0) - e.road_x(zz - 1.0)) * 0.5) as f32;
                let l = (1.0 + slope * slope).sqrt();
                let (dx, dz) = (slope * dir / l, dir / l);
                [e.road_x(zz) as f32 - dz * r.lat, zz as f32 + dx * r.lat]
            }
            _ => [0.0, 0.0],
        }
    }

    #[cfg(test)]
    pub(crate) fn first_bad(&self, ph: &RoomPhysics) -> Option<u16> {
        self.bots.iter().find_map(|b| {
            let c = b.car.as_ref()?;
            let bad =
                c.vc.wheels()
                    .iter()
                    .any(|w| !w.suspension_rest_length.is_finite() || !w.raycast_info().suspension_length.is_finite())
                    || !ph.world.pw.bodies[c.body].linvel().is_finite();
            bad.then_some(b.id)
        })
    }

    /// Server physics, each physics step: every bot's car gets its driver's controls (from the AI's plan) and steps.
    /// Cars appear on demand, follow placements (spawn / respawn / back from a boat or a flight), stand parked while
    /// their bot walks, and leave the world while it sails or flies (those stay kinematic).
    pub fn drive_cars(&mut self, ph: &mut RoomPhysics, dt: f32) {
        if !self.physics {
            return;
        }
        for c in self.dead_cars.drain(..) {
            ph.bury(c);
        }
        ph.sweep();
        for b in self.bots.iter_mut() {
            let parked_car = if b.mode == Mode::Foot { b.parked } else { None };
            if b.mode != Mode::Car && parked_car.is_none() {
                if let Some(c) = b.car.as_mut() {
                    c.set_enabled(&mut ph.world, false);
                }
                continue;
            }
            let (px, pz, pyaw) = parked_car.map_or((b.x, b.z, b.yaw), |c| (c[0], c[1], c[2]));
            match b.car.as_mut() {
                None => {
                    let y = ph.ground(px, pz);
                    b.car = Some(ph.new_car(b.model, px, y, pz, pyaw));
                    self.built += 1;
                }
                Some(c) if b.placed || !c.enabled => {
                    self.set_down += 1;
                    c.set_enabled(&mut ph.world, true);
                    let y = ph.ground(px, pz) as f64;
                    c.place(&mut ph.world, px as f64, y, pz as f64, pyaw as f64, 0.0);
                }
                Some(_) => {}
            }
            b.placed = false;
            let car = b.car.as_mut().expect("just made");
            let pos = car.position(&ph.world);
            let heading = car.heading(&ph.world);
            car.controls = match (b.mode, b.plan) {
                (Mode::Car, Some((t, v))) => drive_to(
                    &Intent {
                        target: [t[0] as f64, t[1] as f64],
                        speed: v as f64,
                        boost: b.boost,
                    },
                    pos[0],
                    pos[2],
                    heading,
                    car.speed,
                ),
                // nobody at the wheel / nothing planned: brake, then park (brakes locked)
                _ => Controls {
                    throttle: if car.speed.abs() > 1.5 { -1.0 } else { 0.0 },
                    parked: car.speed.abs() <= 1.5,
                    ..Default::default()
                },
            };
            if car.controls.parked && ph.world.pw.bodies[car.body].is_sleeping() {
                continue; // a parked car at rest costs nothing
            }
            car.step(&mut ph.world, dt as f64);
            let ground = ph.ground(pos[0] as f32, pos[2] as f32) as f64;
            car.keep_above(&mut ph.world, ground);
        }
    }

    /// Server physics, after the tick's physics steps: each driving bot is where its car is — pose, speed, road
    /// progress (or off the road, thrown there) — and a car that doesn't move although its driver wants to is stuck.
    pub fn after_physics(&mut self, ph: &RoomPhysics, dt: f32, now: u64) {
        if !self.physics {
            return;
        }
        for i in 0..self.bots.len() {
            let b = &mut self.bots[i];
            let Some(c) = b.car.as_ref() else { continue };
            if b.mode != Mode::Car {
                continue;
            }
            let p = c.position(&ph.world);
            let ax = c.axes(&ph.world);
            let v = ph.world.pw.bodies[c.body].linvel();
            (b.x, b.y, b.z) = (p[0] as f32, p[1] as f32, p[2] as f32);
            b.yaw = (-ax.f[0]).atan2(-ax.f[2]) as f32;
            b.show_yaw = b.yaw;
            b.speed = c.speed as f32;
            b.pitch = ax.f[1].clamp(-1.0, 1.0).asin() as f32;
            b.roll = (-ax.r[1]).atan2(ax.u[1]) as f32;
            b.vel = [v.x, v.y, v.z];
            b.braking = c.drivetrain.braking || c.controls.parked;
            let wants = b.plan.is_some_and(|p| p.1 > 1.0);
            // road progress follows the car (the plan advanced it by the AI's own speed)
            if let Some(r) = b.road.as_ref() {
                let r = r.clone();
                let lane = self.reproject(&self.bots[i], &r);
                let b = &mut self.bots[i];
                match lane {
                    Some(l) => b.road.as_mut().expect("on a road").lane = l,
                    None => {
                        // thrown off the road: drive back to it
                        b.road = None;
                        b.path.clear();
                    }
                }
            }
            self.progress_check(i, dt, now, wants);
            self.write_pose(i, dt);
        }
    }

    /// Where on its lane the car really is: the nearest point of its edge within ±15 m of the AI's progress; None =
    /// more than 10 m off the road.
    fn reproject(&self, b: &Bot, r: &OnRoad) -> Option<Lane> {
        let (World::Map { nav, .. }, Lane::Edge(on)) = (&self.world, r.lane) else {
            return Some(r.lane);
        };
        let len = nav.edges[on.edge].len();
        let mut best = (f32::INFINITY, on.t);
        let mut t = (on.t - 15.0).max(0.0);
        while t <= (on.t + 15.0).min(len) {
            let p = nav.at(OnEdge { t, ..on });
            let d = (p.x - b.x).powi(2) + (p.z - b.z).powi(2);
            if d < best.0 {
                best = (d, t);
            }
            t += 1.0;
        }
        let half = nav.roads[nav.edges[on.edge].road].half_width;
        if best.0.sqrt() > half + 10.0 {
            return None;
        }
        Some(Lane::Edge(OnEdge { t: best.1, ..on }))
    }

    /// Direction of travel `d` m ahead on the road (following the planned way at the next node).
    fn ahead_dir(&self, r: &OnRoad, d: f32) -> (f32, f32) {
        match (&self.world, r.lane) {
            (World::Map { nav, .. }, Lane::Edge(on)) => {
                let len = nav.edges[on.edge].len();
                if on.t + d <= len {
                    let p = nav.at(OnEdge { t: on.t + d, ..on });
                    (p.dx, p.dz)
                } else if let Some((e, fwd)) = r.route.front().copied().or(r.next) {
                    let p = nav.at(OnEdge {
                        edge: e,
                        forward: fwd,
                        t: (on.t + d - len).min(nav.edges[e].len()),
                    });
                    (p.dx, p.dz)
                } else {
                    // a dead end: treat it as a hairpin (stop at the end)
                    let p = nav.at(OnEdge { t: len, ..on });
                    (-p.dx, -p.dz)
                }
            }
            (World::Endless(e), Lane::Endless { z, dir }) => {
                let zz = z + (dir * d) as f64;
                let slope = ((e.road_x(zz + 1.0) - e.road_x(zz - 1.0)) * 0.5) as f32;
                let l = (1.0 + slope * slope).sqrt();
                (slope * dir / l, dir / l)
            }
            _ => (0.0, -1.0),
        }
    }

    /// Nearest thing ahead in my lane within `range`: (gap m, its speed along my heading). People count (speed 0).
    fn leader(&self, b: &Bot, range: f32) -> Option<(f32, f32)> {
        let (fx, fz) = b.fwd();
        let mut best: Option<(f32, f32)> = None;
        let (ci, cj) = ((b.x / CELL).floor() as i32, (b.z / CELL).floor() as i32);
        let r = (range / CELL).ceil() as i32;
        for i in ci - r..=ci + r {
            for j in cj - r..=cj + r {
                let Some(v) = self.cells.get(&(i, j)) else { continue };
                for &k in v {
                    let s = &self.seen[k];
                    if s.id == b.id {
                        continue;
                    }
                    let (dx, dz) = (s.pose.pos[0] - b.x, s.pose.pos[2] - b.z);
                    let along = dx * fx + dz * fz;
                    if along <= 0.5 || along > range {
                        continue;
                    }
                    let lat = (dx * -fz + dz * fx).abs();
                    let driving = s.pose.flags & flags::DRIVING != 0;
                    let (ofx, ofz) = dir_of(s.pose.yaw);
                    let same_way = ofx * fx + ofz * fz > 0.3;
                    // vehicles going my way in my lane; anyone on foot in my path; (oncoming traffic is the other lane)
                    let hit = if driving { same_way && lat < 2.3 } else { lat < 2.0 };
                    if !hit || (s.pose.pos[1] - b.y).abs() > 6.0 {
                        continue;
                    }
                    let gap = along - if driving { 5.0 } else { 1.5 };
                    let v = if driving {
                        s.pose.vel[0] * fx + s.pose.vel[2] * fz
                    } else {
                        0.0
                    };
                    if best.is_none_or(|bb| gap < bb.0) {
                        best = Some((gap.max(0.1), v));
                    }
                }
            }
        }
        best
    }

    /// Oncoming traffic in the other lane within `range` ahead?
    fn oncoming(&self, b: &Bot, range: f32) -> bool {
        let (fx, fz) = b.fwd();
        let (ci, cj) = ((b.x / CELL).floor() as i32, (b.z / CELL).floor() as i32);
        let r = (range / CELL).ceil() as i32;
        for i in ci - r..=ci + r {
            for j in cj - r..=cj + r {
                let Some(v) = self.cells.get(&(i, j)) else { continue };
                for &k in v {
                    let s = &self.seen[k];
                    if s.id == b.id {
                        continue;
                    }
                    let (dx, dz) = (s.pose.pos[0] - b.x, s.pose.pos[2] - b.z);
                    let along = dx * fx + dz * fz;
                    let lat = dx * -fz + dz * fx; // + = right
                    if along > -10.0 && along < range && lat < 1.0 && lat > -7.0 {
                        let (ofx, ofz) = dir_of(s.pose.yaw);
                        if ofx * fx + ofz * fz < 0.3 || s.pose.flags & flags::DRIVING == 0 {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// One bot's movement for `dt`.
    fn drive(&mut self, i: usize, dt: f32, now: u64) {
        let act = self.bots[i].act.clone();
        // followers chase a trail (any mode)
        if let Act::Convoy { leader } | Act::Hangout { who: leader } = act {
            let moving = self.chase(i, leader, dt, matches!(act, Act::Hangout { .. }));
            self.stuck_check(i, dt, now, moving);
            return;
        }
        let racing = self.race_of(&self.bots[i]).map(|r| r.stage.clone());
        let hold = matches!(act, Act::Afk | Act::Down)
            || matches!(racing, Some(RaceStage::Countdown(_)))
            || (matches!(act, Act::Stroll { stage: 0, .. }) && self.bots[i].road.is_some());
        if self.bots[i].road.is_some() && self.bots[i].mode == Mode::Car {
            self.drive_road(i, dt, hold, racing.as_ref());
            self.stuck_check(i, dt, now, false);
            return;
        }
        // free movement along the path (off-road, water, air, on foot)
        let mode = self.bots[i].mode;
        let air_alt = if let Act::Fly { alt, stage, .. } = &act {
            Some((*alt, *stage))
        } else {
            None
        };
        let want = match mode {
            Mode::Foot => {
                if matches!(act, Act::Down) {
                    0.0
                } else if matches!(act, Act::Stroll { stage: 1, .. }) && self.bots[i].act_until > now + 50_000 {
                    3.6 // just got up from a knock-down: running
                } else {
                    1.45 + self.bots[i].p.aggr * 0.5
                }
            }
            Mode::Car => 10.0 + self.bots[i].p.aggr * 6.0,
            Mode::Boat => 9.0 + self.bots[i].p.aggr * 7.0,
            Mode::Air => 28.0 + self.bots[i].p.aggr * 14.0,
        };
        if hold || self.bots[i].path.is_empty() {
            self.free_move(i, dt, None, 0.0, air_alt);
            // a car off the road with nothing to do: find the road again
            let b = &self.bots[i];
            if b.mode == Mode::Car && b.road.is_none() && b.path.is_empty() && !hold {
                self.head_for_road(i);
            }
        } else {
            let t = *self.bots[i].path.front().expect("non-empty");
            let arrive = if mode == Mode::Foot {
                1.2
            } else if mode == Mode::Air {
                40.0
            } else {
                6.0
            };
            self.free_move(i, dt, Some(t), want, air_alt);
            let b = &mut self.bots[i];
            if (b.x - t[0]).powi(2) + (b.z - t[1]).powi(2) < arrive * arrive {
                b.path.pop_front();
            }
            self.try_join_road(i);
        }
        self.stuck_check(i, dt, now, !hold && !self.bots[i].path.is_empty());
    }

    /// Off the road with nowhere to go: drive to the nearest road.
    fn head_for_road(&mut self, i: usize) {
        let (x, z) = (self.bots[i].x, self.bots[i].z);
        let target = match &self.world {
            World::Map { nav, .. } => nav.nearest(x, z, 1500.0).map(|(e, t, _)| {
                let p = nav.at(OnEdge {
                    edge: e,
                    forward: true,
                    t,
                });
                [p.x, p.z]
            }),
            World::Endless(e) => Some([e.road_x(z as f64) as f32, z + dir_of(self.bots[i].yaw).1 * 10.0]),
        };
        if let Some(t) = target {
            self.bots[i].path.push_back(t);
        }
    }

    /// A car off the road reaching one (and not on its way somewhere else): onto it, in the lane matching its heading.
    fn try_join_road(&mut self, i: usize) {
        let b = &self.bots[i];
        if b.mode != Mode::Car || b.road.is_some() || b.path.len() > 1 {
            return;
        }
        if !matches!(
            b.act,
            Act::Cruise | Act::Race { .. } | Act::Fly { .. } | Act::Boat { .. }
        ) {
            return;
        }
        let (fx, fz) = b.fwd();
        let lane = match &self.world {
            World::Map { nav, .. } => {
                let Some((e, t, d)) = nav.nearest(b.x, b.z, 7.0) else {
                    return;
                };
                let _ = d;
                let p = nav.at(OnEdge {
                    edge: e,
                    forward: true,
                    t,
                });
                let forward = p.dx * fx + p.dz * fz >= 0.0;
                let len = nav.edges[e].len();
                Lane::Edge(OnEdge {
                    edge: e,
                    forward,
                    t: if forward { t } else { len - t },
                })
            }
            World::Endless(e) => {
                if (b.x as f64 - e.road_x(b.z as f64)).abs() > 6.0 {
                    return;
                }
                Lane::Endless {
                    z: b.z as f64,
                    dir: if fz >= 0.0 { 1.0 } else { -1.0 },
                }
            }
        };
        let lw = self.lane_width(b);
        let b = &mut self.bots[i];
        b.road = Some(OnRoad {
            lane,
            lat: 0.0,
            lat_to: lw,
            next: None,
            route: VecDeque::new(),
            overtake: 0.0,
        });
        b.path.clear();
        if matches!(b.act, Act::Boat { .. } | Act::Fly { .. }) {
            b.act = Act::Cruise;
        }
    }

    /// Lane driving: speed from the bends ahead, the car in front (IDM), overtaking, junctions.
    fn drive_road(&mut self, i: usize, dt: f32, hold: bool, race: Option<&RaceStage>) {
        let racing = matches!(race, Some(RaceStage::Run));
        let gathering = matches!(race, Some(RaceStage::Gather));
        let (aggr, speed) = (self.bots[i].p.aggr, self.bots[i].speed);
        let r = self.bots[i].road.clone().expect("on a road");
        // ---- target speed: the road's, the bends ahead
        let road_v = match (&self.world, r.lane) {
            (World::Map { nav, .. }, Lane::Edge(on)) => nav.roads[nav.edges[on.edge].road].speed(),
            _ => 24.0,
        };
        let mut v0 = road_v * (0.82 + aggr * 0.3) * if racing { 1.35 } else { 1.0 };
        let a_lat = if racing { 6.5 } else { 3.2 + aggr * 1.8 };
        let (dx0, dz0) = self.ahead_dir(&r, 0.0);
        for d in [6.0f32, 14.0, 26.0, 42.0, 64.0] {
            let (dx, dz) = self.ahead_dir(&r, d);
            let cos = (dx * dx0 + dz * dz0).clamp(-1.0, 1.0);
            let ang = cos.acos();
            if ang > 0.02 {
                let vc = (a_lat * d.max(8.0) / ang).sqrt();
                // what we can brake to by then
                let v_allowed = (vc * vc + 2.0 * 3.5 * (d - 6.0).max(0.0)).sqrt();
                v0 = v0.min(v_allowed.max(4.0));
            }
        }
        // a dead end ahead: come to a stop at the end (then U-turn)
        let to_end = match (&self.world, r.lane) {
            (World::Map { nav, .. }, Lane::Edge(on)) => {
                let end = nav.end_node(on);
                let more = r.route.front().is_some() || nav.nodes[end].out.len() > 1;
                if more {
                    f32::INFINITY
                } else {
                    nav.edges[on.edge].len() - on.t
                }
            }
            _ => f32::INFINITY,
        };
        let to_end = match (&self.world, r.lane) {
            (World::Map { nav, .. }, Lane::Edge(on)) if gathering && r.route.is_empty() => {
                to_end.min(nav.edges[on.edge].len() - on.t - 4.0)
            }
            _ => to_end,
        };
        if to_end < 80.0 {
            v0 = v0.min((2.0 * 3.0 * (to_end - 3.0).max(0.0)).sqrt());
        }
        // gathering for a race: stop at the start line
        if gathering && r.route.is_empty() {
            let race = self.race_of(&self.bots[i]).cloned();
            if let Some(race) = race {
                let (gx, gz) = self.start_point(&race);
                let b = &self.bots[i];
                let d = ((b.x - gx).powi(2) + (b.z - gz).powi(2)).sqrt();
                if matches!(self.world, World::Endless(_)) && d < 60.0 {
                    v0 = v0.min((2.0 * 3.0 * (d - 8.0).max(0.0)).sqrt());
                }
            }
        }
        if hold
            || (matches!(self.bots[i].act, Act::Stroll { stage: 0, .. } | Act::Afk) && (r.lat - r.lat_to).abs() < 0.3)
        {
            v0 = if hold && (r.lat - r.lat_to).abs() > 0.3 {
                3.0
            } else {
                0.0
            };
        }
        // ---- the car in front (Intelligent Driver Model)
        let b = &self.bots[i];
        let (amax, bcomf, th) = if racing {
            (4.5, 6.0, 0.6)
        } else {
            (2.0 + aggr, 3.0, 1.6 - aggr * 0.7)
        };
        let mut acc = amax * (1.0 - (speed / v0.max(0.1)).powi(4));
        if v0 < 0.1 {
            acc = -bcomf * 1.5;
        }
        let lead = self.leader(b, 90.0);
        let mut blocked_by_slow = false;
        if let Some((gap, lv)) = lead {
            let dv = speed - lv;
            let s_star = 4.0 + speed * th + speed * dv / (2.0 * (amax * bcomf).sqrt());
            acc -= amax * (s_star.max(0.0) / gap).powi(2);
            blocked_by_slow = lv < v0 - 3.0 && gap < 30.0;
        }
        let acc = acc.clamp(-8.0, amax);
        let mut r = r;
        // ---- overtaking: someone slow ahead, the other lane clear, a straight road
        let lw = self.lane_width(b);
        let straight = {
            let (dx, dz) = self.ahead_dir(&r, 80.0);
            dx * dx0 + dz * dz0 > 0.97
        };
        if r.overtake > 0.0 {
            r.overtake += dt;
            let done = lead.is_none_or(|(g, _)| g > 25.0) && r.overtake > 4.0;
            if done || r.overtake > 14.0 || self.oncoming(b, 60.0) {
                r.overtake = 0.0;
                r.lat_to = lw;
            }
        } else if blocked_by_slow
            && (aggr > 0.35 || racing || lead.is_some_and(|l| l.1 < 0.5))
            && straight
            && !self.oncoming(b, 160.0)
        {
            r.overtake = 0.01;
            r.lat_to = -lw;
        }
        if !matches!(self.bots[i].act, Act::Stroll { stage: 0, .. } | Act::Afk)
            && r.overtake == 0.0
            && (r.lat_to - lw).abs() > 0.01
            && r.lat_to > lw
        {
            // back from the shoulder into the lane
            r.lat_to = lw;
        }
        // lane change speed
        let dl = r.lat_to - r.lat;
        r.lat += dl.clamp(-1.6 * dt, 1.6 * dt);
        // ---- advance
        let b = &mut self.bots[i];
        let new_speed = (speed + acc * dt).max(0.0);
        b.braking = acc < -1.5 || new_speed < 0.2;
        b.boost = racing && acc > amax * 0.5;
        let dist = (speed + new_speed) * 0.5 * dt;
        b.speed = new_speed;
        let mut uturn = false;
        match (&self.world, &mut r.lane) {
            (World::Map { nav, .. }, Lane::Edge(on)) => {
                on.t += dist;
                let mut guard = 0;
                while on.t > nav.edges[on.edge].len() && guard < 8 {
                    guard += 1;
                    let over = on.t - nav.edges[on.edge].len();
                    let node = nav.end_node(*on);
                    let next = r
                        .route
                        .pop_front()
                        .or(r.next.take())
                        .or_else(|| pick_way(nav, node, *on, &mut self.rng));
                    match next {
                        Some((e, fwd)) => {
                            *on = OnEdge {
                                edge: e,
                                forward: fwd,
                                t: over,
                            }
                        }
                        None => {
                            // dead end: turn round
                            on.forward = !on.forward;
                            on.t = 0.0;
                            uturn = true;
                            break;
                        }
                    }
                }
                // choose the way on at the next junction ahead of time (the bend speed looks at it)
                if r.next.is_none() && r.route.is_empty() && nav.edges[on.edge].len() - on.t < 90.0 {
                    let node = nav.end_node(*on);
                    r.next = pick_way(nav, node, *on, &mut self.rng);
                }
            }
            (World::Endless(e), Lane::Endless { z, dir }) => {
                let slope = (e.road_x(*z + 1.0) - e.road_x(*z - 1.0)) * 0.5;
                *z += (*dir * dist) as f64 / (1.0 + slope * slope).sqrt();
            }
            _ => {}
        }
        if uturn {
            b.speed = 0.0;
            r.lat = -r.lat;
        }
        b.road = Some(r);
        let mut bb = std::mem::replace(&mut self.bots[i], Bot::placeholder());
        self.snap_to_road(&mut bb);
        if uturn {
            // (the shown heading swings round over the next second)
            bb.show_yaw = wrap(bb.yaw + PI * 0.9);
        }
        self.bots[i] = bb;
        if self.physics {
            // the driver's target: the lane ahead of the plan; its speed: where the AI's acceleration is taking it
            // over the next ~1.2 s (an IDM stop → 0 → brakes)
            let look = 4.0 + speed.abs() * 0.6;
            let r = self.bots[i].road.as_ref().expect("on a road");
            let target = self.lane_point_ahead(r, look);
            let want = if v0 < 0.1 {
                0.0
            } else {
                (speed + acc * 1.2).clamp(0.0, v0)
            };
            self.bots[i].plan = Some((target, want));
        }
    }

    /// Point steering toward `target` at up to `want` m/s in the bot's current mode, with terrain checks and the
    /// car ⇄ boat switch at the water's edge. None: slow to a stop.
    fn free_move(&mut self, i: usize, dt: f32, target: Option<[f32; 2]>, want: f32, air: Option<(f32, u8)>) {
        let mode = self.bots[i].mode;
        let (x, z, yaw, speed) = {
            let b = &self.bots[i];
            (b.x, b.z, b.yaw, b.speed)
        };
        let mut desired = yaw;
        let mut v_want = 0.0;
        if let Some(t) = target {
            let (dx, dz) = (t[0] - x, t[1] - z);
            let dist = (dx * dx + dz * dz).sqrt();
            desired = yaw_of(dx, dz);
            let err = wrap(desired - yaw).abs();
            // slow for sharp turns and on arrival
            v_want = want * (1.0 - (err / PI).min(1.0) * 0.8);
            if mode != Mode::Air {
                v_want = v_want.min((2.0 * 2.5 * dist).sqrt() + 1.0);
            }
            // terrain ahead: steer round slopes / water / land (boats)
            if mode != Mode::Air {
                let look = (speed * 1.2).clamp(4.0, 14.0);
                let mut ok = false;
                for off in [0.0f32, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6] {
                    let a = desired + off;
                    let (fx, fz) = dir_of(a);
                    let (nx, nz) = (x + fx * look, z + fz * look);
                    if self.can_go(mode, x, z, nx, nz) {
                        desired = a;
                        ok = true;
                        break;
                    }
                }
                if !ok {
                    v_want = 0.0;
                    desired = wrap(yaw + 0.8);
                }
            }
        }
        if self.physics && mode == Mode::Car {
            let (fx, fz) = dir_of(desired);
            let look = (speed * 1.2).clamp(6.0, 16.0);
            self.bots[i].plan = Some(([x + fx * look, z + fz * look], v_want));
        }
        // turn: people turn on the spot, vehicles by their turning circle
        let max_turn = match mode {
            Mode::Foot => 5.0,
            Mode::Air => 0.6,
            _ => (speed / 7.0).clamp(0.25, 1.2),
        };
        let err = wrap(desired - yaw);
        let new_yaw = wrap(yaw + err.clamp(-max_turn * dt, max_turn * dt));
        let acc = match mode {
            Mode::Foot => 6.0,
            Mode::Car => 3.0,
            Mode::Boat => 1.8,
            Mode::Air => 4.0,
        };
        let new_speed = if v_want > speed {
            (speed + acc * dt).min(v_want)
        } else {
            (speed - acc * 1.6 * dt).max(v_want)
        };
        let (fx, fz) = dir_of(new_yaw);
        let d = (speed + new_speed) * 0.5 * dt;
        let (nx, nz) = (x + fx * d, z + fz * d);
        let world_ok = mode == Mode::Air || self.can_go(mode, x, z, nx, nz) || d < 0.01;
        let b = &mut self.bots[i];
        b.yaw = new_yaw;
        b.speed = if world_ok { new_speed } else { 0.0 };
        b.braking = new_speed < speed - 0.5 * dt || new_speed < 0.2;
        b.boost = mode == Mode::Foot && new_speed > 3.0;
        if world_ok {
            b.x = nx;
            b.z = nz;
        }
        // height / mode
        match b.mode {
            Mode::Air => {
                let ground = self.world.ground(b.x, b.z);
                let (alt, landing) = air.map_or((ground + 60.0, true), |(a, s)| (a, s == 1));
                let goal = if landing && b.path.len() <= 1 {
                    let t = b.path.front().copied().unwrap_or([b.x, b.z]);
                    let d = ((t[0] - b.x).powi(2) + (t[1] - b.z).powi(2)).sqrt();
                    // glide down over the last ~400 m
                    ground + (alt - ground) * (d / 400.0).min(1.0)
                } else {
                    alt
                };
                let vy_want = ((goal - b.y) * 0.5).clamp(-10.0, 12.0);
                b.vy += (vy_want - b.vy).clamp(-6.0 * dt, 6.0 * dt);
                b.y += b.vy * dt;
                if b.y < ground + 1.0 {
                    b.y = ground;
                    if landing {
                        b.mode = Mode::Car;
                        b.vy = 0.0;
                    } else {
                        b.y = ground + 1.0;
                    }
                }
            }
            Mode::Boat => {
                b.y = WATER + 0.3;
                if !self.world.water(b.x, b.z) {
                    b.mode = Mode::Car;
                    b.y = self.world.ground(b.x, b.z);
                }
            }
            Mode::Car => {
                if self.world.water(b.x, b.z) {
                    b.mode = Mode::Boat;
                    b.y = WATER + 0.3;
                } else {
                    b.y = self.world.ground(b.x, b.z);
                }
            }
            Mode::Foot => b.y = self.world.ground(b.x, b.z),
        }
    }

    /// Can this mode move from a to b?
    fn can_go(&self, mode: Mode, ax: f32, az: f32, bx: f32, bz: f32) -> bool {
        let wet = self.world.water(bx, bz);
        match mode {
            Mode::Air => true,
            Mode::Foot => !wet && self.world.passable(ax, az, bx, bz, true),
            // a car drives into the water (it floats): only the slope matters; a boat lands where the shore is gentle
            Mode::Car => wet || self.world.passable(ax, az, bx, bz, false),
            Mode::Boat => wet || self.world.passable(ax, az, bx, bz, false),
        }
    }

    /// Follow another player's trail (convoy, hanging out): match their mode, keep a gap.
    fn chase(&mut self, i: usize, leader: u16, dt: f32, hangout: bool) -> bool {
        let Some(lp) = self.seen.iter().find(|s| s.id == leader).map(|s| s.pose) else {
            return false;
        };
        let leader_foot = lp.flags & flags::DRIVING == 0;
        let leader_air = lp.flags & flags::FLYING != 0;
        let lspeed = hspeed(&lp);
        // hanging out with someone on foot: park near them, get out, walk up, stand with them
        if hangout && leader_foot {
            let (bx, bz) = (self.bots[i].x, self.bots[i].z);
            let d = ((lp.pos[0] - bx).powi(2) + (lp.pos[2] - bz).powi(2)).sqrt();
            if self.bots[i].mode != Mode::Foot {
                if d < 14.0 || self.bots[i].mode == Mode::Car && d < 20.0 && self.bots[i].speed < 1.0 {
                    let b = &mut self.bots[i];
                    if b.mode == Mode::Car {
                        b.parked = Some([b.x, b.z, b.yaw]);
                        b.mode = Mode::Foot;
                        b.road = None;
                        b.speed = 0.0;
                    }
                } else {
                    let b = &mut self.bots[i];
                    b.road = None;
                    let tx = lp.pos[0];
                    let tz = lp.pos[2];
                    self.free_move(i, dt, Some([tx, tz]), 12.0, None);
                    return true;
                }
            }
            // on foot: walk up to ~2.5 m and face them
            let stand = d < 2.8;
            let target = if stand { None } else { Some([lp.pos[0], lp.pos[2]]) };
            let run = if d > 12.0 { 3.6 } else { 1.6 };
            self.free_move(i, dt, target, run, None);
            if stand {
                let b = &mut self.bots[i];
                b.yaw = yaw_of(lp.pos[0] - b.x, lp.pos[2] - b.z);
            }
            return !stand;
        }
        // in a vehicle: back to the car first if walking
        if self.bots[i].mode == Mode::Foot {
            if let Some(c) = self.bots[i].parked {
                self.free_move(i, dt, Some([c[0], c[1]]), 3.6, None);
                let b = &mut self.bots[i];
                if (b.x - c[0]).powi(2) + (b.z - c[1]).powi(2) < 4.0 {
                    b.parked = None;
                    b.mode = Mode::Car;
                    b.yaw = c[2];
                }
                return true;
            }
            self.bots[i].mode = Mode::Car;
        }
        // the trail: chase a breadcrumb ~lookahead ahead of us, keep `gap` m behind the leader along it
        let Some((trail, head)) = self.trails.get(&leader) else {
            self.free_move(i, dt, Some([lp.pos[0], lp.pos[2]]), lspeed.max(6.0), None);
            return true;
        };
        let first = head - trail.len() as u64 + 1;
        let b = &self.bots[i];
        let mut cur = b.cursor.max(first);
        let look = 6.0 + b.speed * 0.6;
        while cur < *head {
            let p = trail[(cur - first) as usize];
            if (p[0] - b.x).powi(2) + (p[2] - b.z).powi(2) > look * look {
                break;
            }
            cur += 1;
        }
        // trail length from the cursor to the leader ≈ steps × TRAIL_STEP
        let along = (*head - cur) as f32 * TRAIL_STEP
            + ((trail[(cur - first) as usize][0] - b.x).powi(2) + (trail[(cur - first) as usize][2] - b.z).powi(2))
                .sqrt();
        let gap = if leader_air { 40.0 } else { 14.0 + b.p.calm * 8.0 };
        let want = (lspeed + (along - gap) * 0.5).clamp(0.0, 45.0);
        let t = trail[(cur - first) as usize];
        let target = [t[0], t[2]];
        let leader_mode = t[3];
        let b = &mut self.bots[i];
        b.cursor = cur;
        b.road = None;
        // the leader took off: so do we (if the room allows); landed: come down
        if leader_air && self.flying && b.mode != Mode::Air {
            b.mode = Mode::Air;
            b.vy = 4.0;
        }
        let alt = if b.mode == Mode::Air {
            Some((lp.pos[1].max(t[1]), if leader_mode >= 3.0 { 0 } else { 1 }))
        } else {
            None
        };
        self.free_move(i, dt, Some(target), want, alt);
        want > 1.0
    }

    /// No progress for a while although it wants to move → "R": back on the nearest road.
    fn stuck_check(&mut self, i: usize, dt: f32, now: u64, moving: bool) {
        if self.physics && self.bots[i].mode == Mode::Car && self.bots[i].car.is_some() {
            return; // a physical car: checked where it really is (after_physics)
        }
        self.progress_check(i, dt, now, moving);
    }

    fn progress_check(&mut self, i: usize, dt: f32, now: u64, moving: bool) {
        let b = &mut self.bots[i];
        if !moving || b.mode == Mode::Air {
            b.prog = ([b.x, b.z], 0.0);
            return;
        }
        b.prog.1 += dt;
        let moved = (b.x - b.prog.0[0]).powi(2) + (b.z - b.prog.0[1]).powi(2);
        if moved > 4.0 {
            b.prog = ([b.x, b.z], 0.0);
            return;
        }
        if b.prog.1 < 6.0 {
            return;
        }
        // respawn
        self.stats.respawns += 1;
        let b = &mut self.bots[i];
        let (x, z) = (b.x, b.z);
        let walker = b.mode == Mode::Foot;
        let mut bb = std::mem::replace(&mut self.bots[i], Bot::placeholder());
        if walker {
            // a person: hop to a nearby clear spot
            bb.path.clear();
            bb.x += 2.0;
            bb.prog = ([bb.x, bb.z], 0.0);
        } else {
            self.place_on_road(&mut bb, [x, z], 0.0);
            if !matches!(bb.act, Act::Race { .. }) {
                bb.act = Act::Cruise;
                bb.act_until = now + 60_000;
            }
            bb.speed = 0.0;
        }
        self.bots[i] = bb;
    }

    /// The wire pose from the bot's state.
    fn write_pose(&mut self, i: usize, dt: f32) {
        let b = &mut self.bots[i];
        // the shown heading turns smoothly (U-turns, junction snaps); dt 0 = snap
        let rate = if b.mode == Mode::Foot { 10.0 } else { 3.0 };
        let e = wrap(b.yaw - b.show_yaw);
        b.show_yaw = if dt <= 0.0 {
            b.yaw
        } else {
            wrap(b.show_yaw + e.clamp(-rate * dt, rate * dt))
        };
        let (fx, fz) = dir_of(b.yaw);
        let physical = b.car.is_some() && b.mode == Mode::Car;
        let pitch = match b.mode {
            Mode::Air => (b.vy / b.speed.max(5.0)).atan(),
            Mode::Boat => (b.speed * 0.012).min(0.12),
            Mode::Car if physical => b.pitch,
            _ => 0.0,
        };
        let mut fl = 0u8;
        let model = match b.mode {
            Mode::Foot => {
                if b.boost {
                    fl |= flags::BOOST;
                }
                0
            }
            Mode::Car => {
                fl |= flags::DRIVING | flags::LIGHTS;
                b.model
            }
            Mode::Boat => {
                fl |= flags::DRIVING | flags::BOAT | flags::LIGHTS;
                b.model
            }
            Mode::Air => {
                fl |= flags::DRIVING | flags::FLYING | flags::AIRBORNE | flags::LIGHTS;
                b.model
            }
        };
        if b.mode != Mode::Foot {
            if b.braking {
                fl |= flags::BRAKING;
            }
            if b.boost {
                fl |= flags::BOOST;
            }
        }
        b.pose = Pose {
            pos: [b.x, b.y, b.z],
            vel: if physical {
                b.vel
            } else {
                [fx * b.speed, if b.mode == Mode::Air { b.vy } else { 0.0 }, fz * b.speed]
            },
            yaw: b.show_yaw,
            pitch,
            roll: if physical { b.roll } else { 0.0 },
            flags: fl,
            model,
        };
    }
}

/// The shoulder (pulling over): just past the road edge on the right.
fn self_shoulder(world: &World, r: &OnRoad) -> f32 {
    match (world, r.lane) {
        (World::Map { nav, .. }, Lane::Edge(on)) => nav.roads[nav.edges[on.edge].road].half_width + 1.6,
        _ => 4.2,
    }
}

/// The way on at `node` arriving along `on`: mostly the straightest, sometimes a turn; never straight back unless
/// it's a dead end (None).
fn pick_way(nav: &Nav, node: usize, on: OnEdge, rng: &mut Rng) -> Option<(usize, bool)> {
    let end = nav.at(OnEdge {
        t: nav.edges[on.edge].len(),
        ..on
    });
    let opts: Vec<(usize, bool, f32)> = nav.nodes[node]
        .out
        .iter()
        .filter(|&&(e, fwd)| !(e == on.edge && fwd != on.forward))
        .map(|&(e, fwd)| {
            let p = nav.at(OnEdge {
                edge: e,
                forward: fwd,
                t: 4.0f32.min(nav.edges[e].len()),
            });
            let cos = p.dx * end.dx + p.dz * end.dz;
            // straight on is likeliest; a highway a little more so
            let hw = if nav.roads[nav.edges[e].road].class == "highway" {
                1.3
            } else {
                1.0
            };
            (e, fwd, ((1.0 + cos) * (1.0 + cos) + 0.15) * hw)
        })
        .collect();
    if opts.is_empty() {
        return None;
    }
    let total: f32 = opts.iter().map(|o| o.2).sum();
    let mut r = rng.f32() * total;
    for o in &opts {
        r -= o.2;
        if r <= 0.0 {
            return Some((o.0, o.1));
        }
    }
    opts.last().map(|o| (o.0, o.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn humans(at: &[[f32; 2]]) -> Vec<Seen> {
        at.iter()
            .enumerate()
            .map(|(k, p)| Seen {
                id: k as u16 + 1,
                pose: Pose {
                    pos: [p[0], 0.0, p[1]],
                    ..Default::default()
                },
                bot: false,
            })
            .collect()
    }

    fn run(bots: &mut Bots, people: &[Seen], secs: f32) -> Vec<BotEvent> {
        let mut ev = Vec::new();
        let mut now = 1000u64;
        let steps = (secs * 30.0) as usize;
        for _ in 0..steps {
            now += 33;
            let mut all: Vec<Seen> = people.to_vec();
            all.extend(bots.bots.iter().map(|b| Seen {
                id: b.id,
                pose: b.pose,
                bot: true,
            }));
            bots.step(1.0 / 30.0, now, &all, &mut ev);
        }
        ev
    }

    #[test]
    fn endless_bots_drive_the_road_and_keep_to_it() {
        let mut b = Bots::new(World::Endless(Box::new(Endless::new(7))), 1);
        b.configure(30, true);
        let people = humans(&[[0.0, 0.0]]);
        let ev = run(&mut b, &people, 40.0);
        assert_eq!(b.bots.len(), 30);
        assert_eq!(ev.iter().filter(|e| matches!(e, BotEvent::Joined(..))).count(), 30);
        let e = Endless::new(7);
        let mut on_road = 0;
        let mut moving = 0;
        for bot in &b.bots {
            assert!(bot.pose.pos.iter().all(|v| v.is_finite()));
            if bot.road.is_some() {
                let off = (bot.x as f64 - e.road_x(bot.z as f64)).abs();
                assert!(off < 7.0, "{} is {off} m off the road", bot.name);
                on_road += 1;
            }
            if bot.speed > 3.0 {
                moving += 1;
            }
        }
        assert!(on_road >= 15, "{on_road} on the road");
        assert!(moving >= 10, "{moving} moving");
        // fewer bots: the extra ones leave
        b.configure(10, true);
        let ev = run(&mut b, &people, 1.0);
        assert_eq!(b.bots.len(), 10);
        assert_eq!(ev.iter().filter(|e| matches!(e, BotEvent::Left(..))).count(), 20);
    }

    #[test]
    fn island_bots_cruise_race_and_never_go_wild() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        if !dir.exists() {
            return;
        }
        let map = Arc::new(MapData::load(&dir).unwrap());
        let mut b = Bots::new(World::for_map(map.clone()), 9);
        b.configure(60, true);
        let people = humans(&[[map.lobby[0], map.lobby[1]], [300.0, 300.0]]);
        let t = std::time::Instant::now();
        let mut seen_acts: HashMap<&'static str, usize> = HashMap::new();
        let mut ev = Vec::new();
        let mut now = 1000u64;
        let mut max_tick = 0f64;
        for step in 0..(30 * 240) {
            now += 33;
            let mut all: Vec<Seen> = people.to_vec();
            all.extend(b.bots.iter().map(|x| Seen {
                id: x.id,
                pose: x.pose,
                bot: true,
            }));
            let t0 = std::time::Instant::now();
            b.step(1.0 / 30.0, now, &all, &mut ev);
            max_tick = max_tick.max(t0.elapsed().as_secs_f64());
            if step % 30 == 0 {
                for x in &b.bots {
                    let k = match (&x.act, x.mode) {
                        (_, Mode::Air) => "air",
                        (_, Mode::Boat) => "boat",
                        (_, Mode::Foot) => "foot",
                        (Act::Race { .. }, _) => "race",
                        (Act::Convoy { .. }, _) => "convoy",
                        (Act::Explore { .. }, _) => "explore",
                        _ => "road",
                    };
                    *seen_acts.entry(k).or_default() += 1;
                }
            }
            for x in &b.bots {
                assert!(x.pose.pos.iter().all(|v| v.is_finite()), "{} not finite", x.name);
                assert!(x.speed <= 60.0, "{} at {} m/s", x.name, x.speed);
                if x.mode != Mode::Air {
                    assert!(
                        x.x.abs() < map.half + 500.0 && x.z.abs() < map.half + 500.0,
                        "{} left the map",
                        x.name
                    );
                }
            }
        }
        eprintln!(
            "4 min of 60 island bots: {:?} (activity-seconds), {:.1} s total, worst tick {:.2} ms",
            seen_acts,
            t.elapsed().as_secs_f32(),
            max_tick * 1000.0
        );
        eprintln!("{:?}", b.stats);
        assert!(seen_acts.get("road").copied().unwrap_or(0) > 0);
        let variety = seen_acts.len();
        assert!(variety >= 4, "only {variety} kinds of activity: {seen_acts:?}");
    }
}
