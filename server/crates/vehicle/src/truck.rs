//! A car — a port of the game's `TruckSim` (`game/src/gameplay/vehicle/VehicleSim.ts`) in its default *Simulation*
//! handling (`mode 'drivetrain'`): a Rapier dynamic body + `DynamicRayCastVehicleController` used for springs and wheel
//! contacts only; our damper, anti-roll bars, bump / hard stops, tyre envelope and the [`Drivetrain`]'s tyre forces
//! (applied at the contact points), aero drag, the cornering assist, the off-road climb assist and auto-righting.
//!
//! Not ported (yet): the legacy / ARCADE handling, the hover flight, the boat, the exact body trimesh (`unhook`,
//! dents) — see `docs/VEHICLE_PHYSICS.md`. The math runs in f64 like the game's (JS numbers), Rapier in f32.

#![allow(clippy::needless_range_loop)]

use crate::drivetrain::{ChassisIn, DriverInput, Drivetrain, WheelIn, sign};
use crate::spec::{AidLevel, CarDef, Locker, TruckDims, TruckTune};
use crate::tyre::{SurfaceMix, grip_for, roughness, surf, tyre_kind};
use crate::world::{GRAVITY, World, group, groups};
use rapier3d::control::{DynamicRayCastVehicleController, WheelTuning};
use rapier3d::prelude::*;

const G_REAL: f64 = 9.81;
const SLOPE_EFF: f64 = 0.45;
const FRAME_LO: f64 = 0.34;
const FRAME_HI: f64 = 0.74;
const DAMP_KNEE: f64 = 0.5;
const DAMP_HIGH: f64 = 0.5;
const ENV_D: [f64; 7] = [0.0, 0.35, -0.35, 0.7, -0.7, 0.93, -0.93];
pub const RIDE_MAX: f64 = 1.0;

fn ray_groups() -> InteractionGroups {
    group(0xffff, groups::TERRAIN | groups::STATIC)
}
fn ground_groups() -> InteractionGroups {
    group(0xffff, groups::TERRAIN | groups::STATIC_MESH)
}

/// The driver's controls (`Controls`, VehicleSim.ts).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Controls {
    pub parked: bool,
    pub throttle: f64,
    pub steer: f64,
    pub handbrake: bool,
    pub boost: bool,
    pub brake: bool,
    pub foot_brake: f64,
    pub lift: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WheelState {
    pub lift: f64,
    pub spin: f64,
    pub steer: f64,
    pub contact: bool,
}

type V3 = [f64; 3];
/// Surface sampler: world (x, z) → the mix under it.
pub type SurfaceFn = Box<dyn Fn(f64, f64, &mut SurfaceMix) + Send + Sync>;

fn v3(v: Vector) -> V3 {
    [v.x as f64, v.y as f64, v.z as f64]
}
fn vf(v: V3) -> Vector {
    Vector::new(v[0] as f32, v[1] as f32, v[2] as f32)
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// v' = q v q* — the game's `axes()` rotate (f64 from the f32 quaternion).
fn rotate(q: [f64; 4], x: f64, y: f64, z: f64) -> V3 {
    let [qx, qy, qz, qw] = q;
    let ix = qw * x + qy * z - qz * y;
    let iy = qw * y + qz * x - qx * z;
    let iz = qw * z + qx * y - qy * x;
    let iw = -qx * x - qy * y - qz * z;
    [
        ix * qw + iw * -qx + iy * -qz - iz * -qy,
        iy * qw + iw * -qy + iz * -qx - ix * -qz,
        iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ]
}

/// Chassis axes: forward (−Z), up, right.
#[derive(Clone, Copy, Debug)]
pub struct Axes {
    pub f: V3,
    pub u: V3,
    pub r: V3,
}

struct BoxSpec {
    half: V3,
    at: V3,
    mass: f64,
}

/// The truck's low frame boxes (`frameBoxes`).
fn frame_boxes(d: &TruckDims, mass: f64) -> Vec<BoxSpec> {
    let h = d.half;
    let r = d.wheel_radius;
    let zf = d.wheel_pos[0][2].min(d.wheel_pos[1][2]);
    let zr = d.wheel_pos[2][2].max(d.wheel_pos[3][2]);
    let inner = (d.wheel_pos.iter().map(|p| p[0].abs()).fold(f64::INFINITY, f64::min) - 0.75 * r).max(0.2);
    let (z0, z1, gap) = (-h.z * 0.93, h.z * 0.93, 1.05 * r);
    let bumper = |y: Option<f64>| (y.unwrap_or(FRAME_LO) - 0.02).clamp(FRAME_LO, FRAME_HI - 0.1);
    let mut parts: Vec<(f64, f64, f64, f64)> = vec![(inner, z0, z1, FRAME_LO)];
    for (a, b, lo) in [
        (z0, zf - gap, bumper(d.overhang.map(|o| o.front))),
        (zf + gap, zr - gap, FRAME_LO),
        (zr + gap, z1, bumper(d.overhang.map(|o| o.rear))),
    ] {
        if b - a > 0.1 {
            parts.push((h.x * 0.9, a, b, lo));
        }
    }
    let vol: f64 = parts.iter().map(|&(x, a, b, lo)| x * (b - a) * (FRAME_HI - lo)).sum();
    parts
        .into_iter()
        .map(|(x, a, b, lo)| BoxSpec {
            half: [x, (FRAME_HI - lo) / 2.0, (b - a) / 2.0],
            at: [0.0, (FRAME_HI + lo) / 2.0, (a + b) / 2.0],
            mass: (mass * x * (b - a) * (FRAME_HI - lo)) / vol,
        })
        .collect()
}

pub struct Truck {
    pub body: RigidBodyHandle,
    pub vc: DynamicRayCastVehicleController,
    pub controls: Controls,
    pub wheels: [WheelState; 4],
    pub speed: f64,
    pub wheel_speed: f64,
    pub drivetrain: Drivetrain,
    pub tune: TruckTune,
    pub offroad_assist: bool,
    pub enabled: bool,
    /// Surface under a world point (x, z) → weights + wetness; None = the tests' smooth asphalt (`surfaceMix()`).
    pub surface: Option<SurfaceFn>,
    pub lateral: f64,
    pub drift: f64,
    pub drifting: bool,
    pub wheel_slip: [f64; 4],
    pub ride: f64,
    pub ride_target: f64,
    dims: TruckDims,
    reference: TruckTune,
    colliders: Vec<ColliderHandle>,
    base_radius: f64,
    hubs: [V3; 4],
    rest_w: [f64; 4],
    sag_w: [f64; 4],
    bump_w: [f64; 4],
    travel_w: [f64; 4],
    k_bump: [f64; 4],
    bump_at: [f64; 4],
    k_hard: [f64; 4],
    corner_w: [f64; 4],
    arb: [f64; 4],
    damp_b: [f64; 4],
    damp_r: [f64; 4],
    x_prev: [f64; 4],
    mixes: [SurfaceMix; 4],
    surf_i: usize,
    w_in: [WheelIn; 4],
    upside_down: f64,
    a_max: f64,
}

impl Truck {
    /// A car in `world` from its exported definition (`tune` = the garage setup; `None` = stock).
    pub fn new(world: &mut World, def: &CarDef, tune: Option<TruckTune>) -> Self {
        let t = tune.unwrap_or(def.stock);
        let d = def.dims.clone();
        let h = d.half;
        let r = d.wheel_radius * t.tyre;
        let pw = &mut world.pw;
        let body = pw.bodies.insert(
            RigidBodyBuilder::dynamic()
                .can_sleep(true)
                .angular_damping(0.4)
                .linear_damping(0.02)
                .ccd_enabled(true),
        );
        // VehicleBase: the boxes collide (with mass), or the hulls collide (massless) and the boxes carry the mass.
        let mut boxes = frame_boxes(&d, t.mass * 0.85);
        boxes.push(BoxSpec {
            half: [h.x * 0.86, 0.42, h.z * 0.36],
            at: [0.0, 1.28, -h.z * 0.1],
            mass: t.mass * 0.1,
        });
        boxes.push(BoxSpec {
            half: [h.x * 0.88, 0.2, h.z * 0.42],
            at: [0.0, 1.05, h.z * 0.55],
            mass: t.mass * 0.05,
        });
        let veh = group(groups::VEHICLE, 0xffff & !groups::PLAYER);
        let mut colliders = Vec::new();
        match &d.hulls {
            Some(hulls) if !hulls.is_empty() => {
                // The game's car: its convex HULLS meet only the ground (terrain, formations, ramps; friction 0.15)
                // and its exact body MESH (Groups.VehicleMesh) meets everything else — other cars, props, debris. The
                // server has no mesh: a second copy of the hulls stands in for it, in the mesh's groups, so every
                // contact pairs up as on the client. Each set is ONE compound collider (the same convex pieces): 53
                // separate colliders each paired with the map-wide heightfield cost ~25× the solver time per car.
                let parts: Vec<(Pose, SharedShape)> = hulls
                    .iter()
                    .filter_map(|h| {
                        let pts: Vec<Vector> = h.chunks_exact(3).map(|c| Vector::new(c[0], c[1], c[2])).collect();
                        SharedShape::convex_hull(&pts).map(|s| (Pose::IDENTITY, s))
                    })
                    .collect();
                let compound = SharedShape::compound(parts);
                let ground = group(groups::VEHICLE, groups::TERRAIN | groups::STATIC_MESH);
                let body_mesh = group(
                    groups::VEHICLE_MESH,
                    0xffff & !groups::PLAYER & !groups::TERRAIN & !groups::TERRAIN_MESH & !groups::STATIC_MESH,
                );
                for (g, friction) in [(ground, 0.15), (body_mesh, 0.35)] {
                    let shape = compound.clone();
                    let c = ColliderBuilder::new(shape)
                        .density(0.0)
                        .friction(friction)
                        .restitution(0.05)
                        .collision_groups(g);
                    colliders.push(pw.colliders.insert_with_parent(c, body, &mut pw.bodies));
                }
            }
            _ => {
                for b in &boxes {
                    let c = ColliderBuilder::cuboid(b.half[0] as f32, b.half[1] as f32, b.half[2] as f32)
                        .translation(vf(b.at))
                        .mass(b.mass as f32)
                        .friction(0.35)
                        .restitution(0.05)
                        .collision_groups(veh);
                    colliders.push(pw.colliders.insert_with_parent(c, body, &mut pw.bodies));
                }
            }
        }
        let mut vc = DynamicRayCastVehicleController::new(body);
        vc.index_up_axis = 1;
        vc.index_forward_axis = 2;
        // legacy setup first, exactly as the game builds it (configure() then switches to the drivetrain's)
        let (rest, travel, stiff) = (0.32, 0.24, t.suspension);
        let sag = GRAVITY as f64 / (4.0 * stiff);
        let hubs: [V3; 4] = std::array::from_fn(|i| {
            let p = d.wheel_pos[i];
            [p[0], p[1] + (r - d.wheel_radius), p[2]]
        });
        for hub in &hubs {
            let tuning = WheelTuning {
                suspension_stiffness: stiff as f32,
                suspension_compression: 2.6,
                suspension_damping: 3.8,
                max_suspension_travel: travel,
                side_friction_stiffness: 0.55,
                friction_slip: t.grip as f32,
                max_suspension_force: (t.mass * GRAVITY as f64 * 3.0) as f32,
            };
            vc.add_wheel(
                Vector::new(hub[0] as f32, (hub[1] + rest - sag) as f32, hub[2] as f32),
                Vector::new(0.0, -1.0, 0.0),
                Vector::new(1.0, 0.0, 0.0),
                rest as f32,
                r as f32,
                &tuning,
            );
        }
        let mut drivetrain = Drivetrain::new(def.resolved.clone());
        drivetrain.aids = def.resolved.aids;
        let mut truck = Self {
            body,
            vc,
            controls: Controls::default(),
            wheels: [WheelState::default(); 4],
            speed: 0.0,
            wheel_speed: 0.0,
            drivetrain,
            tune: t,
            offroad_assist: false,
            enabled: true,
            surface: None,
            lateral: 0.0,
            drift: 0.0,
            drifting: false,
            wheel_slip: [0.0; 4],
            ride: 0.0,
            ride_target: 0.0,
            base_radius: d.wheel_radius,
            dims: d,
            reference: def.stock,
            colliders,
            hubs,
            rest_w: [rest; 4],
            sag_w: [sag; 4],
            bump_w: [0.0; 4],
            travel_w: [0.0; 4],
            k_bump: [0.0; 4],
            bump_at: [0.0; 4],
            k_hard: [0.0; 4],
            corner_w: [0.0; 4],
            arb: [0.0; 4],
            damp_b: [0.0; 4],
            damp_r: [0.0; 4],
            x_prev: [0.0; 4],
            mixes: [SurfaceMix::default(); 4],
            surf_i: 0,
            w_in: [WheelIn::default(); 4],
            upside_down: 0.0,
            a_max: 0.0,
        };
        truck.configure(world);
        truck
    }

    /// Set Rapier up for the drivetrain (`configure('drivetrain')`): real gravity via the gravity scale, the spec's
    /// mass / COM / inertia, per-axle springs from the ride frequency, no Rapier tyre friction or damping.
    fn configure(&mut self, world: &mut World) {
        let pw = &mut world.pw;
        let d = &mut self.drivetrain;
        let m = d.r.mass * (self.tune.mass / self.reference.mass);
        {
            let body = &mut pw.bodies[self.body];
            body.set_gravity_scale((G_REAL / GRAVITY as f64) as f32, true);
            body.set_linear_damping(0.0);
            body.set_angular_damping(0.05);
        }
        for &c in &self.colliders {
            if let Some(c) = pw.colliders.get_mut(c) {
                c.set_mass(1e-3);
            }
        }
        let h = self.dims.half;
        let (l, w, hh) = (2.0 * h.z * 0.85, 2.0 * h.x * 0.85, 2.0 * h.y * 0.6);
        let props = MassProperties::new(
            Vector::new(0.0, d.r.com_height as f32, d.r.com_z as f32),
            m as f32,
            Vector::new(
                ((m / 12.0) * (hh * hh + l * l)) as f32,
                ((m / 12.0) * (w * w + l * l)) as f32,
                ((m / 12.0) * (w * w + hh * hh)) as f32,
            ),
        );
        pw.bodies[self.body].set_additional_mass_properties(props, true);
        // (Rapier applies mass changes at its next world step: a car stepped before that — a bot's new car
        // under throttle and steering — had mass 0 and its first tyre impulses came out NaN)
        pw.bodies[self.body].recompute_mass_properties_from_colliders(&pw.colliders);
        let f_scale = (self.tune.suspension / self.reference.suspension).max(0.3).sqrt();
        d.grip_scale = self.tune.grip / self.reference.grip;
        d.power_scale = self.tune.power / self.reference.power;
        d.boost_factor = 1.0 + (self.tune.boost - 1.0) * 0.5;
        // (brakes sized on the spec's tyre radius, THEN every axle takes the model's wheel radius — the game's order)
        d.retune_brakes(m);
        let r = self.base_radius * self.tune.tyre;
        for ax in d.r.axles.iter_mut() {
            ax.radius = r;
        }
        for i in 0..4 {
            let ax = &d.r.axles[i >> 1];
            let sw = ax.share / 2.0;
            let wv = 2.0 * std::f64::consts::PI * ax.freq * f_scale;
            let k = sw * wv * wv;
            let sag = G_REAL / (wv * wv);
            let tt = ax.travel;
            let rest = sag + 1.3 * tt + 0.1;
            self.sag_w[i] = sag;
            self.rest_w[i] = rest;
            self.travel_w[i] = sag + 0.7 * tt;
            self.bump_at[i] = sag + 0.45 * tt;
            self.arb[i] = ax.arb * f_scale * f_scale;
            self.k_bump[i] = (32.0 * sw * m * G_REAL) / (tt * tt);
            self.k_hard[i] = (12.0 * sw * m * G_REAL) / tt;
            self.corner_w[i] = sw * m * G_REAL;
            self.damp_b[i] = 2.0 * ax.zeta[0] * (k * sw).sqrt();
            self.damp_r[i] = 2.0 * ax.zeta[1] * (k * sw).sqrt();
            self.x_prev[i] = self.sag_w[i];
            let hub = self.hubs[i];
            let wh = &mut self.vc.wheels_mut()[i];
            wh.radius = r as f32;
            wh.suspension_rest_length = (rest + self.ride) as f32;
            wh.max_suspension_travel = (sag + 1.3 * tt) as f32;
            wh.suspension_stiffness = k as f32;
            wh.damping_compression = 0.0;
            wh.damping_relaxation = 0.0;
            wh.max_suspension_force = (m * G_REAL * 8.0) as f32;
            wh.friction_slip = 0.0;
            wh.side_friction_stiffness = 0.0;
            wh.engine_force = 0.0;
            wh.brake = 0.0;
            wh.chassis_connection_point_cs = Vector::new(
                hub[0] as f32,
                (hub[1] - self.base_radius + r + rest - sag) as f32,
                hub[2] as f32,
            );
        }
        d.reset();
        let speed = self.speed;
        for i in 0..4 {
            d.omega[i] = speed / r;
            d.spin[i] = self.vc.wheels()[i].rotation as f64;
        }
    }

    pub fn axes(&self, world: &World) -> Axes {
        let q = world.pw.bodies[self.body].rotation();
        let q = [q.x as f64, q.y as f64, q.z as f64, q.w as f64];
        Axes {
            f: rotate(q, 0.0, 0.0, -1.0),
            u: rotate(q, 0.0, 1.0, 0.0),
            r: rotate(q, 1.0, 0.0, 0.0),
        }
    }

    /// Heading (game yaw: 0 = −Z, + turns left).
    pub fn heading(&self, world: &World) -> f64 {
        let f = self.axes(world).f;
        (-f[0]).atan2(-f[2])
    }

    pub fn position(&self, world: &World) -> V3 {
        v3(world.pw.bodies[self.body].translation())
    }

    /// Place at rest on a ground point at y, facing `heading` (game yaw), nose-up `pitch`.
    pub fn place(&mut self, world: &mut World, x: f64, y: f64, z: f64, heading: f64, pitch: f64) {
        let b = &mut world.pw.bodies[self.body];
        b.set_translation(Vector::new(x as f32, (y + 0.05) as f32, z as f32), true);
        let (cy, sy, cp, sp) = (
            (heading / 2.0).cos(),
            (heading / 2.0).sin(),
            (pitch / 2.0).cos(),
            (pitch / 2.0).sin(),
        );
        b.set_rotation(
            Rotation::from_xyzw((cy * sp) as f32, (sy * cp) as f32, (-sy * sp) as f32, (cy * cp) as f32),
            true,
        );
        b.set_linvel(Vector::ZERO, true);
        b.set_angvel(Vector::ZERO, true);
        self.speed = 0.0;
        self.drivetrain.reset();
    }

    /// One fixed step: controls → wheel forces → raycast vehicle update → tyre forces. Call before `World::step`.
    pub fn step(&mut self, world: &mut World, dt: f64) {
        if !self.enabled {
            return;
        }
        let ax = self.axes(world);
        {
            let b = &mut world.pw.bodies[self.body];
            let lv = v3(b.linvel());
            self.speed = dot(lv, ax.f);
            b.reset_forces(false);
            b.reset_torques(false);
            if self.speed.abs() > 0.05 || self.controls.throttle.abs() > 0.01 {
                b.wake_up(true);
            }
        }
        self.update_ride(world, dt);
        self.drive_real(world, dt);
        {
            let pw = &mut world.pw;
            let filter = QueryFilter::new().groups(ground_groups()).exclude_rigid_body(self.body);
            let q = pw.broad_phase.as_query_pipeline_mut(
                pw.narrow_phase.query_dispatcher(),
                &mut pw.bodies,
                &mut pw.colliders,
                filter,
            );
            self.vc.update_vehicle(dt as f32, q);
        }
        self.after_real(world, dt);
        let mut rim = 0.0;
        for i in 0..4 {
            let wh = &self.vc.wheels()[i];
            let len = wh.raycast_info().suspension_length as f64;
            let st = &mut self.wheels[i];
            st.lift = self.rest_w[i] - self.sag_w[i] - len + self.bump_w[i];
            let spin = self.drivetrain.spin[i];
            rim += ((spin - st.spin) / dt) * self.base_radius * self.tune.tyre;
            st.spin = spin;
            st.steer = -(wh.steering as f64);
            st.contact = wh.raycast_info().is_in_contact;
        }
        let ws = rim / 4.0;
        self.wheel_speed = if ws.is_finite() { ws } else { self.speed };
        let mut rim = 0.0;
        for i in 0..4 {
            self.wheels[i].spin = self.drivetrain.spin[i];
            rim += self.drivetrain.omega[i] * self.drivetrain.r.axles[i >> 1].radius;
        }
        self.wheel_speed = rim / 4.0;
    }

    /// Take the body out of the simulation (false) or put it back (the game's `enabled`).
    pub fn set_enabled(&mut self, world: &mut World, on: bool) {
        if self.enabled != on {
            self.enabled = on;
            world.pw.bodies[self.body].set_enabled(on);
        }
    }

    /// Streaming guard (the game's `keepAbove`): never below the ground.
    pub fn keep_above(&mut self, world: &mut World, ground: f64) {
        let b = &mut world.pw.bodies[self.body];
        let t = b.translation();
        if (t.y as f64) < ground - 0.6 {
            b.set_translation(Vector::new(t.x, (ground + 0.3) as f32, t.z), true);
            let v = b.linvel();
            b.set_linvel(Vector::new(v.x, v.y.max(0.0), v.z), true);
        }
    }

    fn update_ride(&mut self, world: &mut World, dt: f64) {
        let l = self.controls.lift;
        if l != 0.0 {
            self.ride_target = (self.ride_target + l * dt * 0.6).clamp(0.0, RIDE_MAX);
        }
        let d = self.ride_target - self.ride;
        if d.abs() < 1e-4 {
            return;
        }
        self.ride += sign(d) * d.abs().min(dt * 0.5);
        for i in 0..4 {
            self.vc.wheels_mut()[i].suspension_rest_length = (self.rest_w[i] + self.ride) as f32;
        }
        world.pw.bodies[self.body].wake_up(true);
    }

    /// Before the raycast update: the wheels' steering, ground roughness through the tyre envelope.
    fn drive_real(&mut self, world: &World, dt: f64) {
        let ax = self.axes(world);
        for i in 0..4 {
            let dst = self.drivetrain.steer[i];
            self.vc.wheels_mut()[i].steering = (-dst) as f32;
            let p = v3(self.vc.wheels()[i].raycast_info().hard_point_ws);
            let (cd, sd) = (dst.cos(), dst.sin());
            let hd = [
                ax.f[0] * cd + ax.r[0] * sd,
                ax.f[1] * cd + ax.r[1] * sd,
                ax.f[2] * cd + ax.r[2] * sd,
            ];
            let h = self.tyre_envelope(world, i, p, hd, ax.u).min(self.bump_w[i] + 3.0 * dt);
            self.bump_w[i] = h;
            self.vc.wheels_mut()[i].suspension_rest_length = (self.rest_w[i] + self.ride + h) as f32;
        }
    }

    /// How much higher than under its hub the ground effectively is for wheel i (`tyreEnvelope`).
    fn tyre_envelope(&self, world: &World, i: usize, hp: V3, hd: V3, u: V3) -> f64 {
        let r = self.vc.wheels()[i].radius as f64;
        let l = self.rest_w[i] + self.ride + r * 1.6;
        let mix = &self.mixes[i];
        let dir = vf([-u[0], -u[1], -u[2]]);
        let e = self.dims.tyre_half_width.unwrap_or(0.0) * 0.85 * self.tune.tyre;
        let axx = hd[1] * u[2] - hd[2] * u[1];
        let axy = hd[2] * u[0] - hd[0] * u[2];
        let axz = hd[0] * u[1] - hd[1] * u[0];
        let h0 = world.cast_ray(vf(hp), dir, l as f32, ground_groups(), self.body);
        let g0 = h0.map_or(0.0, |t| l - t as f64);
        let (mut hub, mut best) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for (k, &dk) in ENV_D.iter().enumerate() {
            let s = dk * r;
            let sides = if e > 0.0 && k < 5 { 3 } else { 1 };
            for side in 0..sides {
                let w = match side {
                    0 => 0.0,
                    1 => e,
                    _ => -e,
                };
                let o = [
                    hp[0] + hd[0] * s + axx * w,
                    hp[1] + hd[1] * s + axy * w,
                    hp[2] + hd[2] * s + axz * w,
                ];
                let hit = world.cast_ray(vf(o), dir, l as f32, ray_groups(), self.body);
                let g = hit.map_or(0.0, |t| l - t as f64);
                let gx = o[0] - u[0] * (l - g);
                let gz = o[2] - u[2] * (l - g);
                let hk = g + roughness(gx, gz, mix);
                let lift = hk - (r - (r * r - s * s).sqrt());
                if k < 3 && lift > hub {
                    hub = lift;
                } else if lift > best {
                    best = lift;
                }
            }
        }
        (hub - g0).max((0.8 * r).min(best - g0))
    }

    /// After the raycast update: loads, contact frames, the drivetrain step, tyre forces, drag, assists (`afterReal`).
    fn after_real(&mut self, world: &mut World, dt: f64) {
        let ax = self.axes(world);
        let (f, u, rt) = (ax.f, ax.u, ax.r);
        let pw = &mut world.pw;
        let (lv, w, com, t, q, mass) = {
            let b = &pw.bodies[self.body];
            let r = b.rotation();
            (
                v3(b.linvel()),
                v3(b.angvel()),
                v3(b.center_of_mass()),
                v3(b.translation()),
                [r.x as f64, r.y as f64, r.z as f64, r.w as f64],
                b.mass() as f64,
            )
        };
        // surfaces: one wheel per step
        let si = (self.surf_i + 1) % 4;
        self.surf_i = si;
        {
            let p = v3(self.vc.wheels()[si].raycast_info().hard_point_ws);
            if let Some(s) = &self.surface {
                s(p[0], p[2], &mut self.mixes[si]);
            }
            let d = &mut self.drivetrain;
            let kind = tyre_kind(d.r.axles[si >> 1].tyre_kind);
            let mut gp = d.grips[si];
            grip_for(&kind, &self.mixes[si], d.grip_scale, &mut gp);
            if self.offroad_assist {
                let mw = &self.mixes[si].w;
                let soft = (mw[surf::SNOW] + mw[surf::MUD] + mw[surf::SAND]) as f64;
                if soft > 0.0 {
                    gp.mu += (0.55 * d.grip_scale - gp.mu).max(0.0) * soft;
                }
            }
            d.grips[si] = gp;
            let mw = &self.mixes[si].w;
            d.air_t[si] =
                20.0 + 15.0 * mw[surf::SAND] as f64 - 24.0 * mw[surf::SNOW] as f64 - 28.0 * mw[surf::ICE] as f64;
            d.wet_t[si] = self.mixes[si].wet;
        }
        let mut x = [0.0; 4];
        for (i, xi) in x.iter_mut().enumerate() {
            *xi = self.rest_w[i] + self.ride + self.bump_w[i]
                - self.vc.wheels()[i].raycast_info().suspension_length as f64;
        }
        let mut contacts = 0;
        let mut cf = [[0.0; 6]; 4];
        let mut cp = [[0.0; 3]; 4];
        for i in 0..4 {
            let wh = &self.vc.wheels()[i];
            let info = wh.raycast_info();
            let wi = &mut self.w_in[i];
            wi.contact = info.is_in_contact;
            if !wi.contact {
                *wi = WheelIn::default();
                self.x_prev[i] = 0.0;
                continue;
            }
            contacts += 1;
            let pair = i ^ 1;
            let arb_f = self.arb[i] * (x[i] - x[pair]);
            let bz = x[i].min(self.travel_w[i]) - self.bump_at[i];
            let hard = x[i] - self.travel_w[i];
            let mut bump = (if bz > 0.0 { self.k_bump[i] * bz * bz } else { 0.0 })
                + if hard > 0.0 { self.k_hard[i] * hard } else { 0.0 };
            let spring = wh.wheel_suspension_force as f64;
            let hp = v3(info.hard_point_ws);
            let sv = if self.x_prev[i] > 0.0 {
                if dt > 0.0 { (x[i] - self.x_prev[i]) / dt } else { 0.0 }
            } else {
                let (rx, ry, rz) = (hp[0] - com[0], hp[1] - com[1], hp[2] - com[2]);
                -((lv[0] + w[1] * rz - w[2] * ry) * u[0]
                    + (lv[1] + w[2] * rx - w[0] * rz) * u[1]
                    + (lv[2] + w[0] * ry - w[1] * rx) * u[2])
            };
            self.x_prev[i] = x[i].max(1e-6);
            if hard > 0.0 && sv > 0.0 {
                bump += (8.0 * self.corner_w[i]).min(((0.6 * self.corner_w[i]) / G_REAL) * (sv / dt));
            }
            let av = sv.abs();
            let mut damp = sign(sv)
                * (if sv > 0.0 { self.damp_b[i] } else { self.damp_r[i] })
                * mass
                * if av < DAMP_KNEE {
                    av
                } else {
                    DAMP_KNEE + DAMP_HIGH * (av - DAMP_KNEE)
                };
            if damp < 0.0 {
                damp = damp.max(-(spring + arb_f + bump)).min(0.0);
            }
            if arb_f != 0.0 || bump > 0.0 || damp != 0.0 {
                let ff = arb_f + bump + damp;
                pw.bodies[self.body].add_force_at_point(vf([u[0] * ff, u[1] * ff, u[2] * ff]), vf(hp), true);
            }
            wi.fz = (spring + arb_f + bump + damp).max(0.0);
            let n = v3(info.contact_normal_ws);
            let ds = self.drivetrain.steer[i];
            let (cd, sd) = (ds.cos(), ds.sin());
            let (fx, fy, fz) = (f[0] * cd + rt[0] * sd, f[1] * cd + rt[1] * sd, f[2] * cd + rt[2] * sd);
            let dn = fx * n[0] + fy * n[1] + fz * n[2];
            let mut fc = [fx - n[0] * dn, fy - n[1] * dn, fz - n[2] * dn];
            let fl = {
                let l = (fc[0] * fc[0] + fc[1] * fc[1] + fc[2] * fc[2]).sqrt();
                if l == 0.0 { 1.0 } else { l }
            };
            fc = [fc[0] / fl, fc[1] / fl, fc[2] / fl];
            let lc = [
                fc[1] * n[2] - fc[2] * n[1],
                fc[2] * n[0] - fc[0] * n[2],
                fc[0] * n[1] - fc[1] * n[0],
            ];
            let p = v3(info.contact_point_ws);
            let (rx, ry, rz) = (p[0] - com[0], p[1] - com[1], p[2] - com[2]);
            let vx = lv[0] + w[1] * rz - w[2] * ry;
            let vy = lv[1] + w[2] * rx - w[0] * rz;
            let vz = lv[2] + w[0] * ry - w[1] * rx;
            wi.vx = vx * fc[0] + vy * fc[1] + vz * fc[2];
            wi.vy = vx * lc[0] + vy * lc[1] + vz * lc[2];
            let wn = w[0] * n[0] + w[1] * n[1] + w[2] * n[2];
            let hx = lv[0] + wn * (n[1] * rz - n[2] * ry);
            let hy = lv[1] + wn * (n[2] * rx - n[0] * rz);
            let hz = lv[2] + wn * (n[0] * ry - n[1] * rx);
            wi.hx = hx * fc[0] + hy * fc[1] + hz * fc[2];
            wi.hy = hx * lc[0] + hy * lc[1] + hz * lc[2];
            wi.gx = -G_REAL * fc[1];
            wi.gy = -G_REAL * lc[1];
            let fb = arb_f + bump + damp;
            wi.sx = fb * dot(u, fc);
            wi.sy = fb * dot(u, lc);
            cf[i] = [fc[0], fc[1], fc[2], lc[0], lc[1], lc[2]];
            cp[i] = p;
        }
        // CLIMB ASSIST (off-road assist): the tyres feel at most a ~26° slope.
        let d = &mut self.drivetrain;
        let mut steep = 0.0;
        if self.offroad_assist && contacts >= 2 {
            let (mut nx, mut ny, mut nz, mut nn) = (0.0, 0.0, 0.0, 0);
            for i in 0..4 {
                if !self.w_in[i].contact {
                    continue;
                }
                let cn = v3(self.vc.wheels()[i].raycast_info().contact_normal_ws);
                nx += cn[0];
                ny += cn[1];
                nz += cn[2];
                nn += 1;
            }
            if nn > 0 {
                nx /= nn as f64;
                ny /= nn as f64;
                nz /= nn as f64;
            }
            let slope = (if ny != 0.0 { ny } else { 1.0 }).clamp(-1.0, 1.0).acos();
            steep = ((slope - 0.35) / 0.2).clamp(0.0, 1.0);
            let mut mu = 0.0;
            let mut ds = 0.0;
            for i in 0..4 {
                if self.w_in[i].contact {
                    mu += d.grips[i].mu / (nn.max(1)) as f64;
                }
            }
            for a in 0..d.r.axles.len() {
                if d.is_driven_axle(a) {
                    ds += d.r.axles[a].share;
                }
            }
            let eff = SLOPE_EFF.min((0.7 * mu * ds.min(1.0)).atan());
            if slope > eff {
                let g = G_REAL;
                let (sin_t, cos_t) = (slope.sin(), slope.cos());
                let (sin_e, cos_e) = (eff.sin(), eff.cos());
                let tl = {
                    let l = nx.hypot(nz);
                    if l == 0.0 { 1.0 } else { l }
                };
                let (ux, uy, uz) = ((-nx / tl) * cos_t, sin_t, (-nz / tl) * cos_t);
                let lift = mass * g * (sin_t - sin_e);
                let press = mass * g * (cos_e - cos_t);
                pw.bodies[self.body].add_force(
                    vf([lift * ux - press * nx, lift * uy - press * ny, lift * uz - press * nz]),
                    true,
                );
                let k = sin_e / sin_t;
                for wi in self.w_in.iter_mut() {
                    if wi.contact {
                        wi.gx *= k;
                        wi.gy *= k;
                    }
                }
            }
        }
        d.torque_boost = if self.offroad_assist { 1.6 + 0.6 * steep } else { 1.0 };
        d.steep_hold = self.offroad_assist;
        d.steep_climb = steep > 0.3;
        if d.steep_climb && d.r.drive.lockers.contains(&Locker::Centre) {
            d.locks.centre = true;
        }
        let mut ch = ChassisIn {
            speed: dot(lv, f),
            g: G_REAL,
            ..Default::default()
        };
        ch.yaw_rate = -(w[0] * u[0] + w[1] * u[1] + w[2] * u[2]);
        ch.lat_accel = ch.speed * ch.yaw_rate;
        ch.pitch = f[1].clamp(-1.0, 1.0).asin();
        let last_z = d.r.axles[d.r.axles.len() - 1].z;
        let rv = rotate(q, 0.0, 0.0, last_z);
        let (axx, ayy, azz) = (t[0] + rv[0] - com[0], t[1] + rv[1] - com[1], t[2] + rv[2] - com[2]);
        ch.rear_vy = (lv[0] + w[1] * azz - w[2] * ayy) * rt[0]
            + (lv[1] + w[2] * axx - w[0] * azz) * rt[1]
            + (lv[2] + w[0] * ayy - w[1] * axx) * rt[2];
        let c = self.controls;
        d.nitro = c.boost;
        let din = DriverInput {
            throttle: c.throttle,
            steer: c.steer,
            handbrake: c.handbrake,
            boost: c.boost,
            parked: c.parked,
            brake: c.foot_brake,
        };
        let assisting = d.aids == AidLevel::Full && contacts >= 3 && u[1] > 0.6 && !c.handbrake;
        d.assist_yaw = if assisting {
            -Self::assist_target(d, &mut self.a_max, c.steer, lv, f, rt)
        } else {
            0.0
        };
        d.step(dt, &din, &ch, &self.w_in);
        let body = &mut pw.bodies[self.body];
        for i in 0..4 {
            if !self.w_in[i].contact {
                continue;
            }
            let (fxx, fyy) = (d.fx[i], d.fy[i]);
            let c6 = cf[i];
            let fv = [
                c6[0] * fxx + c6[3] * fyy,
                c6[1] * fxx + c6[4] * fyy,
                c6[2] * fxx + c6[5] * fyy,
            ];
            body.add_force_at_point(vf(fv), vf(cp[i]), true);
        }
        let sp = (lv[0] * lv[0] + lv[1] * lv[1] + lv[2] * lv[2]).sqrt();
        if sp > 0.1 {
            let drag = 0.5 * 1.2 * d.r.cd_a * sp;
            body.add_force(vf([-lv[0] * drag, -lv[1] * drag, -lv[2] * drag]), true);
        }
        if assisting {
            Self::corner_assist(body, d, &mut self.a_max, c.steer, dt, f, u, rt);
        }
        self.lateral = dot(lv, rt);
        let av = ch.speed.abs();
        let slip_angle = self.lateral.abs().atan2(av.max(0.5));
        self.drifting = av > 5.0 && slip_angle > 0.3 && contacts >= 2;
        self.drift += ((if self.drifting {
            (slip_angle / 0.6).min(1.0)
        } else {
            0.0
        }) - self.drift)
            * (dt * 8.0).min(1.0);
        for i in 0..4 {
            self.wheel_slip[i] = d.slip[i];
        }
        // auto-righting (game rule) — reads last step's wheel contacts, like the game
        let on_wheels = self.wheels.iter().filter(|x| x.contact).count();
        self.upside_down = if u[1] < 0.35 && av < 2.0 && on_wheels < 2 {
            self.upside_down + dt
        } else {
            0.0
        };
        if self.upside_down > 2.0 {
            let hd = (-f[0]).atan2(-f[2]);
            self.upside_down = 0.0;
            self.place(world, t[0], t[1] + 1.2, t[2], hd, 0.0);
        }
    }

    fn assist_target(d: &Drivetrain, a_max: &mut f64, st: f64, lv: V3, f: V3, r: V3) -> f64 {
        let vf_ = dot(lv, f);
        let k = ((vf_ - 7.0) / 7.0).min(1.0);
        if k <= 0.0 || st.abs() < 0.05 {
            return 0.0;
        }
        if dot(lv, r).atan2(vf_).abs() > 0.45 {
            return 0.0;
        }
        let mu = (d.grips[0].mu + d.grips[1].mu + d.grips[2].mu + d.grips[3].mu) / 4.0;
        *a_max = G_REAL * (if mu < 0.35 { mu * 1.8 } else { 1.8 }) * (0.6 + 0.4 * k);
        -st * ((vf_ * d.r.steering.lock.tan()) / d.r.wheelbase).min(*a_max / vf_)
    }

    #[allow(clippy::too_many_arguments)]
    fn corner_assist(body: &mut RigidBody, d: &Drivetrain, a_max: &mut f64, st: f64, dt: f64, f: V3, u: V3, r: V3) {
        let lv = v3(body.linvel());
        let wu_t = Self::assist_target(d, a_max, st, lv, f, r);
        if wu_t == 0.0 {
            return;
        }
        let vf_ = dot(lv, f);
        let vr = dot(lv, r);
        let vu = dot(lv, u);
        let slip = vr.atan2(vf_);
        let am = *a_max;
        let w = v3(body.angvel());
        let wu = dot(w, u);
        if if wu_t > 0.0 { wu < wu_t } else { wu > wu_t } {
            let dwu = (wu_t - wu) * (dt * 6.0).min(1.0);
            body.set_angvel(vf([w[0] + u[0] * dwu, w[1] + u[1] * dwu, w[2] + u[2] * dwu]), true);
        }
        let turn = sign(slip) * slip.abs().min((am / vf_) * dt);
        let ang = slip - turn;
        let len = vf_.hypot(vr);
        let (nf, nr) = (ang.cos() * len, ang.sin() * len);
        body.set_linvel(
            vf([
                f[0] * nf + r[0] * nr + u[0] * vu,
                f[1] * nf + r[1] * nr + u[1] * vu,
                f[2] * nf + r[2] * nr + u[2] * vu,
            ]),
            true,
        );
    }

    /// Remove from the world.
    pub fn dispose(self, world: &mut World) {
        world.pw.remove_body_with_colliders(self.body, true);
    }
}
