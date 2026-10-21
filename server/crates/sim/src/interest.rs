//! INTEREST MANAGEMENT: each client receives only the players that matter to it, at a rate by distance —
//! battle-royale style relevancy tiers. A uniform grid (rebuilt per tick: O(players)) answers "who is within R".
//!
//! | tier | distance | rate |
//! |------|----------|------|
//! | near | ≤ `near_m` | every snapshot tick |
//! | mid  | ≤ `mid_m`  | every `mid_every` ticks |
//! | far  | ≤ `far_m`  | every `far_every` ticks |
//! | —    | beyond     | not sent (removed from the client) |
//!
//! At most `max_entities` (nearest first) per snapshot. Updates within a tier are staggered by entity id so the
//! bandwidth is spread over ticks.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(default)]
pub struct InterestConfig {
    pub near_m: f32,
    pub mid_m: f32,
    pub far_m: f32,
    pub mid_every: u32,
    pub far_every: u32,
    pub max_entities: usize,
}

impl Default for InterestConfig {
    fn default() -> Self {
        Self {
            near_m: 150.0,
            mid_m: 400.0,
            far_m: 900.0,
            mid_every: 2,
            far_every: 6,
            max_entities: 64,
        }
    }
}

/// A grid cell's entities: (id, x, z).
type Cell = Vec<(u16, f32, f32)>;

/// Uniform spatial hash of entity positions (x, z).
pub struct Grid {
    cell: f32,
    cells: HashMap<(i32, i32), Cell>,
}

impl Grid {
    pub fn new(cell: f32) -> Self {
        Self {
            cell,
            cells: HashMap::new(),
        }
    }

    pub fn clear(&mut self) {
        for v in self.cells.values_mut() {
            v.clear();
        }
    }

    fn key(&self, x: f32, z: f32) -> (i32, i32) {
        ((x / self.cell).floor() as i32, (z / self.cell).floor() as i32)
    }

    pub fn insert(&mut self, id: u16, x: f32, z: f32) {
        let k = self.key(x, z);
        self.cells.entry(k).or_default().push((id, x, z));
    }

    /// Every entity within `r` of (x, z) (excluding `skip`) as (id, distance²).
    pub fn query(&self, x: f32, z: f32, r: f32, skip: u16, out: &mut Vec<(u16, f32)>) {
        out.clear();
        let (i0, j0) = self.key(x - r, z - r);
        let (i1, j1) = self.key(x + r, z + r);
        let r2 = r * r;
        for i in i0..=i1 {
            for j in j0..=j1 {
                if let Some(v) = self.cells.get(&(i, j)) {
                    for &(id, ex, ez) in v {
                        let d2 = (ex - x).powi(2) + (ez - z).powi(2);
                        if id != skip && d2 <= r2 {
                            out.push((id, d2));
                        }
                    }
                }
            }
        }
    }
}

/// Which of the `candidates` (id, distance²; within `far_m`) go into this tick's snapshot, nearest first.
/// `known` = ids the client currently has: an entity it doesn't know yet is always sent (so it can appear).
pub fn select(
    cfg: &InterestConfig,
    tick: u32,
    candidates: &mut [(u16, f32)],
    known: impl Fn(u16) -> bool,
    out: &mut Vec<u16>,
) {
    out.clear();
    candidates.sort_by(|a, b| a.1.total_cmp(&b.1));
    let (n2, m2) = (cfg.near_m * cfg.near_m, cfg.mid_m * cfg.mid_m);
    for &(id, d2) in candidates.iter().take(cfg.max_entities) {
        let every = if d2 <= n2 {
            1
        } else if d2 <= m2 {
            cfg.mid_every.max(1)
        } else {
            cfg.far_every.max(1)
        };
        if !known(id) || (tick.wrapping_add(id as u32)) % every == 0 {
            out.push(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_and_tiers() {
        let mut g = Grid::new(64.0);
        for i in 0..100u16 {
            g.insert(i, i as f32 * 20.0, 0.0); // 0, 20, 40 … 1980 m along x
        }
        let mut c = Vec::new();
        g.query(0.0, 0.0, 900.0, 0, &mut c);
        assert_eq!(c.len(), 45); // 20 … 900 m
        let cfg = InterestConfig::default();
        let mut out = Vec::new();
        // all known: over far_every ticks every candidate is sent at least once, near ones every tick
        let mut seen = std::collections::HashMap::<u16, u32>::new();
        for t in 0..cfg.far_every {
            let mut cc = c.clone();
            select(&cfg, t, &mut cc, |_| true, &mut out);
            for &id in &out {
                *seen.entry(id).or_default() += 1;
            }
        }
        assert_eq!(seen.len(), 45);
        assert_eq!(seen[&1], cfg.far_every); // 20 m: every tick
        assert_eq!(seen[&40], 1); // 800 m: once per far_every
        // unknown entities are always sent
        let mut cc = c.clone();
        select(&cfg, 1, &mut cc, |_| false, &mut out);
        assert_eq!(out.len(), 45);
        // the cap keeps the nearest
        let cfg2 = InterestConfig { max_entities: 5, ..cfg };
        let mut cc = c.clone();
        select(&cfg2, 0, &mut cc, |_| false, &mut out);
        assert_eq!(out, vec![1, 2, 3, 4, 5]);
    }
}
