//! A DRIVER for AI cars: turns "go toward this point at this speed" into the same controls a player sends (stick
//! steer, throttle / brake on one axis). The car then moves only through the physics — no pose is ever written.
//! Pure pursuit on the heading error + a speed loop, like the game's drive probe (`game/scripts/drive-probe.mjs`).

use crate::truck::Controls;

/// What the AI wants this step.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Intent {
    /// A point ahead on the path (world x, z) to steer at.
    pub target: [f64; 2],
    /// Desired forward speed (m/s); 0 = stop and hold (brakes, then parked).
    pub speed: f64,
    /// Race: nitro on straights.
    pub boost: bool,
}

/// Steering gain on the heading error (rad → stick), and the speed loop's gains.
const STEER_K: f64 = 2.2;
const SPEED_K: f64 = 0.35;
const CRUISE: f64 = 0.25;

/// Controls toward `intent` for a car at (x, z) with game heading `heading` (0 = −Z, + left) and forward speed `v`.
pub fn drive(intent: &Intent, x: f64, z: f64, heading: f64, v: f64) -> Controls {
    let (dx, dz) = (intent.target[0] - x, intent.target[1] - z);
    let want = (-dx).atan2(-dz);
    let mut d = want - heading;
    while d > std::f64::consts::PI {
        d -= std::f64::consts::TAU;
    }
    while d < -std::f64::consts::PI {
        d += std::f64::consts::TAU;
    }
    // (+ steer = right; heading + = left)
    let steer = (-d * STEER_K).clamp(-1.0, 1.0);
    if intent.speed <= 0.05 {
        // stopping: brake while rolling, then park (brakes locked, no creep)
        let rolling = v.abs() > 0.4;
        return Controls {
            throttle: if rolling { -1.0 } else { 0.0 },
            steer,
            parked: !rolling,
            ..Default::default()
        };
    }
    let mut pedal = ((intent.speed - v) * SPEED_K + CRUISE).clamp(-1.0, 1.0);
    // never select reverse by braking at a crawl (the stick held back at a standstill reverses after 0.3 s)
    if v < 1.0 && pedal < 0.0 {
        pedal = 0.0;
    }
    Controls {
        throttle: pedal,
        steer,
        boost: intent.boost && d.abs() < 0.1,
        ..Default::default()
    }
}
