//! The car as DATA, exactly as the game resolves it (`game/src/gameplay/vehicle/drivetrain/spec.ts` `Resolved`,
//! `VehicleSim.ts` `TruckDims` / `TruckTune`). The server never re-derives a spec: the game exports these
//! (`game/scripts/export-vehicles.mjs` → `data/vehicles.json`), so both sides run the same numbers.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum PowerKind {
    #[serde(rename = "petrol")]
    Petrol,
    #[serde(rename = "turbo-petrol")]
    TurboPetrol,
    #[serde(rename = "diesel")]
    Diesel,
    #[serde(rename = "electric")]
    Electric,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GearboxKind {
    Manual,
    Auto,
    Dct,
    Cvt,
    Single,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum Layout {
    #[serde(rename = "FF")]
    Ff,
    #[serde(rename = "FR")]
    Fr,
    #[serde(rename = "MR")]
    Mr,
    #[serde(rename = "RR")]
    Rr,
    #[serde(rename = "AWD-permanent")]
    AwdPermanent,
    #[serde(rename = "AWD-on-demand")]
    AwdOnDemand,
    #[serde(rename = "part-time-4WD")]
    PartTime4wd,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Diff {
    Open,
    Lsd,
    Torsen,
    Viscous,
    Locked,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TyreKind {
    Road,
    Performance,
    At,
    Mt,
    Winter,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AidLevel {
    Off,
    Std,
    Full,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Locker {
    Front,
    Centre,
    Rear,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Turbo {
    pub from: f64,
    pub lag: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    pub kind: PowerKind,
    /// W, N·m, rad/s.
    pub peak_power: f64,
    pub peak_torque: f64,
    pub w_power: f64,
    pub w_torque: [f64; 2],
    pub w_idle: f64,
    pub w_redline: f64,
    pub inertia: f64,
    pub turbo: Option<Turbo>,
    pub regen: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Gearbox {
    pub kind: GearboxKind,
    pub ratios: Vec<f64>,
    pub reverse: f64,
    #[serde(rename = "final")]
    pub final_: f64,
    pub range: [f64; 2],
    pub shift: f64,
    pub efficiency: f64,
    pub transfer: f64,
    #[serde(rename = "K")]
    pub k: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Drive {
    pub layout: Layout,
    pub centre: Diff,
    pub split: f64,
    pub low: f64,
    pub lockers: Vec<Locker>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Axle {
    pub steered: bool,
    pub driven: bool,
    pub diff: Diff,
    pub radius: f64,
    pub tyre_kind: TyreKind,
    pub share: f64,
    pub freq: f64,
    pub zeta: [f64; 2],
    pub travel: f64,
    pub inertia: f64,
    pub arb: f64,
    pub z: f64,
    pub track: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Brakes {
    pub bias: f64,
    pub max_decel: f64,
    pub abs: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Steering {
    pub ratio: f64,
    pub lock: f64,
}

/// `Resolved` (spec.ts): SI numbers the drivetrain runs on.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub mass: f64,
    pub com_height: f64,
    pub com_z: f64,
    pub wheelbase: f64,
    pub power: Power,
    pub gearbox: Gearbox,
    pub drive: Drive,
    pub axles: Vec<Axle>,
    pub brakes: Brakes,
    pub steering: Steering,
    #[serde(rename = "cdA")]
    pub cd_a: f64,
    pub aids: AidLevel,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Half {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Overhang {
    pub front: f64,
    pub rear: f64,
}

/// `TruckDims` (VehicleSim.ts): the body measured from the model (metres, −Z forward, wheelbase-centre origin).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TruckDims {
    pub wheel_pos: Vec<[f64; 3]>,
    pub wheel_radius: f64,
    pub half: Half,
    #[serde(default)]
    pub overhang: Option<Overhang>,
    /// Convex body hulls (xyz…, truck space); absent: the frame + cab boxes collide.
    #[serde(default)]
    pub hulls: Option<Vec<Vec<f32>>>,
    #[serde(default)]
    pub tyre_half_width: Option<f64>,
}

/// `TruckTune` (VehicleSim.ts): the garage setup. kW, kN, ×, ×, N/m per kg, ×, kg.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct TruckTune {
    pub power: f64,
    pub force: f64,
    pub boost: f64,
    pub grip: f64,
    pub suspension: f64,
    pub tyre: f64,
    pub mass: f64,
}

/// One drivable car as the server simulates it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct CarDef {
    pub id: String,
    pub dims: TruckDims,
    /// The catalogue's stock setup (the garage scales the spec relative to it).
    pub stock: TruckTune,
    pub resolved: Resolved,
}

/// Engine torque at ω (rad/s) with turbo boost 0..1 (`curveTorque`, spec.ts).
pub fn curve_torque(p: &Power, w: f64, boost: f64) -> f64 {
    let tp = p.peak_power / p.w_power;
    if p.kind == PowerKind::Electric {
        return p.peak_torque.min(p.peak_power / w.max(1.0));
    }
    let [t0, t1] = p.w_torque;
    let mut t = if w <= t0 {
        let low_frac = if p.kind == PowerKind::Diesel { 0.55 } else { 0.62 };
        let k = smooth(((w - p.w_idle * 0.5) / (t0 - p.w_idle * 0.5).max(1.0)).clamp(0.0, 1.0));
        p.peak_torque * (low_frac + (1.0 - low_frac) * k)
    } else if w <= t1 {
        p.peak_torque
    } else if w <= p.w_power {
        let k = smooth((w - t1) / (p.w_power - t1).max(1.0));
        p.peak_torque + (tp.min(p.peak_torque) - p.peak_torque) * k
    } else {
        let k = (w - p.w_power) / (p.w_redline - p.w_power).max(1.0);
        tp.min(p.peak_torque) * (1.0 - 0.2 * k * k)
    };
    if let Some(tb) = p.turbo {
        let on = smooth(((w - tb.from * 0.6) / (tb.from * 0.4)).clamp(0.0, 1.0));
        t *= 1.0 - 0.45 * (1.0 - boost * on);
    }
    t.max(0.0)
}

fn smooth(x: f64) -> f64 {
    x * x * (3.0 - 2.0 * x)
}
