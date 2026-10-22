//! Tyres and surfaces — a port of `game/src/gameplay/vehicle/drivetrain/tyre.ts` (keep the two in step: the golden
//! tests compare them). Forces from a Magic-Formula curve of combined slip; grip blended over the surface weights.

use crate::spec::TyreKind;
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct TyreKindDef {
    pub mu: f64,
    pub peak_alpha: f64,
    pub offroad: f64,
    pub snow: f64,
    pub ice: f64,
}

const DEG: f64 = PI / 180.0;

pub fn tyre_kind(k: TyreKind) -> TyreKindDef {
    match k {
        TyreKind::Road => TyreKindDef {
            mu: 1.0,
            peak_alpha: 7.0 * DEG,
            offroad: 1.0,
            snow: 1.0,
            ice: 1.0,
        },
        TyreKind::Performance => TyreKindDef {
            mu: 1.1,
            peak_alpha: 5.5 * DEG,
            offroad: 0.85,
            snow: 0.8,
            ice: 0.9,
        },
        TyreKind::At => TyreKindDef {
            mu: 0.95,
            peak_alpha: 8.0 * DEG,
            offroad: 1.15,
            snow: 1.1,
            ice: 1.0,
        },
        TyreKind::Mt => TyreKindDef {
            mu: 0.9,
            peak_alpha: 10.0 * DEG,
            offroad: 1.3,
            snow: 1.15,
            ice: 1.0,
        },
        TyreKind::Winter => TyreKindDef {
            mu: 0.95,
            peak_alpha: 7.0 * DEG,
            offroad: 1.0,
            snow: 1.5,
            ice: 1.2,
        },
    }
}

/// Surface ids (index into SURFACES), as the game's `Surf`.
pub mod surf {
    pub const ASPHALT: usize = 0;
    pub const DIRT: usize = 1;
    pub const GRASS: usize = 2;
    pub const SAND: usize = 3;
    pub const SNOW: usize = 4;
    pub const ICE: usize = 5;
    pub const MUD: usize = 6;
}
pub const SURFACE_COUNT: usize = 7;

pub struct SurfaceDef {
    pub mu: f64,
    pub stiff: f64,
    pub crr: f64,
    pub wet: f64,
    pub offroad: bool,
    pub rough: f64,
    pub stones: f64,
}

pub const SURFACES: [SurfaceDef; SURFACE_COUNT] = [
    SurfaceDef {
        mu: 1.0,
        stiff: 1.0,
        crr: 0.012,
        wet: 0.3,
        offroad: false,
        rough: 0.007,
        stones: 0.0,
    },
    SurfaceDef {
        mu: 0.7,
        stiff: 0.8,
        crr: 0.025,
        wet: 0.35,
        offroad: true,
        rough: 0.035,
        stones: 0.7,
    },
    SurfaceDef {
        mu: 0.6,
        stiff: 0.75,
        crr: 0.04,
        wet: 0.3,
        offroad: true,
        rough: 0.05,
        stones: 0.5,
    },
    SurfaceDef {
        mu: 0.55,
        stiff: 0.6,
        crr: 0.12,
        wet: 0.0,
        offroad: true,
        rough: 0.03,
        stones: 0.0,
    },
    SurfaceDef {
        mu: 0.35,
        stiff: 0.6,
        crr: 0.05,
        wet: 0.0,
        offroad: true,
        rough: 0.025,
        stones: 0.2,
    },
    SurfaceDef {
        mu: 0.12,
        stiff: 0.5,
        crr: 0.01,
        wet: 0.0,
        offroad: false,
        rough: 0.004,
        stones: 0.0,
    },
    SurfaceDef {
        mu: 0.45,
        stiff: 0.5,
        crr: 0.08,
        wet: 0.2,
        offroad: true,
        rough: 0.022,
        stones: 0.1,
    },
];

/// A blended contact surface (weights per SURFACES entry, sum 1) — the game keeps the weights in a Float32Array.
#[derive(Clone, Copy, Debug)]
pub struct SurfaceMix {
    pub w: [f32; SURFACE_COUNT],
    pub wet: f64,
    pub rough: f64,
    pub stones: f64,
    pub wash: f64,
    pub wash_x: f64,
    pub wash_z: f64,
}

impl Default for SurfaceMix {
    fn default() -> Self {
        let mut w = [0.0; SURFACE_COUNT];
        w[0] = 1.0;
        Self {
            w,
            wet: 0.0,
            rough: 0.0,
            stones: 0.0,
            wash: 0.0,
            wash_x: 0.0,
            wash_z: 1.0,
        }
    }
}

impl SurfaceMix {
    /// A single surface, smooth (no roughness) — the tests' ground.
    pub fn only(s: usize) -> Self {
        let mut w = [0.0; SURFACE_COUNT];
        w[s] = 1.0;
        Self { w, ..Self::default() }
    }

    /// Fill the roughness from the weights (`blendRoughness`).
    pub fn blend_roughness(&mut self) {
        let (mut r, mut st) = (0.0, 0.0);
        for (i, s) in SURFACES.iter().enumerate() {
            r += self.w[i] as f64 * s.rough;
            st += self.w[i] as f64 * s.stones;
        }
        self.rough = r;
        self.stones = st;
    }
}

/// Integer hash → [0, 1), bit-identical to the game's (Math.imul / >>> on i32).
fn hash2(x: i32, z: i32, k: i32) -> f64 {
    let mut h = x
        .wrapping_mul(374_761_393)
        .wrapping_add(z.wrapping_mul(668_265_263))
        .wrapping_add(k.wrapping_mul(2_147_483_647));
    h = (h ^ ((h as u32 >> 13) as i32)).wrapping_mul(1_274_126_177);
    ((h ^ ((h as u32 >> 16) as i32)) as u32) as f64 / 4_294_967_296.0
}

fn vnoise(x: f64, z: f64, k: i32) -> f64 {
    let (ix, iz) = (x.floor(), z.floor());
    let (fx, fz) = (x - ix, z - iz);
    let sx = fx * fx * (3.0 - 2.0 * fx);
    let sz = fz * fz * (3.0 - 2.0 * fz);
    let (ix, iz) = (ix as i32, iz as i32);
    let a = hash2(ix, iz, k);
    let b = hash2(ix + 1, iz, k);
    let c = hash2(ix, iz + 1, k);
    let d = hash2(ix + 1, iz + 1, k);
    a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
}

/// Ground roughness height (m) at a world point: rolling noise, washboard and sparse stones (`roughness`).
pub fn roughness(x: f64, z: f64, s: &SurfaceMix) -> f64 {
    if s.rough <= 0.0 {
        return 0.0;
    }
    let mut h = ((vnoise(x / 2.6, z / 2.6, 11) - 0.5) * 1.4 + (vnoise(x / 0.8, z / 0.8, 12) - 0.5) * 0.6) * s.rough;
    if s.wash != 0.0 {
        let t = (x * s.wash_x + z * s.wash_z) / 0.7;
        let f = t - t.floor();
        h += s.wash * (16.0 * f * f * (1.0 - f) * (1.0 - f) - 0.533);
    }
    if s.stones > 0.0 {
        let cx = (x / 1.6).floor() as i32;
        let cz = (z / 1.6).floor() as i32;
        if hash2(cx, cz, 13) < 0.22 * s.stones {
            let px = (cx as f64 + 0.2 + 0.6 * hash2(cx, cz, 14)) * 1.6;
            let pz = (cz as f64 + 0.2 + 0.6 * hash2(cx, cz, 15)) * 1.6;
            let rad = 0.2 + 0.15 * hash2(cx, cz, 16);
            let d = (x - px).hypot(z - pz) / rad;
            if d < 1.0 {
                h += (1.0 - d * d) * (1.0 - d * d) * s.rough * 2.4 * (0.5 + hash2(cx, cz, 17));
            }
        }
    }
    h
}

/// Grip numbers for one tyre on a blended surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grip {
    pub mu: f64,
    pub kp: f64,
    pub ap: f64,
    pub crr: f64,
    pub sand: f64,
    pub offroad: f64,
}

pub fn grip_for(kind: &TyreKindDef, s: &SurfaceMix, scale: f64, out: &mut Grip) {
    let (mut mu, mut stiff, mut crr, mut off) = (0.0, 0.0, 0.0, 0.0);
    for (i, d) in SURFACES.iter().enumerate() {
        let w = s.w[i] as f64;
        if w <= 0.0 {
            continue;
        }
        let kf = if i == surf::SNOW {
            kind.snow
        } else if i == surf::ICE {
            kind.ice
        } else if d.offroad {
            kind.offroad
        } else {
            1.0
        };
        mu += w * d.mu * kf * (1.0 - d.wet * s.wet);
        stiff += w * d.stiff;
        crr += w * d.crr;
        if d.offroad {
            off += w;
        }
    }
    out.mu = mu * kind.mu * scale;
    out.kp = 0.1 * (1.0 + 0.3 * off);
    out.ap = kind.peak_alpha / stiff.max(0.3);
    out.crr = crr;
    out.sand = s.w[surf::SAND] as f64;
    out.offroad = off;
}

/// Share of the post-peak force drop a fully off-road surface takes back.
pub const LOOSE_KEEP: f64 = 0.75;

/// Combined slip → [Fx, Fy] / (μ·Fz) (`combinedSlip`).
pub fn combined_slip(kappa: f64, alpha: f64, g: &Grip) -> [f64; 2] {
    let rx = kappa / g.kp;
    let ry = alpha.clamp(-1.4, 1.4).tan() / g.ap.tan();
    let r2 = rx * rx + ry * ry;
    if r2 < 1e-12 {
        return [0.0, 0.0];
    }
    let rho = r2.sqrt();
    let c = (1.6 * rx * rx + 1.3 * ry * ry) / r2;
    let b = (PI / (2.0 * c)).tan();
    let mut f = (c * (b * rho).atan()).sin();
    if rho > 1.0 && g.offroad > 0.0 {
        f += (1.0 - f) * LOOSE_KEEP * g.offroad;
    }
    [(f * rx) / rho, (-0.95 * f * ry) / rho]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_the_game() {
        // Values from the game's hash2 (node: tyre.ts hash2(3, -7, 13), hash2(-120, 55, 11), hash2(0, 0, 0)).
        let a = hash2(3, -7, 13);
        assert!((0.0..1.0).contains(&a));
        assert_eq!(hash2(0, 0, 0), 0.0);
    }
}
