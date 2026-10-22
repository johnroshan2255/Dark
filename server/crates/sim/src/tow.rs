//! TOW ROPES — the winch line from a car's front / rear hook (the game's `gameplay/tow/rope.ts` + `TowSystem.ts`;
//! the numbers and the order are the same, so the car a client predicts is pulled like the server's).
//!
//! A rope comes out of a car's FAIRLEAD (vehicle_hooks.py) to its far end: a player's hand (no pull — the line pays
//! out, at most [`ROPE_MAX`]), a fixed point (a tree, a rock, a post) or another car's hook. It never pushes: past its
//! length it pulls both ends together with a stiff damped spring, at most [`MAX_TENSION`]; the car's driver can reel
//! it in with the winch ([`WINCH_SPEED`]) while the pull stays under [`WINCH_PULL`].
//! The server owns the ropes in a physics room: players ask (protocol `Tow`), it checks the ask against where things
//! are, simulates the lines on the cars it simulates, and sends everyone the list (`Ropes`).

use dark_protocol::{Rope as WireRope, m_to_cm, rope_kind};
use dark_vehicle::World;
use dark_vehicle::rapier3d::prelude::{RigidBodyHandle, Vector};

pub const ROPE_MAX: f32 = 25.0;
pub const ROPE_K: f32 = 60_000.0;
pub const ROPE_C: f32 = 9_000.0;
pub const MAX_TENSION: f32 = 70_000.0;
pub const WINCH_SPEED: f32 = 0.6;
pub const WINCH_PULL: f32 = 45_000.0;
pub const HOOK_REACH: f32 = 1.8;
pub const ROPE_MIN: f32 = 0.6;
/// The server's slack on a player's reach (m): the pose it judges is up to a tick old.
pub const REACH_SLACK: f32 = 1.2;

/// Tension (N) in a line of length `len` whose ends are `d` m apart, separating at `dd` m/s. 0 when slack.
pub fn rope_tension(d: f32, dd: f32, len: f32) -> f32 {
    let stretch = d - len;
    if stretch <= 0.0 {
        return 0.0;
    }
    (ROPE_K * stretch + ROPE_C * dd).clamp(0.0, MAX_TENSION)
}

/// The winch: the line length after `dt` s reeling in under `tension` N (it stalls past [`WINCH_PULL`]).
pub fn winch_in(len: f32, tension: f32, dt: f32) -> f32 {
    if tension > WINCH_PULL {
        return len;
    }
    (len - WINCH_SPEED * dt).max(ROPE_MIN)
}

/// Where a rope's far end is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Far {
    /// In this player's hand.
    Hand(u16),
    /// Hung on a tree / rock / post.
    Fixed([f32; 3]),
    /// Hung on this car's (driver / owner id) hook (wire end).
    Car(u16, u8),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rope {
    pub id: u16,
    /// The car the line comes out of (its driver / owner id) and which end (wire `tow_end`).
    pub car: u16,
    pub end: u8,
    pub far: Far,
    /// Line paid out (m).
    pub len: f32,
}

impl Rope {
    pub fn wire(&self) -> WireRope {
        let (kind, who, end2, pos) = match self.far {
            Far::Hand(p) => (rope_kind::HAND, p, 0, [0; 3]),
            Far::Fixed(p) => (rope_kind::FIXED, 0, 0, [m_to_cm(p[0]), m_to_cm(p[1]), m_to_cm(p[2])]),
            Far::Car(c, e) => (rope_kind::CAR, c, e, [0; 3]),
        };
        WireRope {
            id: self.id,
            car: self.car,
            end: self.end,
            kind,
            who,
            end2,
            pos,
            len: (self.len * 100.0).round().clamp(0.0, u16::MAX as f32) as u16,
        }
    }

    /// Does this rope touch car `c` (out of it or hung on it)?
    pub fn touches(&self, c: u16) -> bool {
        self.car == c || matches!(self.far, Far::Car(o, _) if o == c)
    }
}

/// A car end in the world: its body and the hook points (truck space, m).
#[derive(Clone, Copy, Debug)]
pub struct CarEnd {
    pub body: RigidBodyHandle,
    pub eye: [f64; 3],
    pub fairlead: [f64; 3],
}

/// A point on a body (truck space → world).
pub fn world_point(world: &World, body: RigidBodyHandle, p: [f64; 3]) -> Vector {
    let b = &world.pw.bodies[body];
    b.translation() + *b.rotation() * Vector::new(p[0] as f32, p[1] as f32, p[2] as f32)
}

/// The hook points of a car model (wire model 1…) at `end` (wire `tow_end`).
pub fn hook_pts(model: u8, end: u8) -> Option<([f64; 3], [f64; 3])> {
    let cars = dark_vehicle::cars();
    let def = &cars[(model.max(1) as usize - 1).min(cars.len() - 1)];
    let h = def.dims.hooks?;
    let p = if end == dark_protocol::tow_end::FRONT {
        h.front
    } else {
        h.rear
    }?;
    Some((p.eye, p.fairlead))
}

/// One fixed step of the lines: tension from where the ends are and how fast they part, impulses at the fairlead /
/// far end, the winch on ropes out of a winching driver's car. `end_of(car, end)` finds a car end in the world.
/// The cars a taut line pulls this step go into `pulled` (a car nobody drives then rolls in neutral: TOWED).
pub fn step(
    ropes: &mut [Rope],
    world: &mut World,
    end_of: &dyn Fn(u16, u8) -> Option<CarEnd>,
    winching: &[u16],
    dt: f32,
    pulled: &mut Vec<u16>,
) {
    for r in ropes.iter_mut() {
        let b_end = match r.far {
            Far::Hand(_) => continue,
            Far::Fixed(_) => None,
            Far::Car(c, e) => Some(match end_of(c, e) {
                Some(x) => x,
                None => continue,
            }),
        };
        let Some(a) = end_of(r.car, r.end) else { continue };
        let pa = world_point(world, a.body, a.fairlead);
        let pb = match (r.far, b_end) {
            (Far::Fixed(p), _) => Vector::new(p[0], p[1], p[2]),
            (_, Some(b)) => world_point(world, b.body, b.eye),
            _ => continue,
        };
        let dv = pb - pa;
        let d = dv.length();
        if d < 1e-4 {
            continue;
        }
        let u = dv / d;
        let va = world.pw.bodies[a.body].velocity_at_point(pa);
        let vb = b_end.map_or(Vector::ZERO, |b| world.pw.bodies[b.body].velocity_at_point(pb));
        let dd = (vb - va).dot(u);
        let t = rope_tension(d, dd, r.len);
        if winching.contains(&r.car) {
            r.len = winch_in(r.len, t, dt);
        }
        if t <= 0.0 {
            continue;
        }
        pulled.push(r.car);
        if let Far::Car(c, _) = r.far {
            pulled.push(c);
        }
        let j = u * (t * dt);
        world.pw.bodies[a.body].apply_impulse_at_point(j, pa, true);
        if let Some(b) = b_end {
            world.pw.bodies[b.body].apply_impulse_at_point(-j, pb, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_only_pulls_and_is_capped() {
        assert_eq!(rope_tension(9.0, 5.0, 10.0), 0.0, "slack: no push");
        assert_eq!(rope_tension(10.5, 0.0, 10.0), 30_000.0);
        assert_eq!(rope_tension(12.0, 1.0, 10.0), MAX_TENSION);
        assert_eq!(
            rope_tension(10.1, -2.0, 10.0),
            0.0,
            "closing fast: the damping can't push"
        );
    }

    #[test]
    fn the_winch_stalls_on_a_heavy_pull() {
        assert!((winch_in(10.0, 1_000.0, 1.0) - 9.4).abs() < 1e-5);
        assert_eq!(winch_in(10.0, WINCH_PULL + 1.0, 1.0), 10.0);
        assert_eq!(winch_in(0.7, 0.0, 1.0), ROPE_MIN);
    }

    #[test]
    fn every_car_has_both_hooks() {
        for model in 1..=dark_vehicle::cars().len() as u8 {
            for end in [dark_protocol::tow_end::FRONT, dark_protocol::tow_end::REAR] {
                let (eye, lead) = hook_pts(model, end).expect("hook");
                // front hooks ahead of the front axle, rear behind the rear one; the fairlead nearer the body
                assert!(
                    if end == 0 { eye[2] < -1.3 } else { eye[2] > 1.3 },
                    "model {model} end {end}: {eye:?}"
                );
                assert!(lead[2].abs() < eye[2].abs() && lead[1] > eye[1]);
            }
        }
    }
}
