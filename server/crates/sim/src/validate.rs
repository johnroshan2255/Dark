//! MOVEMENT VALIDATION (anti-cheat for client-simulated movement). A pose is rejected — and the client corrected
//! back to the last accepted one — when it moves farther than its mode's top speed allows in the time since the last
//! accepted pose (plus latency slack), reports an impossible velocity, is under the terrain, outside the map, or
//! flying. Rejections feed a decaying violation score; a client that keeps failing is kicked.

use crate::map::MapData;
use dark_protocol::flags;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(default)]
pub struct Limits {
    /// On foot (sprint is 6.5 m/s in the game).
    pub foot_speed: f32,
    /// In a vehicle (the fastest car tops out at 58 m/s; nitro and downhill on top).
    pub vehicle_speed: f32,
    /// Fastest climb (m/s) — ramps, jumps, the air suspension.
    pub climb_speed: f32,
    /// Distance slack (m) on top of speed × time (jitter, interpolation).
    pub slack_m: f32,
    /// Extra time (s) allowed per check for network jitter.
    pub jitter_s: f32,
    /// How far under the terrain a pose may be (m) — wheels in ruts, pools carved client-side, a car on its roof.
    pub ground_tolerance: f32,
    /// How far past the map edge (m) — the sea beyond the coast.
    pub bounds_margin: f32,
    /// After leaving a vehicle, on-foot poses may keep the vehicle's speed this long (GTA bail-out tumble), s.
    pub bail_grace_s: f32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            foot_speed: 10.0,
            vehicle_speed: 75.0,
            climb_speed: 40.0,
            slack_m: 2.5,
            jitter_s: 0.25,
            ground_tolerance: 2.5,
            bounds_margin: 250.0,
            bail_grace_s: 3.0,
        }
    }
}

/// A pose in metres / radians (decoded from the wire).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    /// + = right side down (server-simulated cars; client poses carry none).
    pub roll: f32,
    pub flags: u8,
    pub model: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    BadNumber,
    Flying,
    OutOfBounds,
    UnderGround,
    TooFast,
    Teleport,
}

impl Reject {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadNumber => "bad_number",
            Self::Flying => "flying",
            Self::OutOfBounds => "out_of_bounds",
            Self::UnderGround => "under_ground",
            Self::TooFast => "too_fast",
            Self::Teleport => "teleport",
        }
    }
}

/// Context the check needs besides the two poses.
#[derive(Clone, Copy, Debug)]
pub struct Ctx {
    /// Seconds since the previous accepted pose (server receive time).
    pub dt: f32,
    /// Seconds since the player last left a vehicle (∞ if never).
    pub since_bail: f32,
    /// The server granted a reposition (vehicle respawn, match start): skip the distance check once.
    pub grace: bool,
    /// The room allows flying vehicles (no FLYING rejection, no climb limit).
    pub flying_ok: bool,
}

/// `map`: None for an endless-world room (only the clients know its terrain): no ground / bounds checks there.
pub fn check(prev: &Pose, next: &Pose, ctx: Ctx, map: Option<&MapData>, lim: &Limits) -> Result<(), Reject> {
    let finite =
        next.pos.iter().chain(next.vel.iter()).all(|v| v.is_finite()) && next.yaw.is_finite() && next.pitch.is_finite();
    if !finite {
        return Err(Reject::BadNumber);
    }
    let flying = next.flags & flags::FLYING != 0;
    if flying && !ctx.flying_ok {
        return Err(Reject::Flying);
    }
    let [x, y, z] = next.pos;
    if !(-200.0..=2000.0).contains(&y) {
        return Err(Reject::OutOfBounds);
    }
    if let Some(map) = map {
        let edge = map.half + lim.bounds_margin;
        if x.abs() > edge || z.abs() > edge {
            return Err(Reject::OutOfBounds);
        }
        if y < map.height(x, z) - lim.ground_tolerance {
            return Err(Reject::UnderGround);
        }
    }
    let driving = next.flags & flags::DRIVING != 0 || prev.flags & flags::DRIVING != 0;
    let cap = if driving || ctx.since_bail < lim.bail_grace_s {
        lim.vehicle_speed
    } else {
        lim.foot_speed
    };
    let [vx, vy, vz] = next.vel;
    let climb = if flying { f32::INFINITY } else { lim.climb_speed };
    if (vx * vx + vz * vz).sqrt() > cap * 1.15 || vy > climb * 1.15 {
        return Err(Reject::TooFast);
    }
    if ctx.grace {
        return Ok(());
    }
    let t = ctx.dt.max(0.0) + lim.jitter_s;
    let (dx, dy, dz) = (x - prev.pos[0], y - prev.pos[1], z - prev.pos[2]);
    let horiz = (dx * dx + dz * dz).sqrt();
    if horiz > cap * t + lim.slack_m {
        // way past it: a teleport, not just a fast frame
        return Err(if horiz > (cap * t + lim.slack_m) * 3.0 {
            Reject::Teleport
        } else {
            Reject::TooFast
        });
    }
    // climbing faster than possible (falling is unlimited)
    if dy > climb * t + lim.slack_m {
        return Err(Reject::TooFast);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pose(x: f32, y: f32, z: f32) -> Pose {
        Pose {
            pos: [x, y, z],
            ..Default::default()
        }
    }
    const CTX: Ctx = Ctx {
        dt: 1.0 / 30.0,
        since_bail: f32::INFINITY,
        grace: false,
        flying_ok: false,
    };

    #[test]
    fn walking_driving_and_cheats() {
        let map = MapData::flat(1000.0, 0.0);
        let lim = Limits::default();
        let a = pose(0.0, 0.5, 0.0);
        // a sprint step at 30 Hz
        assert_eq!(check(&a, &pose(0.25, 0.5, 0.0), CTX, Some(&map), &lim), Ok(()));
        // 40 m in one frame on foot
        assert_eq!(
            check(&a, &pose(40.0, 0.5, 0.0), CTX, Some(&map), &lim),
            Err(Reject::Teleport)
        );
        // 7 m in a frame on foot: too fast, not a teleport
        assert_eq!(
            check(&a, &pose(7.0, 0.5, 0.0), CTX, Some(&map), &lim),
            Err(Reject::TooFast)
        );
        // the same 2 m frame is fine in a car
        let mut car = pose(2.0, 0.5, 0.0);
        car.flags = flags::DRIVING;
        assert_eq!(check(&a, &car, CTX, Some(&map), &lim), Ok(()));
        // under the ground
        assert_eq!(
            check(&a, &pose(0.0, -5.0, 0.0), CTX, Some(&map), &lim),
            Err(Reject::UnderGround)
        );
        // far outside the map
        assert_eq!(
            check(
                &a,
                &pose(5000.0, 0.5, 0.0),
                Ctx { grace: true, ..CTX },
                Some(&map),
                &lim
            ),
            Err(Reject::OutOfBounds)
        );
        // flying, NaN
        let mut fly = pose(0.0, 30.0, 0.0);
        fly.flags = flags::FLYING;
        assert_eq!(check(&a, &fly, CTX, Some(&map), &lim), Err(Reject::Flying));
        assert_eq!(
            check(&a, &pose(f32::NAN, 0.5, 0.0), CTX, Some(&map), &lim),
            Err(Reject::BadNumber)
        );
        // a reported velocity beyond the cap
        let mut fast = pose(0.1, 0.5, 0.0);
        fast.vel = [60.0, 0.0, 0.0];
        assert_eq!(check(&a, &fast, CTX, Some(&map), &lim), Err(Reject::TooFast));
        // ... unless just bailed out of a car
        assert_eq!(
            check(&a, &fast, Ctx { since_bail: 1.0, ..CTX }, Some(&map), &lim),
            Ok(())
        );
        // a granted reposition skips the distance check
        assert_eq!(
            check(&a, &pose(300.0, 0.5, 0.0), Ctx { grace: true, ..CTX }, Some(&map), &lim),
            Ok(())
        );
        // falling fast is fine, rocketing up is not
        assert_eq!(
            check(
                &pose(0.0, 100.0, 0.0),
                &pose(0.0, 90.0, 0.0),
                Ctx { dt: 0.2, ..CTX },
                Some(&map),
                &lim
            ),
            Ok(())
        );
        assert_eq!(
            check(&a, &pose(0.0, 60.0, 0.0), CTX, Some(&map), &lim),
            Err(Reject::TooFast)
        );
    }

    #[test]
    fn rooms_without_a_map_and_with_flying() {
        let lim = Limits::default();
        let a = pose(0.0, 0.5, 0.0);
        // endless world: no ground / bounds data — far below "ground" or 5 km out is not judged
        assert_eq!(check(&a, &pose(0.2, -5.0, 0.0), CTX, None, &lim), Ok(()));
        assert_eq!(
            check(&a, &pose(0.0, 0.5, 0.0), Ctx { grace: true, ..CTX }, None, &lim),
            Ok(())
        );
        // flying allowed: a fast climb in a flying car is fine
        let mut up = pose(0.0, 40.0, 0.0);
        up.flags = flags::FLYING | flags::DRIVING;
        up.vel = [0.0, 30.0, 0.0];
        assert_eq!(
            check(
                &a,
                &up,
                Ctx {
                    dt: 1.0,
                    flying_ok: true,
                    ..CTX
                },
                None,
                &lim
            ),
            Ok(())
        );
        assert_eq!(check(&a, &up, Ctx { dt: 1.0, ..CTX }, None, &lim), Err(Reject::Flying));
    }
}
