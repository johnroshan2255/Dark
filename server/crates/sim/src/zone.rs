//! The battle-royale SAFE ZONE: a circle that waits, then closes to a smaller circle inside it, stage after stage.
//! Each next circle lies wholly inside the current one (centre offset ≤ R − r) and is centred on land.

use crate::map::MapData;
use crate::rng::Rng;
use dark_protocol::{Zone, m_to_cm};
use serde::Deserialize;

/// One stage: hold the current circle `wait_s`, then close to `radius_factor` × its radius over `shrink_s`;
/// players outside take `dps` HP per second during the stage.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Stage {
    pub wait_s: f32,
    pub shrink_s: f32,
    pub radius_factor: f32,
    pub dps: f32,
}

/// Default schedule for a ~2.4 km map (~14 min): wide early circles, fast late ones.
pub fn default_stages() -> Vec<Stage> {
    vec![
        Stage {
            wait_s: 120.0,
            shrink_s: 90.0,
            radius_factor: 0.6,
            dps: 1.0,
        },
        Stage {
            wait_s: 90.0,
            shrink_s: 75.0,
            radius_factor: 0.55,
            dps: 2.0,
        },
        Stage {
            wait_s: 75.0,
            shrink_s: 60.0,
            radius_factor: 0.5,
            dps: 4.0,
        },
        Stage {
            wait_s: 60.0,
            shrink_s: 45.0,
            radius_factor: 0.45,
            dps: 7.0,
        },
        Stage {
            wait_s: 45.0,
            shrink_s: 35.0,
            radius_factor: 0.4,
            dps: 10.0,
        },
        Stage {
            wait_s: 30.0,
            shrink_s: 30.0,
            radius_factor: 0.0,
            dps: 16.0,
        },
    ]
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Circle {
    pub x: f32,
    pub z: f32,
    pub r: f32,
}

impl Circle {
    pub fn contains(&self, x: f32, z: f32) -> bool {
        let (dx, dz) = (x - self.x, z - self.z);
        dx * dx + dz * dz <= self.r * self.r
    }
}

pub struct ZoneState {
    stages: Vec<Stage>,
    /// Stage index (stages.len() = the final circle holds).
    stage: usize,
    /// Match time (ms) the current stage began.
    stage_start_ms: u64,
    from: Circle,
    to: Circle,
}

impl ZoneState {
    /// The first circle covers the whole map; its first target is chosen at once.
    pub fn new(map: &MapData, stages: Vec<Stage>, start_ms: u64, rng: &mut Rng) -> Self {
        let first = Circle {
            x: 0.0,
            z: 0.0,
            r: map.half * std::f32::consts::SQRT_2,
        };
        let mut z = Self {
            stages,
            stage: 0,
            stage_start_ms: start_ms,
            from: first,
            to: first,
        };
        z.to = z.pick_next(map, first, rng);
        z
    }

    fn pick_next(&self, map: &MapData, cur: Circle, rng: &mut Rng) -> Circle {
        let Some(st) = self.stages.get(self.stage) else {
            return cur;
        };
        let r = (cur.r * st.radius_factor).max(0.0);
        let slack = (cur.r - r).max(0.0);
        // up to 32 tries for a centre on land and inside the map; else the current centre
        for _ in 0..32 {
            let a = rng.range(0.0, std::f32::consts::TAU);
            let d = slack * rng.f32().sqrt();
            let (x, z) = (cur.x + a.cos() * d, cur.z + a.sin() * d);
            if x.abs() < map.half * 0.92 && z.abs() < map.half * 0.92 && map.height(x, z) > -5.0 {
                return Circle { x, z, r };
            }
        }
        Circle { x: cur.x, z: cur.z, r }
    }

    fn wait_ms(&self) -> u64 {
        self.stages.get(self.stage).map_or(0, |s| (s.wait_s * 1000.0) as u64)
    }
    fn shrink_ms(&self) -> u64 {
        self.stages
            .get(self.stage)
            .map_or(0, |s| (s.shrink_s * 1000.0).max(1.0) as u64)
    }

    /// Advance to `now_ms`; true when a new stage began (send [`ZoneState::wire`] again).
    pub fn update(&mut self, map: &MapData, now_ms: u64, rng: &mut Rng) -> bool {
        let mut changed = false;
        while self.stage < self.stages.len() && now_ms >= self.stage_start_ms + self.wait_ms() + self.shrink_ms() {
            self.stage_start_ms += self.wait_ms() + self.shrink_ms();
            self.from = self.to;
            self.stage += 1;
            self.to = self.pick_next(map, self.from, rng);
            changed = true;
        }
        changed
    }

    /// The circle at `now_ms` (interpolated while closing).
    pub fn circle(&self, now_ms: u64) -> Circle {
        if self.stage >= self.stages.len() {
            return self.to;
        }
        let t0 = self.stage_start_ms + self.wait_ms();
        if now_ms <= t0 {
            return self.from;
        }
        let k = ((now_ms - t0) as f32 / self.shrink_ms() as f32).min(1.0);
        Circle {
            x: self.from.x + (self.to.x - self.from.x) * k,
            z: self.from.z + (self.to.z - self.from.z) * k,
            r: self.from.r + (self.to.r - self.from.r) * k,
        }
    }

    /// HP per second outside the circle now.
    pub fn dps(&self) -> f32 {
        let i = self.stage.min(self.stages.len().saturating_sub(1));
        self.stages.get(i).map_or(0.0, |s| s.dps)
    }

    /// The zone packet (times relative to `match_start_ms`).
    pub fn wire(&self, match_start_ms: u64) -> Zone {
        let rel = |t: u64| t.saturating_sub(match_start_ms).min(u32::MAX as u64) as u32;
        let shrink_start = self.stage_start_ms + self.wait_ms();
        Zone {
            x: m_to_cm(self.from.x),
            z: m_to_cm(self.from.z),
            radius: m_to_cm(self.from.r).max(0) as u32,
            target_x: m_to_cm(self.to.x),
            target_z: m_to_cm(self.to.z),
            target_radius: m_to_cm(self.to.r).max(0) as u32,
            shrink_start_ms: rel(shrink_start),
            shrink_end_ms: rel(shrink_start + self.shrink_ms()),
            dps: self.dps().round().clamp(0.0, 255.0) as u8,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circles_nest_and_close() {
        let map = MapData::flat(1200.0, 10.0);
        let mut rng = Rng::new(11);
        let mut z = ZoneState::new(&map, default_stages(), 0, &mut rng);
        let mut prev = z.circle(0);
        let mut t = 0u64;
        let mut stages = 0;
        while t < 30 * 60 * 1000 {
            t += 500;
            if z.update(&map, t, &mut rng) {
                stages += 1;
            }
            let c = z.circle(t);
            assert!(c.r <= prev.r + 1e-3, "radius grew");
            // the new circle stays inside the old one (allowing float slack)
            let d = ((c.x - prev.x).powi(2) + (c.z - prev.z).powi(2)).sqrt();
            assert!(
                d + c.r <= prev.r + 0.5,
                "circle left its parent: d {d} r {} R {}",
                c.r,
                prev.r
            );
            prev = c;
        }
        assert_eq!(stages, default_stages().len());
        assert!(prev.r < 1.0);
        assert!(z.dps() >= 16.0);
    }
}
