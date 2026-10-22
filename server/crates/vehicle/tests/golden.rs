//! Parity with the game's car model: `golden/*.json` are recorded from the TypeScript TruckSim + Drivetrain
//! (`cd game && npm run golden:vehicle`).
//!  * drivetrain replay: the same per-step inputs → the same outputs, to rounding (pure math, no Rapier).
//!  * whole car: the same controls on the same ground → the same trajectory, within a tolerance (JS-WASM and native
//!    Rapier don't round identically; the gap is measured and bounded here).

use dark_vehicle::drivetrain::{ChassisIn, DriverInput, Drivetrain, WheelIn};
use dark_vehicle::spec::{AidLevel, CarDef};
use dark_vehicle::tyre::Grip;
use dark_vehicle::{Controls, Truck, World};
use rapier3d::prelude::{Rotation, Vector};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DtIn {
    dt: f64,
    din: Din,
    ch: Ch,
    w: Vec<Wi>,
    grips: Vec<Gp>,
    air_t: Vec<f64>,
    wet_t: Vec<f64>,
    assist_yaw: f64,
    torque_boost: f64,
    steep_hold: bool,
    steep_climb: bool,
    nitro: bool,
    centre: bool,
}
#[derive(Deserialize)]
struct Din {
    throttle: f64,
    steer: f64,
    handbrake: bool,
    boost: bool,
    parked: bool,
    #[serde(default)]
    brake: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ch {
    speed: f64,
    yaw_rate: f64,
    lat_accel: f64,
    pitch: f64,
    g: f64,
    rear_vy: f64,
}
#[derive(Deserialize)]
#[allow(non_snake_case)]
struct Wi {
    contact: bool,
    Fz: f64,
    vx: f64,
    vy: f64,
    gx: f64,
    gy: f64,
    sx: f64,
    sy: f64,
    hx: f64,
    hy: f64,
}
#[derive(Deserialize)]
struct Gp {
    mu: f64,
    kp: f64,
    ap: f64,
    crr: f64,
    sand: f64,
    offroad: f64,
}
#[derive(Deserialize)]
#[allow(non_snake_case)]
struct DtOut {
    Fx: Vec<f64>,
    Fy: Vec<f64>,
    omega: Vec<f64>,
    spin: Vec<f64>,
    steer: Vec<f64>,
    we: f64,
    gear: i32,
    gas: f64,
    brake: f64,
    #[serde(rename = "treadT")]
    tread_t: Vec<f64>,
    dbg: Dbg,
}
#[derive(Deserialize)]
#[allow(non_snake_case, dead_code)]
#[serde(rename_all = "camelCase")]
struct Dbg {
    shifting: bool,
    clutch: f64,
    tcs: f64,
    lockup: bool,
    #[serde(rename = "Tcarrier")]
    t_carrier: f64,
    abs_rel: Vec<u8>,
    esc_brake: Vec<f64>,
    tcs_brake: Vec<f64>,
    burn_clutch: u8,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ctl {
    throttle: f64,
    steer: f64,
    handbrake: bool,
    boost: bool,
    #[serde(default)]
    parked: bool,
    #[serde(default)]
    foot_brake: f64,
    #[serde(default)]
    lift: f64,
}
#[derive(Deserialize)]
struct Body {
    p: [f64; 3],
    q: [f64; 4],
    v: [f64; 3],
    speed: f64,
}
#[derive(Deserialize)]
struct Step {
    dt: DtIn,
    out: DtOut,
    ctl: Ctl,
    body: Body,
}
#[derive(Deserialize)]
struct RampBox {
    half: [f32; 3],
    at: [f32; 3],
    rot: [f32; 4],
}
#[derive(Deserialize)]
struct Golden {
    scenario: String,
    ramp: Option<RampBox>,
    def: CarDef,
    aids: AidLevel,
    steps: Vec<Step>,
}

fn load(name: &str) -> Golden {
    let path = format!("{}/golden/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .expect("golden json")
}

const ALL: [&str; 4] = ["drive-pickup", "drive-gwagen", "drive-zuk", "ramp-pickup"];

/// Steps the open-loop drivetrain replay is compared for. The Żuk (no aids, open diff) pulls away with its rears
/// spinning — a stiff regime where the GAME'S OWN drivetrain turns a 1e-12 nudge at step 10 into 3e-2 by step 17
/// and 100 % by step 20 (measured: TypeScript replayed against itself). Past that onset no implementation can
/// follow another open-loop; the whole-car test below still covers the run.
fn replay_steps(name: &str, n: usize) -> usize {
    if name == "drive-zuk" { 14 } else { n }
}

/// |a − b| within `tol` relative to the magnitude (and an absolute floor).
fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * (1.0 + a.abs().max(b.abs()))
}

fn setup_drivetrain(g: &Golden) -> Drivetrain {
    let mut d = Drivetrain::new(g.def.resolved.clone());
    d.aids = g.aids;
    // TruckSim.configure('drivetrain') with the stock setup
    let (t, r) = (g.def.stock, g.def.stock);
    d.grip_scale = t.grip / r.grip;
    d.power_scale = t.power / r.power;
    d.boost_factor = 1.0 + (t.boost - 1.0) * 0.5;
    d.retune_brakes(g.def.resolved.mass * (t.mass / r.mass));
    for ax in d.r.axles.iter_mut() {
        ax.radius = g.def.dims.wheel_radius * t.tyre;
    }
    d.reset();
    d
}

#[test]
fn drivetrain_replays_the_game_step_for_step() {
    for name in ALL {
        let g = load(name);
        let mut d = setup_drivetrain(&g);
        if std::env::var("GOLDEN_DUMP").is_ok() {
            println!(
                "{name}: brake capacity {:?} I {:?}",
                d.brake_capacity(),
                g.def.resolved.axles.iter().map(|a| a.inertia).collect::<Vec<_>>()
            );
        }
        let mut worst = 0.0f64;
        for (k, s) in g.steps.iter().enumerate().take(replay_steps(name, g.steps.len())) {
            let i = &s.dt;
            for (j, gp) in i.grips.iter().enumerate() {
                d.grips[j] = Grip {
                    mu: gp.mu,
                    kp: gp.kp,
                    ap: gp.ap,
                    crr: gp.crr,
                    sand: gp.sand,
                    offroad: gp.offroad,
                };
            }
            d.air_t.copy_from_slice(&i.air_t);
            d.wet_t.copy_from_slice(&i.wet_t);
            d.assist_yaw = i.assist_yaw;
            d.torque_boost = i.torque_boost;
            d.steep_hold = i.steep_hold;
            d.steep_climb = i.steep_climb;
            d.nitro = i.nitro;
            d.locks.centre = i.centre;
            let din = DriverInput {
                throttle: i.din.throttle,
                steer: i.din.steer,
                handbrake: i.din.handbrake,
                boost: i.din.boost,
                parked: i.din.parked,
                brake: i.din.brake,
            };
            let ch = ChassisIn {
                speed: i.ch.speed,
                yaw_rate: i.ch.yaw_rate,
                lat_accel: i.ch.lat_accel,
                pitch: i.ch.pitch,
                g: i.ch.g,
                rear_vy: i.ch.rear_vy,
            };
            let w: Vec<WheelIn> =
                i.w.iter()
                    .map(|x| WheelIn {
                        contact: x.contact,
                        fz: x.Fz,
                        vx: x.vx,
                        vy: x.vy,
                        gx: x.gx,
                        gy: x.gy,
                        sx: x.sx,
                        sy: x.sy,
                        hx: x.hx,
                        hy: x.hy,
                    })
                    .collect();
            d.step(i.dt, &din, &ch, &w);
            let o = &s.out;
            if std::env::var("GOLDEN_DUMP").is_ok() && (299..302).contains(&k) {
                let (tcs, lockup, tc, absr, esc, tcsb, burn) = d.debug_state();
                println!(
                    "{name} step {k}: rust shifting {} clutch {} tcs {tcs} lockup {lockup} Tc {tc} abs {absr:?} esc {esc:?} tcsB {tcsb:?} burn {burn}",
                    d.shifting, d.clutch
                );
                let g = &o.dbg;
                println!(
                    "{name} step {k}: game shifting {} clutch {} tcs {} lockup {} Tc {} abs {:?} esc {:?} tcsB {:?} burn {}",
                    g.shifting,
                    g.clutch,
                    g.tcs,
                    g.lockup,
                    g.t_carrier,
                    g.abs_rel,
                    g.esc_brake,
                    g.tcs_brake,
                    g.burn_clutch
                );
            }
            assert_eq!(d.gear, o.gear, "{name} step {k}: gear");
            let mut check = |what: &str, a: f64, b: f64| {
                let e = (a - b).abs() / (1.0 + a.abs().max(b.abs()));
                worst = worst.max(e);
                let tol = std::env::var("GOLDEN_TOL")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1e-6);
                if std::env::var("GOLDEN_DUMP").is_ok() {
                    if !close(a, b, tol) && k < 302 {
                        println!("{name} step {k}: {what} rust {a} game {b}");
                    }
                } else {
                    assert!(close(a, b, tol), "{name} step {k}: {what} rust {a} game {b}");
                }
            };
            check("we", d.we, o.we);
            check("gas", d.gas, o.gas);
            check("brake", d.brake, o.brake);
            for j in 0..d.n {
                check("Fx", d.fx[j], o.Fx[j]);
                check("Fy", d.fy[j], o.Fy[j]);
                check("omega", d.omega[j], o.omega[j]);
                check("spin", d.spin[j], o.spin[j]);
                check("steer", d.steer[j], o.steer[j]);
                check("treadT", d.tread_t[j], o.tread_t[j]);
            }
        }
        println!(
            "{name}: {} steps, worst relative difference {worst:.2e}",
            replay_steps(name, g.steps.len())
        );
    }
}

/// The whole car in a Rust Rapier world vs the game's trace: position error over time.
fn run_car(g: &Golden) -> (f64, f64, f64) {
    let mut world = World::new();
    world.add_ground_box(4000.0);
    if let Some(r) = &g.ramp {
        world.add_terrain_box(
            Vector::new(r.half[0], r.half[1], r.half[2]),
            Vector::new(r.at[0], r.at[1], r.at[2]),
            Rotation::from_xyzw(r.rot[0], r.rot[1], r.rot[2], r.rot[3]),
        );
    }
    let mut t = Truck::new(&mut world, &g.def, None);
    t.drivetrain.aids = g.aids;
    t.place(&mut world, 0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut worst, mut worst_v) = (0.0f64, 0.0f64);
    let mut end = 0.0;
    for (k, s) in g.steps.iter().enumerate() {
        let c = &s.ctl;
        t.controls = Controls {
            parked: c.parked,
            throttle: c.throttle,
            steer: c.steer,
            handbrake: c.handbrake,
            boost: c.boost,
            brake: false,
            foot_brake: c.foot_brake,
            lift: c.lift,
        };
        t.step(&mut world, 1.0 / 60.0);
        world.step();
        let p = t.position(&world);
        let e = ((p[0] - s.body.p[0]).powi(2) + (p[1] - s.body.p[1]).powi(2) + (p[2] - s.body.p[2]).powi(2)).sqrt();
        worst = worst.max(e);
        let v = world.pw.bodies[t.body].linvel();
        let ev = ((v.x as f64 - s.body.v[0]).powi(2)
            + (v.y as f64 - s.body.v[1]).powi(2)
            + (v.z as f64 - s.body.v[2]).powi(2))
        .sqrt();
        worst_v = worst_v.max(ev);
        if k + 1 == g.steps.len() {
            end = e;
            println!(
                "{}: game end ({:.2}, {:.2}, {:.2}) speed {:.2} q {:?} | rust ({:.2}, {:.2}, {:.2}) speed {:.2}",
                g.scenario, s.body.p[0], s.body.p[1], s.body.p[2], s.body.speed, s.body.q, p[0], p[1], p[2], t.speed
            );
        }
    }
    (worst, worst_v, end)
}

#[test]
fn whole_car_follows_the_game_trajectory() {
    for name in ALL {
        let g = load(name);
        let (worst, worst_v, end) = run_car(&g);
        println!("{name}: position error worst {worst:.3} m (end {end:.3} m), velocity error worst {worst_v:.3} m/s");
        // a few cm per km would be ideal; the bound is what different float paths (WASM vs native) allow over ~100 m
        assert!(
            worst < 1.0,
            "{name}: the car drifted {worst:.2} m from the game's trajectory"
        );
    }
}
