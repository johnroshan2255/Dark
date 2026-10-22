//! SERVER VEHICLE PHYSICS for a map room (docs/VEHICLE_PHYSICS.md): the map's terrain as a Rapier heightfield and the
//! game's car model (`dark_vehicle`). Only fixed maps: an endless world's terrain exists only in the clients.

use crate::map::MapData;
use dark_vehicle::World;

/// A physics world with the map's terrain (the same 2 m grid the clients' chunk heightfields are cut from).
pub fn map_world(map: &MapData) -> World {
    let mut w = World::new();
    let (n, step, origin, heights) = map.height_grid();
    w.add_heightfield(n, step, origin, heights);
    w
}

/// Follows a road polyline: the nearest point near the last one, a look-ahead target, a bend speed.
#[derive(Clone, Debug)]
pub struct RoadFollower {
    pts: Vec<[f32; 3]>,
    closed: bool,
    /// Index of the nearest sample last step; direction along the line (+1 / −1).
    pub at: usize,
    pub dir: i32,
}

impl RoadFollower {
    pub fn new(pts: Vec<[f32; 3]>, closed: bool, at: usize, dir: i32) -> Self {
        Self { pts, closed, at, dir }
    }

    fn idx(&self, i: i64) -> Option<usize> {
        let n = self.pts.len() as i64;
        if self.closed {
            Some(i.rem_euclid(n) as usize)
        } else if (0..n).contains(&i) {
            Some(i as usize)
        } else {
            None
        }
    }

    /// Advance to the car at (x, z); the target point `ahead` m on and the bend-limited speed (≤ `cruise`).
    /// None: the end of an open road (the caller turns round or picks another).
    pub fn update(&mut self, x: f64, z: f64, ahead: f64, cruise: f64) -> Option<([f64; 2], f64)> {
        let mut best = (f64::INFINITY, self.at);
        for k in -6i64..=12 {
            if let Some(i) = self.idx(self.at as i64 + k * self.dir as i64) {
                let p = self.pts[i];
                let d = (p[0] as f64 - x).hypot(p[2] as f64 - z);
                if d < best.0 {
                    best = (d, i);
                }
            }
        }
        self.at = best.1;
        // walk `ahead` m along the line
        let (mut i, mut left) = (self.at as i64, ahead);
        let mut target = None;
        while left > 0.0 {
            let (a, b) = (self.idx(i)?, self.idx(i + self.dir as i64)?);
            let (pa, pb) = (self.pts[a], self.pts[b]);
            let seg = (pb[0] as f64 - pa[0] as f64).hypot(pb[2] as f64 - pa[2] as f64);
            if seg >= left {
                let t = left / seg.max(1e-6);
                target = Some([
                    pa[0] as f64 + (pb[0] - pa[0]) as f64 * t,
                    pa[2] as f64 + (pb[2] - pa[2]) as f64 * t,
                ]);
                break;
            }
            left -= seg;
            i += self.dir as i64;
        }
        // bend speed: the sharpest turn in the next ~40 m at ≤ 3.5 m/s² sideways
        let mut v = cruise;
        let heading = |i: i64| -> Option<f64> {
            let (a, b) = (self.idx(i)?, self.idx(i + self.dir as i64)?);
            Some((self.pts[b][0] - self.pts[a][0]).atan2(self.pts[b][2] - self.pts[a][2]) as f64)
        };
        for k in 1..8i64 {
            let i = self.at as i64 + k * self.dir as i64;
            if let (Some(h0), Some(h1)) = (heading(i - self.dir as i64), heading(i + self.dir as i64)) {
                let mut da = h1 - h0;
                da = da.sin().atan2(da.cos());
                if da.abs() > 1e-3 {
                    v = v.min((3.5 * (10.0 / da.abs())).sqrt().max(4.0));
                }
            }
        }
        target.map(|t| (t, v))
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use dark_vehicle::Truck;
    use dark_vehicle::control::{Intent, drive};
    use dark_vehicle::spec::CarDef;
    use std::path::Path;
    use std::time::Instant;

    fn pickup() -> CarDef {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../vehicle/golden/drive-pickup.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        serde_json::from_value(v["def"].clone()).unwrap()
    }

    struct Bot {
        car: Truck,
        road: RoadFollower,
    }

    /// `n` cars on the island's roads: spread over every road (`spread`) or nose to tail on a few (`packed`: lots
    /// of contacts). Returns (µs per physics step: cars, world; per car; mean speed; upright share).
    fn run(map: &MapData, n: usize, packed: bool, secs: f64) -> (f64, f64, f64, f64, f64) {
        let mut world = map_world(map);
        let def = pickup();
        let roads: Vec<_> = map.roads.iter().filter(|r| r.pts.len() > 40).collect();
        let mut bots: Vec<Bot> = (0..n)
            .map(|k| {
                let (r, at, dir) = if packed {
                    // 4 roads, nose to tail every ~12 m (road samples are ~4 m apart), alternating directions
                    let r = roads[k % 4];
                    (r, 10 + (k / 4) * 3, if k % 8 < 4 { 1 } else { -1 })
                } else {
                    let r = roads[k % roads.len()];
                    let slot = k / roads.len();
                    (
                        r,
                        (r.pts.len() / 7 * (slot + 1)) % r.pts.len(),
                        if k % 2 == 0 { 1 } else { -1 },
                    )
                };
                let at = at.min(r.pts.len() - 2);
                let p = r.pts[at];
                let q = r.pts[if dir > 0 { at + 1 } else { at.saturating_sub(1) }];
                let heading = (-(q[0] - p[0]) as f64).atan2(-(q[2] - p[2]) as f64);
                let mut car = Truck::new(&mut world, &def, None);
                let y = map.height(p[0], p[2]) as f64;
                car.place(&mut world, p[0] as f64, y + 0.1, p[2] as f64, heading, 0.0);
                Bot {
                    car,
                    road: RoadFollower::new(r.pts.clone(), r.closed, at, dir),
                }
            })
            .collect();
        let steps = (secs * 60.0) as usize;
        let (mut t_cars, mut t_world) = (0.0, 0.0);
        let mut vsum = 0.0;
        for s in 0..steps {
            let t0 = Instant::now();
            for b in bots.iter_mut() {
                let p = b.car.position(&world);
                let v = b.car.speed;
                let intent = match b.road.update(p[0], p[2], 4.0 + v.abs() * 0.6, 15.0) {
                    Some((target, speed)) => Intent {
                        target,
                        speed,
                        boost: false,
                    },
                    None => {
                        b.road.dir = -b.road.dir;
                        Intent {
                            target: [p[0], p[2]],
                            speed: 0.0,
                            boost: false,
                        }
                    }
                };
                let heading = b.car.heading(&world);
                b.car.controls = drive(&intent, p[0], p[2], heading, v);
                b.car.step(&mut world, 1.0 / 60.0);
            }
            let t1 = Instant::now();
            world.step();
            let t2 = Instant::now();
            if s >= 60 {
                t_cars += (t1 - t0).as_secs_f64();
                t_world += (t2 - t1).as_secs_f64();
            }
            if s + 1 == steps {
                vsum = bots.iter().map(|b| b.car.speed).sum::<f64>();
            }
        }
        let m = (steps - 60) as f64;
        let upright = bots.iter().filter(|b| b.car.axes(&world).u[1] > 0.7).count() as f64 / n as f64;
        let (c, w) = (t_cars / m * 1e6, t_world / m * 1e6);
        (c, w, (c + w) / n as f64, vsum / n as f64, upright)
    }

    /// `cargo test --release -p dark-sim bench_vehicle_physics -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_vehicle_physics() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        if !dir.exists() {
            return;
        }
        let map = MapData::load(&dir).unwrap();
        println!("island, 60 Hz physics, the game's pickup (drivetrain mode, tyre envelope), 10 s per case:");
        for (n, packed) in [(1, false), (10, false), (100, false), (100, true)] {
            let (c, w, per, v, up) = run(&map, n, packed, 10.0);
            println!(
                "  {n:>3} cars {:<7}: cars {c:>7.0} µs + world {w:>7.0} µs = {:>7.0} µs per step ({:.2} ms per 30 Hz tick, {:.0} % of 33 ms) · {per:.1} µs per car · mean speed {v:.1} m/s · upright {:.0} %",
                if packed { "packed" } else { "spread" },
                c + w,
                2.0 * (c + w) / 1000.0,
                2.0 * (c + w) / 1000.0 / 33.3 * 100.0,
                up * 100.0
            );
        }
    }
}
