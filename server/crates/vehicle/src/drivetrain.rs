//! THE DRIVETRAIN — a port of `game/src/gameplay/vehicle/drivetrain/Drivetrain.ts` (render-free, Rapier-free,
//! deterministic). Engine, clutch / converter, gearbox + shift map, differentials, per-wheel spin and slip, combined
//! slip tyre forces, tyre heat, ABS / TCS / ESC. Keep it line-for-line with the TypeScript: `tests/golden.rs` feeds
//! both the same per-step inputs (recorded from the game) and compares every output.
//!
//! Wheels are axle-major: wheel i = axle (i >> 1), left (i & 1 = 0) / right (1). + vx forward, + vy right, Fx + pushes
//! the car forward, Fy + pushes it right; steer + = right.

// (indexed loops on purpose: the code reads line-for-line with Drivetrain.ts)
#![allow(clippy::needless_range_loop)]

use crate::spec::{AidLevel, Diff, GearboxKind, Layout, Locker, PowerKind, Resolved, curve_torque};
use crate::tyre::{Grip, combined_slip, tyre_kind};

pub const SUBSTEPS: usize = 8;
/// Tyre relaxation length (m).
const SIGMA: f64 = 0.4;

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// JavaScript's Math.sign (0 for 0; Rust's signum gives ±1).
pub(crate) fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// Tyre temperature model constants (`TYRE`).
pub mod tyre_heat {
    pub const ETA: f64 = 0.72;
    pub const C_S: f64 = 120.0;
    pub const C_B: f64 = 700.0;
    pub const G_SB: f64 = 40.0;
    pub const G_SA: f64 = 6.0;
    pub const G_SAV: f64 = 9.0;
    pub const G_BA: f64 = 3.0;
    pub const G_BAV: f64 = 3.0;
    pub const FAN: f64 = 0.1;
    pub const WET_COOL: f64 = 3.0;
    pub const GRIP_FROM: f64 = 120.0;
    pub const GRIP_TO: f64 = 300.0;
    pub const GRIP_LOSS: f64 = 0.3;
    pub const LOOSE_HEAT: f64 = 0.8;
    pub const SMOKE_FROM: f64 = 140.0;
    pub const SMOKE_FULL: f64 = 230.0;
    pub const IGNITE: f64 = 360.0;
    pub const IGNITE_CORE: f64 = 170.0;
    pub const OUT: f64 = 230.0;
    pub const FIRE_W: f64 = 8000.0;
    pub const PYRO: f64 = 500.0;
    pub const FUEL: f64 = 45.0;
    pub const BLOW_OFF: f64 = 6.0;
}
use tyre_heat as T;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DriverInput {
    /// −1 … 1 (gas in D / brake while rolling / reverse at a standstill).
    pub throttle: f64,
    /// −1 … 1 (+ = right).
    pub steer: f64,
    pub handbrake: bool,
    pub boost: bool,
    pub parked: bool,
    /// Gearbox in neutral, brakes off: the car rolls free (towed on a rope with nobody at the wheel).
    pub neutral: bool,
    /// 0..1 foot brake held together with the gas.
    pub brake: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WheelIn {
    pub contact: bool,
    pub fz: f64,
    pub vx: f64,
    pub vy: f64,
    pub gx: f64,
    pub gy: f64,
    pub sx: f64,
    pub sy: f64,
    pub hx: f64,
    pub hy: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChassisIn {
    pub speed: f64,
    /// + = turning right.
    pub yaw_rate: f64,
    pub lat_accel: f64,
    pub pitch: f64,
    pub g: f64,
    pub rear_vy: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Selector {
    P,
    R,
    N,
    D,
}

/// The lockers engaged (a tiny set).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Locks {
    pub front: bool,
    pub centre: bool,
    pub rear: bool,
}
impl Locks {
    pub fn has(&self, l: Locker) -> bool {
        match l {
            Locker::Front => self.front,
            Locker::Centre => self.centre,
            Locker::Rear => self.rear,
        }
    }
    pub fn set(&mut self, l: Locker, on: bool) {
        match l {
            Locker::Front => self.front = on,
            Locker::Centre => self.centre = on,
            Locker::Rear => self.rear = on,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DiffMode {
    Open,
    Lsd,
    Torsen,
    Viscous,
    Locked,
    ViscousCap,
}
impl From<Diff> for DiffMode {
    fn from(d: Diff) -> Self {
        match d {
            Diff::Open => DiffMode::Open,
            Diff::Lsd => DiffMode::Lsd,
            Diff::Torsen => DiffMode::Torsen,
            Diff::Viscous => DiffMode::Viscous,
            Diff::Locked => DiffMode::Locked,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Drivetrain {
    pub r: Resolved,
    pub n: usize,
    // ---- per-wheel state / outputs ----
    pub omega: Vec<f64>,
    pub spin: Vec<f64>,
    pub kappa: Vec<f64>,
    pub alpha: Vec<f64>,
    pub steer: Vec<f64>,
    pub fx: Vec<f64>,
    pub fy: Vec<f64>,
    pub slip: Vec<f64>,
    pub slide_vis: Vec<f64>,
    pub skid_vis: Vec<f64>,
    pub grips: Vec<Grip>,
    pub tread_t: Vec<f64>,
    pub core_t: Vec<f64>,
    pub air_t: Vec<f64>,
    pub wet_t: Vec<f64>,
    pub fire: Vec<f64>,
    fuel: Vec<f64>,
    pub slide_p: Vec<f64>,
    heat_grip: Vec<f64>,
    acc_p: Vec<f64>,
    free: Vec<bool>,
    burn_clutch: u8,
    // ---- powertrain ----
    pub we: f64,
    pub selector: Selector,
    pub gear: i32,
    pub manual: bool,
    pub aids: AidLevel,
    pub low_range: bool,
    pub locks: Locks,
    pub shifting: bool,
    pub load: f64,
    pub clutch: f64,
    pub boost: f64,
    pub regen: f64,
    pub gas: f64,
    pub brake: f64,
    pub braking: bool,
    pub abs_on: bool,
    pub tcs_on: bool,
    pub esc_on: bool,
    pub assist_yaw: f64,
    pub steep_hold: bool,
    pub torque_boost: f64,
    pub steep_climb: bool,
    pub power_scale: f64,
    pub grip_scale: f64,
    pub boost_factor: f64,
    pub idle_creep: bool,
    pub auto4h: bool,
    auto_locked: bool,
    mu_seen: f64,
    pub refused: bool,
    pub mass: f64,
    /// Shift / BOOST held (nitrous).
    pub nitro: bool,

    i: Vec<f64>,
    ieff: Vec<f64>,
    a: Vec<f64>,
    brake_max: Vec<f64>,
    fz_static: Vec<f64>,
    abs_rel: Vec<bool>,
    esc_brake: Vec<f64>,
    acc_fx: Vec<f64>,
    acc_fy: Vec<f64>,
    steer_angle: f64,
    rev_hold: f64,
    shift_t: f64,
    shift_to: i32,
    shift_cool: f64,
    gas_smooth: f64,
    gas_hist: f64,
    limiter_cut: f64,
    tcs: f64,
    lockup: bool,
    cvt: f64,
    t_carrier: f64,
    centre_on: bool,
    last_te: f64,
    slide_hold: f64,
    handbrake: bool,
    tcs_i: f64,
    tcs_brake: Vec<f64>,
    t_ext: Vec<f64>,
    grip_torque: f64,
    w_tyre: Vec<f64>,
    spin0: Vec<f64>,
    hill_start: f64,
    gas_in: f64,
    last_up: f64,
    last_down: f64,
    clock: f64,
}

impl Drivetrain {
    pub fn new(r: Resolved) -> Self {
        let n = r.axles.len() * 2;
        let f = || vec![0.0; n];
        let grips = (0..n)
            .map(|i| Grip {
                mu: 1.0,
                kp: 0.1,
                ap: tyre_kind(r.axles[i >> 1].tyre_kind).peak_alpha,
                crr: 0.012,
                sand: 0.0,
                offroad: 0.0,
            })
            .collect();
        let mut d = Self {
            n,
            omega: f(),
            spin: f(),
            kappa: f(),
            alpha: f(),
            steer: f(),
            fx: f(),
            fy: f(),
            slip: f(),
            slide_vis: f(),
            skid_vis: f(),
            grips,
            tread_t: f(),
            core_t: f(),
            air_t: vec![20.0; n],
            wet_t: f(),
            fire: f(),
            fuel: f(),
            slide_p: f(),
            heat_grip: f(),
            acc_p: f(),
            free: vec![false; n],
            burn_clutch: 0,
            we: r.power.w_idle,
            selector: Selector::D,
            gear: 1,
            manual: false,
            aids: r.aids,
            low_range: false,
            locks: Locks::default(),
            shifting: false,
            load: 0.0,
            clutch: 1.0,
            boost: 0.0,
            regen: 0.0,
            gas: 0.0,
            brake: 0.0,
            braking: false,
            abs_on: false,
            tcs_on: false,
            esc_on: false,
            assist_yaw: 0.0,
            steep_hold: false,
            torque_boost: 1.0,
            steep_climb: false,
            power_scale: 1.0,
            grip_scale: 1.0,
            boost_factor: 1.6,
            idle_creep: false,
            auto4h: true,
            auto_locked: false,
            mu_seen: 1.0,
            refused: false,
            mass: r.mass,
            nitro: false,
            i: r.axles.iter().flat_map(|a| [a.inertia, a.inertia]).collect(),
            ieff: f(),
            a: f(),
            brake_max: f(),
            fz_static: f(),
            abs_rel: vec![false; n],
            esc_brake: f(),
            acc_fx: f(),
            acc_fy: f(),
            steer_angle: 0.0,
            rev_hold: 0.0,
            shift_t: 0.0,
            shift_to: 0,
            shift_cool: 0.0,
            gas_smooth: 0.0,
            gas_hist: 0.0,
            limiter_cut: 0.0,
            tcs: 1.0,
            lockup: false,
            cvt: r.gearbox.range[0],
            t_carrier: 0.0,
            centre_on: false,
            last_te: 0.0,
            slide_hold: 0.0,
            handbrake: false,
            tcs_i: 1.0,
            tcs_brake: f(),
            t_ext: f(),
            grip_torque: 0.0,
            w_tyre: f(),
            spin0: f(),
            hill_start: 9.0,
            gas_in: 0.0,
            last_up: -9.0,
            last_down: -9.0,
            clock: 0.0,
            r,
        };
        d.cool_down();
        let m = d.r.mass;
        d.retune_brakes(m);
        d
    }

    /// Per-wheel maximum brake torque from the deceleration target and the bias, static loads.
    pub fn retune_brakes(&mut self, mass: f64) {
        let na = self.r.axles.len();
        self.mass = mass;
        for i in 0..self.n {
            let k = i >> 1;
            let ax = &self.r.axles[k];
            self.fz_static[i] = (mass * 9.81 * ax.share) / 2.0;
            let share = if na == 1 {
                1.0
            } else if k == 0 {
                self.r.brakes.bias
            } else {
                (1.0 - self.r.brakes.bias) / (na - 1) as f64
            };
            self.brake_max[i] = ((if self.r.brakes.abs { 1.15 } else { 0.92 })
                * self.r.brakes.max_decel
                * 9.81
                * mass
                * ax.radius
                * share)
                / 2.0;
        }
    }

    /// Put the car at rest (teleport / place).
    pub fn reset(&mut self) {
        self.omega.fill(0.0);
        self.alpha.fill(0.0);
        self.kappa.fill(0.0);
        self.we = self.r.power.w_idle;
        self.gear = if self.selector == Selector::R { -1 } else { 1 };
        self.shifting = false;
        self.gas = 0.0;
        self.brake = 0.0;
        self.cool_down();
    }

    pub fn cool_down(&mut self) {
        for i in 0..self.n {
            self.tread_t[i] = self.air_t[i];
            self.core_t[i] = self.air_t[i];
            self.fire[i] = 0.0;
            self.fuel[i] = T::FUEL;
            self.heat_grip[i] = 1.0;
            self.slide_p[i] = 0.0;
        }
    }

    pub fn smoke(&self, i: usize) -> f64 {
        clamp01((self.tread_t[i] - T::SMOKE_FROM) / (T::SMOKE_FULL - T::SMOKE_FROM))
    }

    pub fn burning(&self) -> bool {
        self.fire.iter().any(|&f| f > 0.0)
    }

    /// Internals for the parity tests: tcs, lockup, carrier torque, per-wheel ABS release, ESC and TCS brakes.
    pub fn debug_state(&self) -> (f64, bool, f64, Vec<bool>, Vec<f64>, Vec<f64>, u8) {
        (
            self.tcs,
            self.lockup,
            self.t_carrier,
            self.abs_rel.clone(),
            self.esc_brake.clone(),
            self.tcs_brake.clone(),
            self.burn_clutch,
        )
    }

    /// Per-wheel brake capacity (N·m) and static load (N) — for the parity tests.
    pub fn brake_capacity(&self) -> (&[f64], &[f64]) {
        (&self.brake_max, &self.fz_static)
    }

    pub fn stepped(&self) -> bool {
        matches!(
            self.r.gearbox.kind,
            GearboxKind::Manual | GearboxKind::Auto | GearboxKind::Dct
        )
    }

    // ---------------- driver actions ----------------

    /// Manual mode: one gear up / down (refused if it would over-rev: `refused`).
    pub fn shift_up(&mut self) {
        self.request_shift(1);
    }
    pub fn shift_down(&mut self) {
        self.request_shift(-1);
    }
    fn request_shift(&mut self, d: i32) {
        let n = self.r.gearbox.ratios.len() as i32;
        if !self.stepped() || self.selector != Selector::D || self.shifting {
            return;
        }
        let to = self.gear + d;
        if to < 1 || to > n {
            return;
        }
        let w_out = (self.carrier_speed() * self.ratio_of(to)).abs();
        if w_out > self.r.power.w_redline * 1.02 {
            self.refused = true;
            return;
        }
        self.begin_shift(to);
    }

    /// Low range (only ≤ 8 km/h; part-time 4WD engages 4H with it). False = refused.
    pub fn toggle_low(&mut self, speed: f64) -> bool {
        if self.r.drive.low <= 1.0 || speed.abs() > 2.3 {
            return false;
        }
        self.low_range = !self.low_range;
        if self.low_range
            && (self.r.drive.layout == Layout::PartTime4wd || self.r.drive.lockers.contains(&Locker::Centre))
        {
            self.locks.centre = true;
        }
        true
    }

    /// Cycle the lockers the car has: none → centre → + rear → + front → none.
    pub fn cycle_lockers(&mut self) {
        let order: Vec<Locker> = [Locker::Centre, Locker::Rear, Locker::Front]
            .into_iter()
            .filter(|l| self.r.drive.lockers.contains(l))
            .collect();
        if order.is_empty() {
            return;
        }
        self.auto4h = false;
        self.auto_locked = false;
        if let Some(&next) = order.iter().find(|l| !self.locks.has(**l)) {
            self.locks.set(next, true);
        } else {
            self.locks = Locks::default();
            if self.low_range && self.r.drive.layout == Layout::PartTime4wd {
                self.low_range = false;
            }
        }
    }

    /// Engine speed (rpm).
    pub fn rpm(&self) -> f64 {
        self.we * 30.0 / std::f64::consts::PI
    }

    // ---------------- the step ----------------

    pub fn step(&mut self, dt: f64, input: &DriverInput, ch: &ChassisIn, w: &[WheelIn]) {
        let n = self.n;
        let h = dt / SUBSTEPS as f64;
        let speed = ch.speed;
        self.refused = false;
        let hb_stop = input.handbrake && self.aids == AidLevel::Full && input.steer.abs() < 0.2 && speed.abs() > 1.5;
        self.handbrake = input.handbrake && !hb_stop;
        self.pedals(dt, input, speed);
        if hb_stop {
            self.brake = self.brake.max(0.9);
            self.gas = 0.0;
        }
        self.steering(dt, input, ch);
        if self.auto4h && self.aids != AidLevel::Off && self.r.drive.layout == Layout::PartTime4wd {
            let (mut mu, mut nc) = (0.0, 0);
            for i in 0..n {
                if w[i].contact {
                    mu += self.grips[i].mu / self.grip_scale.max(0.3);
                    nc += 1;
                }
            }
            if nc > 0 {
                self.mu_seen += (mu / nc as f64 - self.mu_seen) * (dt * 2.0).min(1.0);
            }
            if !self.locks.centre && self.mu_seen < 0.7 {
                self.locks.centre = true;
                self.auto_locked = true;
            } else if self.auto_locked && self.mu_seen > 0.8 && !self.low_range {
                self.locks.centre = false;
                self.auto_locked = false;
            }
        }
        self.weights();
        let g = self.ratio_now();
        let gbk = self.r.gearbox.kind;
        let declutch = self.handbrake && matches!(gbk, GearboxKind::Manual | GearboxKind::Dct);
        let coupled = g != 0.0
            && !(self.shifting && gbk == GearboxKind::Manual)
            && self.selector != Selector::P
            && self.selector != Selector::N
            && !declutch;
        self.shift_logic(dt, ch, w);
        self.aids_pre(ch, w);
        if matches!(gbk, GearboxKind::Auto | GearboxKind::Cvt) {
            let sr = if self.we > 1.0 {
                (g * self.carrier_speed()).abs() / self.we
            } else {
                0.0
            };
            if !self.lockup
                && sr > 0.85
                && (if gbk == GearboxKind::Cvt {
                    speed.abs() > 4.0
                } else {
                    self.gear >= 2
                })
                && !self.shifting
            {
                self.lockup = true;
            } else if self.lockup && (sr < 0.7 || self.shifting || self.gear < 2 && gbk == GearboxKind::Auto) {
                self.lockup = false;
            }
        }
        let clutch_mode =
            coupled && (matches!(gbk, GearboxKind::Manual | GearboxKind::Dct | GearboxKind::Single) || self.lockup);
        let p_inertia = self.r.power.inertia;
        for i in 0..n {
            self.ieff[i] = self.i[i]
                + if clutch_mode {
                    p_inertia * g * g * self.a[i]
                } else {
                    0.0
                };
        }
        if let Some(tb) = self.r.power.turbo {
            let spool = ((self.we - 0.5 * tb.from) / (0.5 * tb.from)).clamp(0.0, 1.0);
            self.boost += ((self.gas * 1.5).min(1.0) * spool - self.boost) * (dt / tb.lag).min(1.0);
        }
        self.acc_fx.fill(0.0);
        self.acc_fy.fill(0.0);
        self.acc_p.fill(0.0);
        let mut abs_active = false;
        let eff = self.r.gearbox.efficiency;
        let mut sum_fz = 0.0;
        self.grip_torque = 0.0;
        for i in 0..n {
            if !w[i].contact {
                continue;
            }
            sum_fz += w[i].fz.max(0.0);
            if self.a[i] > 0.0 {
                self.grip_torque += self.grips[i].mu * w[i].fz.max(0.0) * self.r.axles[i >> 1].radius;
            }
        }
        self.spin0.copy_from_slice(&self.spin);
        let abs_car = self.r.brakes.abs;
        let n_axles = self.r.axles.len();
        for _s in 0..SUBSTEPS {
            let mut te = self.engine_torque(coupled, speed, h);
            if coupled && te > 0.0 {
                te *= eff;
            }
            if self.shifting && gbk != GearboxKind::Manual {
                te *= self.r.gearbox.transfer;
            }
            for i in 0..n {
                let wi = &w[i];
                let r = self.r.axles[i >> 1].radius;
                let gp = self.grips[i];
                let (mut fx, mut fy) = (0.0, 0.0);
                if wi.contact && wi.fz > 0.0 {
                    let vden = wi.vx.abs().max(1.5);
                    let k = (self.omega[i] * r - wi.vx) / vden;
                    let ass = wi.vy.atan2(vden);
                    self.alpha[i] += (ass - self.alpha[i]) * (((wi.vx.hypot(wi.vy) + 0.5) / SIGMA) * h).min(1.0);
                    self.kappa[i] = k;
                    let mu = gp.mu * self.heat_grip[i] * (1.0 - 0.1 * (wi.fz / self.fz_static[i] - 1.0)).max(0.6);
                    let t = combined_slip(k, self.alpha[i], &gp);
                    fx = t[0] * mu * wi.fz;
                    fy = t[1] * mu * wi.fz;
                    let sl = self.omega[i] * r - wi.vx;
                    let sg = if sl >= 0.0 { 1.0 } else { -1.0 };
                    let cap_x = (sg * ((sl * self.ieff[i]) / (r * r * h) + self.t_ext[i] / r)).max(0.0);
                    if fx * sg > cap_x {
                        fx = sg * cap_x;
                    }
                    let m_share = if sum_fz > 0.0 {
                        (self.mass * wi.fz) / sum_fz
                    } else {
                        self.mass / n as f64
                    };
                    let cap_y = (m_share * wi.vy.abs()) / dt;
                    if fy.abs() > cap_y {
                        fy = sign(fy) * cap_y;
                    }
                    self.acc_p[i] += (fx * sl).abs() + (fy * wi.vy).abs();
                } else {
                    self.alpha[i] *= 1.0 - (8.0 * h).min(1.0);
                }
                self.acc_fx[i] += fx;
                self.acc_fy[i] += fy;
                self.omega[i] -= ((fx * r) / self.i[i]) * h;
                self.w_tyre[i] = self.omega[i];
                let mut tb = self.brake * self.brake_max[i];
                if i >= 2 {
                    tb *= (wi.fz / self.fz_static[i]).clamp(0.35, 1.0);
                }
                if (abs_car || self.aids == AidLevel::Full)
                    && self.aids != AidLevel::Off
                    && speed.abs() > 2.0
                    && wi.contact
                {
                    if self.kappa[i] < -0.15 {
                        self.abs_rel[i] = true;
                    } else if self.kappa[i] > -0.06 {
                        self.abs_rel[i] = false;
                    }
                    if self.abs_rel[i] && self.brake > 0.05 {
                        tb *= 0.25;
                        abs_active = true;
                    }
                } else {
                    self.abs_rel[i] = false;
                }
                tb += (self.esc_brake[i] + self.tcs_brake[i]) * self.brake_max[i];
                if self.handbrake && (i >> 1) == n_axles - 1 {
                    tb += 1.5 * gp.mu * self.fz_static[i] * r + 0.6 * self.brake_max[i];
                }
                if self.selector == Selector::P {
                    tb += 1e6;
                }
                let crr = gp.crr + gp.sand * 0.1 * self.kappa[i].abs().min(1.0);
                let tf = tb + if wi.contact { crr * wi.fz.max(0.0) * r } else { 0.0 };
                let dw = (tf / self.i[i]) * h;
                self.omega[i] = if self.omega[i].abs() <= dw {
                    0.0
                } else {
                    self.omega[i] - sign(self.omega[i]) * dw
                };
            }
            self.diffs(h);
            self.we += (te / p_inertia) * h;
            if !coupled {
                self.clutch = 0.0;
                self.t_carrier = 0.0;
            } else if clutch_mode {
                self.couple(g, h);
            } else {
                let wt = g * self.carrier_speed();
                let sr = if self.we > 1.0 { wt / self.we } else { 1.0 };
                let mut timp = (self.we / (self.r.gearbox.k / self.torque_boost.sqrt())).powi(2)
                    * (1.0 - sr.min(2.0).powi(2) * sign(sr));
                let tr = if sr < 0.85 { 2.0 - sr / 0.85 } else { 1.0 };
                if (self.aids != AidLevel::Off || self.steep_climb) && timp > 0.0 {
                    timp = timp.min((0.95 * self.grip_torque) / (tr * g).abs());
                }
                self.we -= (timp / p_inertia) * h;
                let tout = timp * tr * g;
                for i in 0..n {
                    if self.a[i] != 0.0 {
                        self.omega[i] += ((tout * self.a[i]) / self.i[i]) * h;
                    }
                }
                self.t_carrier = tout;
                self.clutch = sr.clamp(0.0, 1.0);
            }
            self.we = self.we.max(if self.r.power.kind == PowerKind::Electric {
                -self.r.power.w_redline
            } else {
                self.r.power.w_idle * 0.3
            });
            for i in 0..n {
                self.spin[i] += self.omega[i] * h;
                self.t_ext[i] = ((self.omega[i] - self.w_tyre[i]) * self.i[i]) / h;
            }
        }
        // ---- outputs: averaged forces, low-speed static friction (hill hold) ----
        let creep = self.idle_creep
            && matches!(gbk, GearboxKind::Auto | GearboxKind::Cvt)
            && matches!(self.selector, Selector::D | Selector::R)
            && ch.pitch.abs() < 0.07;
        let hold = self.selector == Selector::P
            || self.brake > 0.05
            || input.handbrake
            || (self.gas < 0.05 && self.selector != Selector::N && !creep);
        if hold {
            self.hill_start = 0.0;
        } else {
            self.hill_start += dt;
        }
        let assist = !hold
            && self.hill_start < (if self.steep_hold { 4.0 } else { 1.5 })
            && speed.abs() < (if self.steep_hold { 3.0 } else { 1.5 })
            && self.selector != Selector::N;
        let dir = if self.selector == Selector::R { -1.0 } else { 1.0 };
        let burn = hold && self.gas > 0.05 && self.brake > 0.05 && self.selector != Selector::P && !input.handbrake;
        let (mut push_f, mut push_r, mut m_held) = (0.0, 0.0, 0.0);
        let subs = SUBSTEPS as f64;
        for i in 0..n {
            let wi = &w[i];
            self.free[i] = burn && wi.contact && wi.fz > 0.0 && self.is_driven(i) && self.omega[i].abs() > 0.05;
            if !wi.contact || wi.fz <= 0.0 {
                continue;
            }
            if self.free[i] {
                let fx = self.acc_fx[i] / subs;
                let fy = self.acc_fy[i] / subs;
                let (c, s) = (self.steer[i].cos(), self.steer[i].sin());
                push_f += fx * c - fy * s;
                push_r += fx * s + fy * c;
            } else {
                m_held += if sum_fz > 0.0 {
                    (self.mass * wi.fz) / sum_fz
                } else {
                    self.mass / n as f64
                };
            }
        }
        for i in 0..n {
            let wi = &w[i];
            let mut fx = self.acc_fx[i] / subs;
            let mut fy = self.acc_fy[i] / subs;
            if wi.contact && wi.fz > 0.0 && assist {
                let m_share = if sum_fz > 0.0 {
                    (self.mass * wi.fz) / sum_fz
                } else {
                    self.mass / n as f64
                };
                let lim = self.grips[i].mu * wi.fz;
                let sx = (-m_share * (wi.hx / dt + wi.gx) - wi.sx).min(lim).max(-lim);
                if sx * dir > fx * dir {
                    fx = sx;
                }
            }
            if wi.contact && wi.fz > 0.0 && hold && !self.free[i] {
                let v = wi.vx.hypot(wi.vy);
                let k = (1.25 - v / (if self.steep_hold { 3.2 } else { 0.64 })).clamp(0.0, 1.0);
                if k > 0.0 {
                    let m_share = if sum_fz > 0.0 {
                        (self.mass * wi.fz) / sum_fz
                    } else {
                        self.mass / n as f64
                    };
                    let mut sx = -m_share * (wi.hx / dt + wi.gx) - wi.sx;
                    let mut sy = -m_share * (wi.hy / dt + wi.gy) - wi.sy;
                    let cap = self.grips[i].mu * wi.fz;
                    if burn && m_held > 0.0 {
                        let share = m_share / m_held;
                        let (c, s) = (self.steer[i].cos(), self.steer[i].sin());
                        sx -= share * (push_f * c + push_r * s);
                        sy -= share * (-push_f * s + push_r * c);
                        let mut tb = self.brake * self.brake_max[i];
                        if i >= 2 {
                            tb *= (wi.fz / self.fz_static[i]).clamp(0.35, 1.0);
                        }
                        let cap_b = tb / self.r.axles[i >> 1].radius;
                        if sx.abs() > cap_b {
                            sx = sign(sx) * cap_b;
                        }
                    }
                    let m = sx.hypot(sy);
                    if m > cap {
                        sx *= cap / m;
                        sy *= cap / m;
                    }
                    fx += (sx - fx) * k;
                    fy += (sy - fy) * k;
                    if k > 0.5 {
                        self.omega[i] = if self.selector == Selector::P || self.brake > 0.05 {
                            0.0
                        } else {
                            wi.vx / self.r.axles[i >> 1].radius
                        };
                        self.spin[i] = self.spin0[i] + self.omega[i] * dt;
                    }
                }
            }
            self.fx[i] = fx;
            self.fy[i] = fy;
            let (mut lat, mut lon) = (0.0, 0.0);
            if wi.contact && wi.fz > 0.0 {
                let gp = &self.grips[i];
                let r = self.r.axles[i >> 1].radius;
                let sx = (self.omega[i] * r - wi.vx).abs();
                let sy = wi.vy.abs();
                lon = clamp01((self.kappa[i].abs() / gp.kp - 1.25) / 1.5) * clamp01((sx - 1.0) / 2.0);
                lat = clamp01((self.alpha[i].tan().abs() / gp.ap.tan() - 1.15) / 1.2) * clamp01((sy - 0.8) / 1.7);
                if self.abs_rel[i] && self.brake > 0.5 && speed.abs() > 8.0 {
                    lon = lon.max(0.45);
                }
            }
            self.slide_vis[i] += (lat - self.slide_vis[i]) * (dt * 12.0).min(1.0);
            self.skid_vis[i] += (lon - self.skid_vis[i]) * (dt * 12.0).min(1.0);
            self.slip[i] = self.slide_vis[i].max(self.skid_vis[i]);
        }
        self.traction(dt, speed, w);
        self.thermal(dt, w);
        self.abs_on = abs_active;
        let tmax = curve_torque(&self.r.power, self.we.max(1.0), self.boost) * self.power_scale;
        self.load = if tmax > 0.0 {
            (self.last_te / tmax).clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }

    // ---------------- internals ----------------

    fn traction(&mut self, dt: f64, speed: f64, w: &[WheelIn]) {
        let n = self.n;
        self.tcs_brake.fill(0.0);
        if (self.aids == AidLevel::Off && !self.steep_climb) || self.gas < 0.05 || self.handbrake {
            self.tcs_i = 1.0;
            self.tcs += (1.0 - self.tcs) * (dt / 0.2).min(1.0);
            self.tcs_on = false;
            return;
        }
        let thr = 1.5 * self.grips[0].kp;
        let (mut k_sum, mut k_n, mut active, mut rim_min) = (0.0, 0, false, f64::INFINITY);
        let vden = speed.abs().max(1.5);
        let dir = if self.selector == Selector::R { -1.0 } else { 1.0 };
        for i in 0..n {
            if self.is_driven(i) {
                rim_min = rim_min.min(self.omega[i].abs() * self.r.axles[i >> 1].radius);
            }
        }
        for i in 0..n {
            if !self.is_driven(i) {
                continue;
            }
            let r = self.r.axles[i >> 1].radius;
            if w[i].contact {
                let v = if self.steep_climb {
                    (speed * dir).max(0.0) * dir
                } else {
                    speed
                };
                k_sum += ((self.omega[i] * r - v) * dir).max(0.0);
                k_n += 1;
            }
            let d = (self.omega[i].abs() * r - rim_min) / vden - 0.08;
            let k = if w[i].contact { self.kappa[i] - thr } else { d };
            if d > 0.0 && k > 0.0 {
                self.tcs_brake[i] = (d.min(k) * 2.5).min(0.8);
                active = true;
            }
        }
        let thr_v = (thr * speed.abs()).max(0.4);
        let err = if speed * dir < -0.1 && !self.steep_climb {
            1.0
        } else {
            (thr_v - if k_n > 0 { k_sum / k_n as f64 } else { 0.0 }) / vden
        };
        self.tcs_i = (self.tcs_i + err * 10.0 * dt).clamp(0.0, 1.0);
        self.tcs = (self.tcs_i + 1.5 * err).clamp(0.0, 1.0);
        self.tcs_on = active || self.tcs < 0.95;
    }

    fn thermal(&mut self, dt: f64, w: &[WheelIn]) {
        for i in 0..self.n {
            let wi = &w[i];
            let r = self.r.axles[i >> 1].radius;
            let sz = (r / 0.39) * (r / 0.39);
            let p = self.acc_p[i] / SUBSTEPS as f64;
            self.slide_p[i] = p;
            let ta = self.air_t[i];
            let sq = (wi.vx.hypot(wi.vy) + T::FAN * (self.omega[i] * r).abs()).sqrt();
            let wet = if wi.contact {
                1.0 + T::WET_COOL * self.wet_t[i]
            } else {
                1.0
            };
            let g_sa = (T::G_SA + T::G_SAV * sq) * sz * wet;
            let g_ba = (T::G_BA + T::G_BAV * sq) * sz;
            let g_sb = T::G_SB * sz;
            let (mut ts, mut tb) = (self.tread_t[i], self.core_t[i]);
            let ut = (self.omega[i] * r).abs().sqrt();
            let ur = wi.vx.hypot(wi.vy).sqrt();
            let mut q =
                T::ETA * ((ut + 0.2) / (ut + ur + 0.4)).max(0.15) * p * (1.0 - T::LOOSE_HEAT * self.grips[i].offroad);
            if self.fire[i] > 0.0 {
                let pyro = (T::PYRO - ts) / 120.0;
                q += (T::FIRE_W * sz * (self.fuel[i] / (0.25 * T::FUEL)).min(1.0) * clamp01(pyro))
                    / (1.0 + wi.vx.abs() / T::BLOW_OFF);
                self.fuel[i] = (self.fuel[i] - dt).max(0.0);
                self.fire[i] = if ts < T::OUT || self.fuel[i] <= 0.0 {
                    0.0
                } else {
                    self.fire[i] + dt
                };
            } else if ts >= T::IGNITE && tb >= T::IGNITE_CORE && self.fuel[i] > 0.0 {
                self.fire[i] = dt;
            }
            let flow_sb = g_sb * (ts - tb);
            ts += ((q - flow_sb - g_sa * (ts - ta)) / (T::C_S * sz)) * dt;
            tb += ((flow_sb - g_ba * (tb - ta)) / (T::C_B * sz)) * dt;
            self.tread_t[i] = ts.min(T::PYRO + 60.0);
            self.core_t[i] = tb;
            let hot = (ts - T::GRIP_FROM) / (T::GRIP_TO - T::GRIP_FROM);
            self.heat_grip[i] = 1.0 - T::GRIP_LOSS * clamp01(hot);
        }
    }

    fn pedals(&mut self, dt: f64, c: &DriverInput, v: f64) {
        let (mut gas, mut brake) = (0.0, 0.0);
        if c.parked {
            self.selector = Selector::P;
            self.gas = 0.0;
            self.brake = 1.0;
            return;
        }
        if c.neutral {
            self.selector = Selector::N;
            self.gas = 0.0;
            self.brake = 0.0;
            return;
        }
        if matches!(self.selector, Selector::P | Selector::N) {
            self.selector = Selector::D;
            self.gear = self.gear.max(1);
        }
        let t = c.throttle;
        let fb = if c.brake > 0.0 { c.brake.min(1.0) } else { 0.0 };
        if fb > 0.0 {
            self.rev_hold = 0.0;
            if self.selector == Selector::R && v > -0.5 {
                self.selector = Selector::D;
                self.gear = 1;
                self.shifting = false;
            }
            if self.selector == Selector::D {
                gas = t.max(0.0);
                brake = fb.max(-t);
            } else {
                brake = fb.max(t.abs());
            }
        } else if self.selector == Selector::D {
            if t >= 0.0 {
                gas = t;
                self.rev_hold = 0.0;
            } else if v > 0.5 {
                brake = -t;
                self.rev_hold = 0.0;
            } else {
                brake = -t;
                self.rev_hold += dt;
                if self.rev_hold > 0.3 {
                    self.selector = Selector::R;
                    self.gear = -1;
                    self.shifting = false;
                }
            }
        } else if t <= 0.0 {
            gas = -t;
            self.rev_hold = 0.0;
        } else if v < -0.5 {
            brake = t;
        } else {
            self.selector = Selector::D;
            self.gear = 1;
            gas = t;
        }
        self.gas_in = gas;
        let (up, down, b) = (dt / 0.25, dt / 0.12, dt / 0.15);
        self.gas = if gas > self.gas {
            gas.min(self.gas + up)
        } else {
            gas.max(self.gas - down)
        };
        self.brake = if brake > self.brake {
            brake.min(self.brake + b)
        } else {
            brake.max(self.brake - b)
        };
        self.braking = self.brake > 0.05 || (self.r.power.kind == PowerKind::Electric && self.regen > 0.3);
        let gbk = self.r.gearbox.kind;
        if self.brake < 0.05 || self.gas < 0.05 || !matches!(gbk, GearboxKind::Manual | GearboxKind::Dct) {
            self.burn_clutch = 0;
        } else if self.burn_clutch == 0
            && self.brake > 0.3
            && self.gas > 0.3
            && v.abs() < 0.5
            && self.carrier_speed().abs() < 0.5
        {
            self.burn_clutch = 1;
        }
        if self.burn_clutch == 1 && self.we > 0.75 * self.r.power.w_redline {
            self.burn_clutch = 2;
        }
    }

    fn steering(&mut self, dt: f64, c: &DriverInput, ch: &ChassisIn) {
        let v = ch.speed.abs();
        let a_rear = ch.rear_vy.atan2(v.max(1.0));
        let slide_k = ((a_rear.abs() - 0.06) / 0.2).clamp(0.0, 1.0) * if c.steer * a_rear > 0.0 { 1.0 } else { 0.0 };
        let r_lock = self.r.steering.lock;
        let mut lock = r_lock / (1.0 + v * 0.06 * (1.0 - slide_k));
        if self.aids != AidLevel::Off && v > 4.0 && slide_k < 0.5 {
            lock = lock.min(
                (((self.r.wheelbase * 1.05 * self.grips[0].mu * ch.g) / (v * v)).atan() + 0.2 * self.grips[0].ap)
                    .max(0.03),
            );
        }
        let mut target = c.steer * lock;
        if self.aids != AidLevel::Off && v > 3.0 && a_rear.abs() > 0.14 {
            target += 0.4 * a_rear;
        }
        target = target.clamp(-r_lock, r_lock);
        let rate = (2.5 + (0.8 - 2.5) * (v / 30.0).min(1.0) * (1.0 - slide_k)) * if c.steer == 0.0 { 1.5 } else { 1.0 };
        let d = target - self.steer_angle;
        self.steer_angle += sign(d) * d.abs().min(rate * dt);
        let last = self.r.axles[self.r.axles.len() - 1].z;
        for k in 0..self.r.axles.len() {
            let ax = &self.r.axles[k];
            let l = (last - ax.z).abs();
            let (mut dl, mut dr) = (0.0, 0.0);
            if ax.steered && l > 0.1 && self.steer_angle.abs() > 1e-4 {
                let rt = l / self.steer_angle.abs().tan();
                let inner = (l / (rt - ax.track / 2.0)).atan();
                let outer = (l / (rt + ax.track / 2.0)).atan();
                let s = sign(self.steer_angle);
                dl = s * if s > 0.0 { outer } else { inner };
                dr = s * if s > 0.0 { inner } else { outer };
            } else if ax.steered {
                dl = self.steer_angle;
                dr = self.steer_angle;
            }
            self.steer[k * 2] = dl;
            self.steer[k * 2 + 1] = dr;
        }
    }

    fn weights(&mut self) {
        let na = self.r.axles.len();
        self.a.fill(0.0);
        self.centre_on = false;
        match self.r.drive.layout {
            Layout::AwdPermanent => {
                let split = self.r.drive.split;
                self.set_axle(0, split);
                for k in 1..na {
                    self.set_axle(k, (1.0 - split) / (na - 1) as f64);
                }
                self.centre_on = true;
            }
            Layout::PartTime4wd => {
                if self.locks.centre || self.low_range {
                    for k in 0..na {
                        self.set_axle(k, 1.0 / na as f64);
                    }
                    self.centre_on = true;
                } else {
                    for k in 1..na {
                        self.set_axle(k, 1.0 / (na - 1) as f64);
                    }
                }
            }
            Layout::AwdOnDemand => self.set_axle(0, 1.0),
            _ => {
                let nd = self.r.axles.iter().filter(|a| a.driven).count();
                for k in 0..na {
                    if self.r.axles[k].driven {
                        self.set_axle(k, 1.0 / nd as f64);
                    }
                }
            }
        }
    }

    fn gear_ratio(&self, k: i32) -> f64 {
        self.r.gearbox.ratios[(k - 1) as usize]
    }

    fn set_axle(&mut self, k: usize, v: f64) {
        self.a[k * 2] = v / 2.0;
        self.a[k * 2 + 1] = v / 2.0;
    }

    fn is_driven(&self, i: usize) -> bool {
        self.a[i] > 0.0 || (self.r.drive.layout == Layout::AwdOnDemand && self.r.axles[i >> 1].driven)
    }

    pub fn is_driven_axle(&self, k: usize) -> bool {
        self.is_driven(k * 2)
    }

    fn any_contact(&self, w: &[WheelIn]) -> bool {
        w.iter().take(self.n).any(|x| x.contact)
    }

    fn ratio_of(&self, gear: i32) -> f64 {
        let gb = &self.r.gearbox;
        let low = if self.low_range { self.r.drive.low } else { 1.0 };
        match gb.kind {
            GearboxKind::Single => (if gear < 0 { -1.0 } else { 1.0 }) * gb.final_ * low,
            GearboxKind::Cvt => (if gear < 0 { -gb.range[0] } else { self.cvt }) * gb.final_ * low,
            _ => {
                if gear == 0 {
                    0.0
                } else {
                    (if gear < 0 {
                        -gb.reverse
                    } else {
                        gb.ratios[(gear - 1) as usize]
                    }) * gb.final_
                        * low
                }
            }
        }
    }

    fn ratio_now(&self) -> f64 {
        if matches!(self.selector, Selector::P | Selector::N) {
            return 0.0;
        }
        self.ratio_of(self.gear)
    }

    fn carrier_speed(&self) -> f64 {
        (0..self.n).map(|i| self.a[i] * self.omega[i]).sum()
    }

    fn engine_torque(&mut self, coupled: bool, speed: f64, h: f64) -> f64 {
        let p = &self.r.power;
        let we = self.we;
        let boost_mul = if self.boost_on() { self.boost_factor } else { 1.0 };
        if p.kind == PowerKind::Electric {
            let aw = we.abs();
            let mut t =
                self.gas * self.tcs * curve_torque(p, aw, 1.0) * self.power_scale * self.torque_boost * boost_mul;
            if aw > p.w_redline * 0.95 {
                t *= ((p.w_redline - aw) / (p.w_redline * 0.05)).max(0.0);
            }
            let fade = ((speed.abs() - 0.5) / 1.5).clamp(0.0, 1.0);
            let rg = if coupled && self.gas < 0.02 {
                p.regen * p.peak_torque * self.power_scale * fade * (1.0 + self.brake)
            } else {
                0.0
            };
            let den = p.regen * p.peak_torque * 2.0;
            self.regen = if p.peak_torque > 0.0 {
                rg / if den != 0.0 { den } else { 1.0 }
            } else {
                0.0
            };
            t -= rg * sign(if we != 0.0 { we } else { 1.0 });
            self.last_te = t;
            return t;
        }
        let idle_thr = (0.12 + ((p.w_idle - we) / p.w_idle) * 3.0).clamp(0.0, 1.0);
        let demand = 1.0 - (1.0 - self.gas) * (1.0 - self.gas);
        let mut thr = (demand * self.tcs).max(idle_thr);
        if self.shifting && self.r.gearbox.kind == GearboxKind::Manual {
            let target = (self.carrier_speed() * self.ratio_of(self.shift_to)).abs();
            thr = if self.shift_to > self.gear || we > target {
                idle_thr
            } else {
                1.0
            };
        }
        let p = &self.r.power;
        if we > p.w_redline {
            self.limiter_cut = 0.05;
        }
        if self.limiter_cut > 0.0 {
            self.limiter_cut -= h;
            thr = 0.0;
        }
        let t_fric = (0.05 + 0.15 * (we / p.w_redline)) * p.peak_torque * self.power_scale;
        let t = thr * curve_torque(p, we, self.boost) * self.power_scale * self.torque_boost * boost_mul
            - (1.0 - thr) * t_fric;
        self.last_te = t;
        t
    }

    fn boost_on(&self) -> bool {
        self.nitro && self.gas > 0.5
    }

    fn couple(&mut self, g: f64, h: f64) {
        let n = self.n;
        let gbk = self.r.gearbox.kind;
        let p_inertia = self.r.power.inertia;
        let cap = if gbk == GearboxKind::Single {
            f64::INFINITY
        } else if self.lockup {
            1.5 * self.r.power.peak_torque * self.power_scale * self.torque_boost * self.boost_factor
        } else {
            let p = &self.r.power;
            let launch = p.w_idle * 1.25 + ((p.w_idle * 1.6).max(p.w_torque[0]) - p.w_idle * 1.25) * self.gas;
            let e = ((self.we - 0.85 * launch) / (0.15 * launch)).clamp(0.0, 1.0);
            let mut cap = e
                * 1.3
                * p.peak_torque
                * self.power_scale
                * self.torque_boost
                * (if self.boost_on() { self.boost_factor } else { 1.0 })
                * self.tcs;
            if self.aids != AidLevel::Off || self.steep_climb {
                cap = cap.min((0.95 * self.grip_torque) / g.abs());
            }
            self.clutch = e;
            if self.burn_clutch == 1 {
                cap = 0.0;
                self.clutch = 0.0;
            }
            cap
        };
        let (mut inv, mut cs) = (1.0 / p_inertia, 0.0);
        for i in 0..n {
            if self.a[i] == 0.0 {
                continue;
            }
            let ga = g * self.a[i];
            inv += (ga * ga) / self.i[i];
            cs += self.a[i] * self.omega[i];
        }
        let c = self.we - g * cs;
        let mut lam = c / inv;
        let lim = cap * h;
        if lam.abs() > lim {
            lam = sign(lam) * lim;
        } else if gbk != GearboxKind::Single && !self.lockup {
            self.clutch = 1.0;
        }
        self.we -= lam / p_inertia;
        for i in 0..n {
            if self.a[i] != 0.0 {
                self.omega[i] += (lam * g * self.a[i]) / self.i[i];
            }
        }
        self.t_carrier = (lam / h) * g;
    }

    fn diffs(&mut self, h: f64) {
        let na = self.r.axles.len();
        let layout = self.r.drive.layout;
        for k in 0..na {
            let ax_driven = self.r.axles[k].driven;
            if !ax_driven && !(self.centre_on || layout == Layout::AwdOnDemand) {
                continue;
            }
            let (l, rr) = (k * 2, k * 2 + 1);
            let locked = (k == 0 && self.locks.front)
                || (k > 0 && self.locks.rear)
                || self.r.axles[k].diff == Diff::Locked
                || self.steep_climb;
            let ta = self.t_carrier.abs() * (self.a[l] + self.a[rr]);
            let mode = if locked {
                DiffMode::Locked
            } else {
                self.r.axles[k].diff.into()
            };
            self.pair(l, rr, mode, ta, h);
        }
        if na < 2 {
            return;
        }
        if layout == Layout::AwdPermanent || (layout == Layout::PartTime4wd && self.centre_on) {
            let mode = if self.locks.centre || layout == Layout::PartTime4wd {
                DiffMode::Locked
            } else {
                self.r.drive.centre.into()
            };
            self.centre(mode, self.t_carrier.abs(), h);
        } else if layout == Layout::AwdOnDemand {
            let dw = self.axle_speed(0) - self.rear_speed();
            self.centre(
                DiffMode::ViscousCap,
                self.t_carrier.abs() * 0.5 * (dw.abs() / 2.0).min(1.0),
                h,
            );
        }
    }

    fn pair(&mut self, l: usize, rr: usize, mode: DiffMode, t_in: f64, h: f64) {
        if mode == DiffMode::Open {
            return;
        }
        let (il, ir) = (self.i[l], self.i[rr]);
        let dw = self.omega[l] - self.omega[rr];
        let peq = dw / (1.0 / il + 1.0 / ir);
        let r = self.r.axles[l >> 1].radius;
        let p = match mode {
            DiffMode::Lsd => {
                let cap = (0.03 * self.mass * 9.81 * r + 0.4 * t_in) * h;
                peq.min(cap).max(-cap)
            }
            DiffMode::Torsen => {
                let cap = 0.5 * t_in * h;
                peq.min(cap).max(-cap)
            }
            DiffMode::Viscous => {
                let c = (0.01 * self.mass * 9.81 * r) * dw * h;
                sign(peq) * peq.abs().min(c.abs())
            }
            _ => peq,
        };
        self.omega[l] -= p / il;
        self.omega[rr] += p / ir;
    }

    fn axle_speed(&self, k: usize) -> f64 {
        (self.omega[k * 2] + self.omega[k * 2 + 1]) / 2.0
    }

    fn rear_speed(&self) -> f64 {
        let na = self.r.axles.len();
        (1..na).map(|k| self.axle_speed(k)).sum::<f64>() / (na - 1) as f64
    }

    fn centre(&mut self, mode: DiffMode, cap_t: f64, h: f64) {
        let i_f = self.i[0] + self.i[1];
        let i_r: f64 = self.i[2..self.n].iter().sum();
        let dw = self.axle_speed(0) - self.rear_speed();
        let peq = dw / (1.0 / i_f + 1.0 / i_r);
        let p = match mode {
            DiffMode::Locked => peq,
            DiffMode::Lsd | DiffMode::Torsen => {
                let cap = (if mode == DiffMode::Torsen { 0.5 } else { 0.4 }) * cap_t * h;
                peq.min(cap).max(-cap)
            }
            DiffMode::Viscous => {
                let c = 0.02 * self.mass * 9.81 * self.r.axles[0].radius * dw * h;
                sign(peq) * peq.abs().min(c.abs())
            }
            DiffMode::ViscousCap => {
                let cap = cap_t * h;
                peq.min(cap).max(-cap)
            }
            DiffMode::Open => 0.0,
        };
        if p == 0.0 {
            return;
        }
        self.omega[0] -= p / i_f;
        self.omega[1] -= p / i_f;
        for i in 2..self.n {
            self.omega[i] += p / i_r;
        }
    }

    fn since_shift(&self, dir: i32) -> f64 {
        self.clock - if dir > 0 { self.last_up } else { self.last_down }
    }

    fn begin_shift(&mut self, to: i32) {
        if to > self.gear {
            self.last_up = self.clock;
        } else {
            self.last_down = self.clock;
        }
        self.shift_to = to;
        self.shift_t = self.r.gearbox.shift;
        self.shifting = true;
        self.shift_cool = 0.8;
        if self.r.gearbox.shift <= 0.0 {
            self.end_shift();
        }
    }

    fn end_shift(&mut self) {
        self.gear = self.shift_to;
        self.shifting = false;
    }

    fn shift_logic(&mut self, dt: f64, ch: &ChassisIn, w: &[WheelIn]) {
        let gbk = self.r.gearbox.kind;
        self.clock += dt;
        self.shift_cool = (self.shift_cool - dt).max(0.0);
        if self.shifting {
            self.shift_t -= dt;
            let swap_at = if gbk == GearboxKind::Manual {
                0.0
            } else {
                self.r.gearbox.shift / 2.0
            };
            if self.shift_t <= swap_at && self.gear != self.shift_to {
                self.gear = self.shift_to;
            }
            if self.shift_t <= 0.0 {
                self.end_shift();
            }
            return;
        }
        let gas_jump = self.gas_in - self.gas_hist;
        self.gas_hist += (self.gas - self.gas_hist) * (dt / 0.2).min(1.0);
        self.gas_smooth += (self.gas - self.gas_smooth) * (dt / 0.3).min(1.0);
        let p = self.r.power.clone();
        if gbk == GearboxKind::Cvt {
            let range = self.r.gearbox.range;
            let w_target = 1.3 * p.w_idle + (0.9 * p.w_power - 1.3 * p.w_idle) * self.gas_smooth;
            let out = self.carrier_speed().abs()
                * self.r.gearbox.final_
                * if self.low_range { self.r.drive.low } else { 1.0 };
            let want = if out > 0.5 {
                range[1].max(range[0].min(w_target / out))
            } else {
                range[0]
            };
            self.cvt += sign(want - self.cvt) * (want - self.cvt).abs().min(dt);
            return;
        }
        if !self.stepped() || self.selector != Selector::D || self.manual {
            return;
        }
        let nr = self.r.gearbox.ratios.len() as i32;
        let red = p.w_redline * if p.kind == PowerKind::Diesel { 0.85 } else { 1.0 };
        let thr = self.gas_smooth.max(0.0).powf(0.8);
        let up_w = (0.42 + (0.93 - 0.42) * thr) * red;
        let mut down_w = (0.24 + (0.42 - 0.24) * self.gas_smooth) * red;
        let pitch_deg = (ch.pitch * 180.0) / std::f64::consts::PI;
        if pitch_deg > 12.0 {
            down_w *= 1.25;
        }
        let w_in = (self.carrier_speed() * self.ratio_of(self.gear)).abs();
        let airborne = !self.any_contact(w);
        let mut spinning = false;
        for i in 0..self.n {
            if self.is_driven(i) && self.kappa[i].abs() > 0.25 {
                spinning = true;
            }
        }
        let v_abs = ch.speed.abs().max(3.0);
        if ch.rear_vy.abs() / v_abs > 0.16 || self.handbrake {
            self.slide_hold = 1.2;
        } else {
            self.slide_hold = (self.slide_hold - dt).max(0.0);
        }
        let hold =
            ch.lat_accel.abs() > 0.4 * ch.g || airborne || spinning || self.shift_cool > 0.0 || self.slide_hold > 0.0;
        let g = self.gear;
        if gas_jump > 0.5 && g > 1 && !airborne && self.slide_hold <= 0.0 {
            for d in [2, 1] {
                let to = g - d;
                if to >= 1 && (w_in * self.gear_ratio(to)) / self.gear_ratio(g) < 0.85 * p.w_redline {
                    return self.begin_shift(to);
                }
            }
        }
        if self.steep_climb && ch.speed.abs() < 14.0 {
            if g > 1 && (w_in * self.gear_ratio(1)) / self.gear_ratio(g) < 0.9 * p.w_redline {
                self.begin_shift(1);
            }
            return;
        }
        if hold {
            return;
        }
        let since_down = self.since_shift(-1);
        let since_up = self.since_shift(1);
        if g < nr && w_in > up_w {
            let w_new = (w_in * self.gear_ratio(g + 1)) / self.gear_ratio(g);
            let t0 = curve_torque(&p, w_in, self.boost);
            let t1 = curve_torque(&p, w_new, self.boost);
            let demand = 1.0 - (1.0 - self.gas_smooth) * (1.0 - self.gas_smooth);
            let need = ((demand * (self.gear_ratio(g) / self.gear_ratio(g + 1)) * t0) / t1.max(1.0)).min(1.0);
            let pedal_new = 1.0 - (1.0 - need).sqrt();
            let down_new = (0.24 + (0.42 - 0.24) * pedal_new) * red;
            if need < 0.95 && w_new > down_new + 0.1 * red && (since_down > 2.5 || w_in > 0.9 * red) {
                return self.begin_shift(g + 1);
            }
            if w_in > 0.93 * red && w_new > down_w {
                return self.begin_shift(g + 1);
            }
        }
        if g > 1
            && w_in < down_w
            && (w_in * self.gear_ratio(g - 1)) / self.gear_ratio(g) < 0.9 * p.w_redline
            && (since_up > 1.5 || w_in < 0.25 * red)
        {
            return self.begin_shift(g - 1);
        }
        if g > 1
            && pitch_deg < -8.0
            && self.gas < 0.02
            && (w_in * self.gear_ratio(g - 1)) / self.gear_ratio(g) < 0.7 * p.w_redline
        {
            self.begin_shift(g - 1);
        }
    }

    fn aids_pre(&mut self, ch: &ChassisIn, w: &[WheelIn]) {
        self.esc_brake.fill(0.0);
        self.esc_on = false;
        if self.aids != AidLevel::Full || self.n < 4 || self.handbrake {
            return;
        }
        let v = ch.speed;
        if v < 5.0 || !self.any_contact(w) {
            return;
        }
        let l = self.r.wheelbase;
        let d = (self.steer[0] + self.steer[1]) / 2.0;
        let mut r_ref = (v * d.tan()) / (l * (1.0 + 0.003 * v * v));
        let lim = (self.grips[0].mu * ch.g) / v;
        r_ref = r_ref.min(lim).max(-lim);
        if self.assist_yaw != 0.0
            && self.assist_yaw.abs() > r_ref.abs()
            && (r_ref == 0.0 || sign(self.assist_yaw) == sign(r_ref))
        {
            r_ref = self.assist_yaw;
        }
        let err = ch.yaw_rate - r_ref;
        if err.abs() < 0.08 {
            return;
        }
        let amt = ((err.abs() - 0.08) * 2.0).min(0.6);
        let refv = if r_ref != 0.0 { r_ref } else { ch.yaw_rate };
        let over = ch.yaw_rate.abs() > r_ref.abs() && sign(ch.yaw_rate) == sign(refv);
        let right = refv > 0.0;
        let last = self.n - 2;
        if over {
            self.esc_brake[if right { 0 } else { 1 }] = amt;
        } else {
            self.esc_brake[last + if right { 1 } else { 0 }] = amt;
            self.tcs = self.tcs.min(1.0 - amt * 0.5);
        }
        self.esc_on = true;
    }
}
