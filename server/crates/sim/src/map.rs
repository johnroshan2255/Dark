//! A fixed map as the game ships it (`game/public/maps/<id>/`): `map.json` (grid, roads, spawn) and `heights.bin`
//! (Uint16 grid). Heights are sampled exactly like the client's `FixedMap.height` (bilinear on the grid, falling off
//! to a −30 m sea floor over 320 m past the edge), so the server's ground check sees the client's terrain. (The client
//! also carves its desert pools ~1 m into the grid at load — inside the validation tolerance.)

use crate::rng::Rng;
use serde::Deserialize;
use std::path::Path;
use thiserror::Error;

const SEA_FLOOR: f32 = -30.0;
const EDGE_FALLOFF: f32 = 320.0;

#[derive(Debug, Error)]
pub enum MapError {
    #[error("reading {path}: {source}")]
    Io { path: String, source: std::io::Error },
    #[error("parsing map.json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("heights.bin has {got} samples, map.json says {want}")]
    Size { got: usize, want: usize },
    #[error("map has no roads to spawn on")]
    NoRoads,
}

#[derive(Deserialize)]
struct Grid {
    n: usize,
    step: f32,
    min: f32,
    range: f32,
    origin: [f32; 2],
}

#[derive(Deserialize)]
struct Road {
    #[serde(default)]
    name: String,
    #[serde(default)]
    class: String,
    #[serde(default)]
    closed: bool,
    #[serde(rename = "halfWidth")]
    half_width: f32,
    x: Vec<f32>,
    z: Vec<f32>,
    h: Vec<f32>,
    #[serde(default)]
    bridge: Vec<u8>,
}

#[derive(Deserialize)]
struct MapJson {
    id: String,
    half: f32,
    #[serde(rename = "heightOffset")]
    height_offset: f32,
    grid: Grid,
    #[serde(rename = "biomeGrid", default)]
    biome_grid: Option<BiomeGrid>,
    spawn: [f32; 3],
    roads: Vec<Road>,
}

#[derive(Deserialize)]
struct BiomeGrid {
    n: usize,
    step: f32,
    origin: [f32; 2],
}

/// Snow weight above which water is frozen (the game's `ICE_SNOW`, world/types.ts): ice, not water.
pub const ICE_SNOW: f32 = 0.32;

/// A point on a road where a player can start: position (world, y = road surface) and facing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpawnPoint {
    pub pos: [f32; 3],
    pub yaw: f32,
}

/// A road as the map draws it: centreline samples with the surface height (world y), for the bots' road graph.
#[derive(Clone, Debug)]
pub struct RoadLine {
    pub name: String,
    /// "highway", "trail", "track", "pump" …
    pub class: String,
    /// A loop (the last sample joins the first).
    pub closed: bool,
    pub half_width: f32,
    /// (x, y, z) per sample.
    pub pts: Vec<[f32; 3]>,
    /// Per sample: on a bridge deck.
    pub bridge: Vec<bool>,
}

pub struct MapData {
    pub id: String,
    /// Half the map's side (m): the playable square is ±half.
    pub half: f32,
    /// The map's own start point (x, z, yaw) — the lobby.
    pub lobby: [f32; 3],
    heights: Vec<f32>,
    n: usize,
    step: f32,
    origin: [f32; 2],
    /// Road samples ~every 20 m (bridges excluded), for spawns.
    road_points: Vec<SpawnPoint>,
    /// The roads themselves (bots drive them).
    pub roads: Vec<RoadLine>,
    /// Snow weight 0..255 per biome cell (biome.bin's second channel; empty = no biome file), its grid.
    snow: Vec<u8>,
    bn: usize,
    bstep: f32,
    borigin: [f32; 2],
    /// Bot navigation (road graph, water), built on first use.
    pub(crate) nav: std::sync::OnceLock<std::sync::Arc<crate::nav::Nav>>,
}

impl MapData {
    /// Load `<dir>/map.json` + `<dir>/heights.bin`.
    pub fn load(dir: &Path) -> Result<Self, MapError> {
        let read = |f: &str| {
            let p = dir.join(f);
            std::fs::read(&p).map_err(|source| MapError::Io {
                path: p.display().to_string(),
                source,
            })
        };
        let meta: MapJson = serde_json::from_slice(&read("map.json")?)?;
        let raw = read("heights.bin")?;
        // the biomes (optional): where the water is frozen (a lake / sea in the snow is ice — drive on it, no boats)
        let bio = if meta.biome_grid.is_some() {
            read("biome.bin").ok()
        } else {
            None
        };
        let mut m = Self::from_parts(meta, &raw)?;
        if let Some(b) = bio
            && b.len() == m.bn * m.bn * 2
        {
            m.snow = b.chunks_exact(2).map(|c| c[1]).collect();
        }
        Ok(m)
    }

    /// Snow weight 0..1 at (x, z) (nearest biome cell, clamped to the map's edge like the game's `FixedMap.biome`).
    pub fn snow(&self, x: f32, z: f32) -> f32 {
        if self.snow.is_empty() {
            return 0.0;
        }
        let i = (((x - self.borigin[0]) / self.bstep).round().max(0.0) as usize).min(self.bn - 1);
        let j = (((z - self.borigin[1]) / self.bstep).round().max(0.0) as usize).min(self.bn - 1);
        self.snow[j * self.bn + i] as f32 / 255.0
    }

    /// Water at (x, z) is frozen (ice to stand / drive on).
    pub fn frozen(&self, x: f32, z: f32) -> bool {
        self.snow(x, z) > ICE_SNOW
    }

    /// The SOLID surface: the terrain, or the ice at the water level where the water is frozen (`WorldFields.surface`).
    pub fn surface(&self, x: f32, z: f32) -> f32 {
        let h = self.height(x, z);
        if h < crate::noise::WATER && self.frozen(x, z) {
            crate::noise::WATER
        } else {
            h
        }
    }

    fn from_parts(meta: MapJson, raw: &[u8]) -> Result<Self, MapError> {
        let g = &meta.grid;
        let want = g.n * g.n;
        if raw.len() != want * 2 {
            return Err(MapError::Size {
                got: raw.len() / 2,
                want,
            });
        }
        let k = g.range / 65535.0;
        let off = g.min + meta.height_offset;
        let heights = raw
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]) as f32 * k + off)
            .collect();
        let mut road_points = Vec::new();
        for r in &meta.roads {
            let mut acc = 20.0f32;
            for i in 1..r.x.len().min(r.z.len()).min(r.h.len()) {
                let (dx, dz) = (r.x[i] - r.x[i - 1], r.z[i] - r.z[i - 1]);
                acc += (dx * dx + dz * dz).sqrt();
                let on_bridge = r.bridge.get(i).copied().unwrap_or(0) != 0;
                if acc >= 20.0 && !on_bridge && r.half_width >= 2.0 {
                    acc = 0.0;
                    // facing along the road: forward = (−sin yaw, −cos yaw)
                    road_points.push(SpawnPoint {
                        pos: [r.x[i], r.h[i] + meta.height_offset + 0.6, r.z[i]],
                        yaw: (-dx).atan2(-dz),
                    });
                }
            }
        }
        if road_points.is_empty() {
            return Err(MapError::NoRoads);
        }
        let roads = meta
            .roads
            .iter()
            .map(|r| {
                let n = r.x.len().min(r.z.len()).min(r.h.len());
                RoadLine {
                    name: r.name.clone(),
                    class: r.class.clone(),
                    closed: r.closed,
                    half_width: r.half_width,
                    pts: (0..n).map(|i| [r.x[i], r.h[i] + meta.height_offset, r.z[i]]).collect(),
                    bridge: (0..n).map(|i| r.bridge.get(i).copied().unwrap_or(0) != 0).collect(),
                }
            })
            .collect();
        Ok(Self {
            id: meta.id,
            half: meta.half,
            lobby: meta.spawn,
            heights,
            n: g.n,
            step: g.step,
            origin: g.origin,
            road_points,
            roads,
            snow: Vec::new(),
            bn: meta.biome_grid.as_ref().map_or(0, |b| b.n),
            bstep: meta.biome_grid.as_ref().map_or(1.0, |b| b.step),
            borigin: meta.biome_grid.as_ref().map_or([0.0; 2], |b| b.origin),
            nav: std::sync::OnceLock::new(),
        })
    }

    /// Terrain height (world y) at (x, z) — `FixedMap.height`.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let cx = x.clamp(-self.half, self.half);
        let cz = z.clamp(-self.half, self.half);
        let gx = (cx - self.origin[0]) / self.step;
        let gz = (cz - self.origin[1]) / self.step;
        let i = (gx.floor() as usize).min(self.n - 2);
        let j = (gz.floor() as usize).min(self.n - 2);
        let (fx, fz) = (gx - i as f32, gz - j as f32);
        let h = &self.heights;
        let n = self.n;
        let (a, b, c, d) = (
            h[j * n + i],
            h[j * n + i + 1],
            h[(j + 1) * n + i],
            h[(j + 1) * n + i + 1],
        );
        let y = a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
        let out = (x.abs() - self.half).max(z.abs() - self.half);
        if out <= 0.0 {
            return y;
        }
        let t = (out / EDGE_FALLOFF).min(1.0);
        y + (SEA_FLOOR - y) * t * t * (3.0 - 2.0 * t)
    }

    /// Up to `count` road spawn points at least `spacing` m apart, in a seeded random order.
    pub fn spawn_points(&self, count: usize, spacing: f32, rng: &mut Rng) -> Vec<SpawnPoint> {
        let mut pts = self.road_points.clone();
        rng.shuffle(&mut pts);
        let mut out: Vec<SpawnPoint> = Vec::with_capacity(count);
        for p in pts {
            if out.len() >= count {
                break;
            }
            let far = out.iter().all(|q| {
                let (dx, dz) = (q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]);
                dx * dx + dz * dz >= spacing * spacing
            });
            if far {
                out.push(p);
            }
        }
        // not enough far-apart points: fill from the rest, ignoring the spacing
        let mut i = 0;
        while out.len() < count {
            out.push(self.road_points[i % self.road_points.len()]);
            i += 1;
        }
        out
    }

    /// Lobby spawn for the `k`-th player: a ring round the map's start point.
    pub fn lobby_spawn(&self, k: usize) -> SpawnPoint {
        let a = k as f32 * 2.399_963; // golden angle
        let r = 4.0 + 2.5 * (k as f32).sqrt();
        let (x, z) = (self.lobby[0] + a.cos() * r, self.lobby[1] + a.sin() * r);
        SpawnPoint {
            pos: [x, self.height(x, z) + 0.6, z],
            yaw: self.lobby[2],
        }
    }

    /// Number of road spawn points (diagnostics).
    pub fn road_point_count(&self) -> usize {
        self.road_points.len()
    }

    #[cfg(test)]
    pub(crate) fn flat(half: f32, y: f32) -> Self {
        let n = 3;
        let step = half;
        Self {
            id: "flat".into(),
            half,
            lobby: [0.0, 0.0, 0.0],
            heights: vec![y; n * n],
            n,
            step,
            origin: [-half, -half],
            road_points: (0..400)
                .map(|i| SpawnPoint {
                    pos: [
                        ((i % 20) as f32 - 10.0) * 40.0,
                        y + 0.6,
                        ((i / 20) as f32 - 10.0) * 40.0,
                    ],
                    yaw: 0.0,
                })
                .collect(),
            roads: Vec::new(),
            snow: Vec::new(),
            bn: 0,
            bstep: 1.0,
            borigin: [0.0; 2],
            nav: std::sync::OnceLock::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_map_and_edge_falloff() {
        let m = MapData::flat(1000.0, 12.0);
        assert!((m.height(0.0, 0.0) - 12.0).abs() < 1e-4);
        assert!((m.height(999.0, -999.0) - 12.0).abs() < 1e-4);
        assert!((m.height(1000.0 + EDGE_FALLOFF, 0.0) - SEA_FLOOR).abs() < 1e-3);
        let mut rng = Rng::new(3);
        let pts = m.spawn_points(50, 60.0, &mut rng);
        assert_eq!(pts.len(), 50);
        for (i, a) in pts.iter().enumerate() {
            for b in &pts[i + 1..] {
                let d = ((a.pos[0] - b.pos[0]).powi(2) + (a.pos[2] - b.pos[2]).powi(2)).sqrt();
                assert!(d >= 60.0 - 1e-3);
            }
        }
    }

    /// The real island (skipped if the game folder isn't next to the server).
    #[test]
    fn loads_the_island() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        if !dir.exists() {
            return;
        }
        let m = MapData::load(&dir).expect("island loads");
        assert_eq!(m.id, "island");
        assert!(m.road_point_count() > 500, "{}", m.road_point_count());
        let s = m.lobby_spawn(0);
        assert!(s.pos[1] > m.height(s.pos[0], s.pos[2]));
        // the sea in the south-west is below the water line; the summit road's top matches the game's height
        // there (the island's road profiles, map.json: summit_west starts at 206.6 m)
        assert!(m.height(-1000.0, 1000.0) < -6.0);
        assert!(
            (m.height(-575.1, -305.8) - 206.6).abs() < 1.0,
            "{}",
            m.height(-575.1, -305.8)
        );
    }
}
