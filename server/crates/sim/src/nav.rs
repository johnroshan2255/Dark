//! BOT NAVIGATION on a fixed map: the ROAD GRAPH (the map's roads split where they meet: nodes at ends and
//! junctions, edges between), a nearest-road index, Dijkstra routes, and the WATER (a shore-distance grid from the
//! heights, shore entry points, A* through open water). Built once per map (`MapData::nav`), shared by every room.

use crate::fasthash::FastMap;
use crate::map::MapData;
use crate::noise::WATER;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::sync::Arc;

/// A road prepared for driving: centreline (x, y, z), cumulative length, per-sample bridge flag.
pub struct Road {
    pub class: String,
    pub closed: bool,
    pub half_width: f32,
    pts: Vec<[f32; 3]>,
    cum: Vec<f32>,
    bridge: Vec<bool>,
    pub len: f32,
}

/// A point on a road: position, unit travel direction (along increasing s), half width, on a bridge.
#[derive(Clone, Copy, Debug, Default)]
pub struct RoadPt {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub dx: f32,
    pub dz: f32,
    pub bridge: bool,
}

impl Road {
    /// The point at arc length `s` (wrapped on a loop, clamped otherwise).
    pub fn at(&self, s: f32) -> RoadPt {
        let s = if self.closed {
            s.rem_euclid(self.len)
        } else {
            s.clamp(0.0, self.len)
        };
        let n = self.pts.len();
        // binary search the segment
        let (mut lo, mut hi) = (0usize, self.cum.len() - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.cum[mid] <= s {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let a = self.pts[lo];
        let b = self.pts[(lo + 1) % n];
        let seg = (self.cum[lo + 1] - self.cum[lo]).max(1e-4);
        let t = ((s - self.cum[lo]) / seg).clamp(0.0, 1.0);
        let (dx, dz) = (b[0] - a[0], b[2] - a[2]);
        let l = (dx * dx + dz * dz).sqrt().max(1e-4);
        RoadPt {
            x: a[0] + dx * t,
            y: a[1] + (b[1] - a[1]) * t,
            z: a[2] + dz * t,
            dx: dx / l,
            dz: dz / l,
            bridge: self.bridge[lo] || self.bridge[(lo + 1) % n],
        }
    }

    /// Cruise speed for this class of road (m/s).
    pub fn speed(&self) -> f32 {
        match self.class.as_str() {
            "highway" => 22.0,
            "track" => 18.0,
            "pump" => 8.0,
            _ => 14.0,
        }
    }

    /// Nearest point to (x, z): (s, distance).
    fn project(&self, x: f32, z: f32) -> (f32, f32) {
        let n = self.pts.len();
        let segs = if self.closed { n } else { n - 1 };
        let mut best = (0.0, f32::INFINITY);
        for i in 0..segs {
            let a = self.pts[i];
            let b = self.pts[(i + 1) % n];
            let (dx, dz) = (b[0] - a[0], b[2] - a[2]);
            let l2 = (dx * dx + dz * dz).max(1e-6);
            let t = (((x - a[0]) * dx + (z - a[2]) * dz) / l2).clamp(0.0, 1.0);
            let (px, pz) = (a[0] + dx * t, a[2] + dz * t);
            let d = ((x - px).powi(2) + (z - pz).powi(2)).sqrt();
            if d < best.1 {
                best = (self.cum[i] + (self.cum[i + 1] - self.cum[i]) * t, d);
            }
        }
        best
    }
}

/// A stretch of road between two nodes: road `road` from `s0` to `s1` (s1 > s0; past the length on a loop).
#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub road: usize,
    pub s0: f32,
    pub s1: f32,
    pub a: usize,
    pub b: usize,
}

impl Edge {
    pub fn len(&self) -> f32 {
        self.s1 - self.s0
    }
}

/// A junction or a road end: (edge, forward) for each way out (forward = travel from s0 to s1).
pub struct Node {
    pub x: f32,
    pub z: f32,
    pub out: Vec<(usize, bool)>,
}

/// Where a bot is on the road graph: edge, distance travelled along it in the travel direction, direction.
#[derive(Clone, Copy, Debug)]
pub struct OnEdge {
    pub edge: usize,
    pub forward: bool,
    /// Metres from the start of the travel (0 … edge length).
    pub t: f32,
}

/// Shore crossing: a land point and the water point it leads into.
#[derive(Clone, Copy, Debug)]
pub struct Shore {
    pub land: [f32; 2],
    pub water: [f32; 2],
}

/// The water of a map: shore distance per cell (m, 0 on land).
pub struct WaterGrid {
    pub x0: f32,
    pub z0: f32,
    pub cell: f32,
    pub nx: usize,
    pub nz: usize,
    pub dist: Vec<f32>,
}

impl WaterGrid {
    /// Shore distance at a point (bilinear; 0 off the grid).
    pub fn dist_at(&self, x: f32, z: f32) -> f32 {
        let fx = (x - self.x0) / self.cell;
        let fz = (z - self.z0) / self.cell;
        if fx < 0.0 || fz < 0.0 || fx >= (self.nx - 1) as f32 || fz >= (self.nz - 1) as f32 {
            return 0.0;
        }
        let (i, j) = (fx as usize, fz as usize);
        let (tx, tz) = (fx - i as f32, fz - j as f32);
        let n = self.nx;
        let d = &self.dist;
        let (a, b, c, e) = (
            d[j * n + i],
            d[j * n + i + 1],
            d[(j + 1) * n + i],
            d[(j + 1) * n + i + 1],
        );
        a + (b - a) * tx + (c - a) * tz + (a - b - c + e) * tx * tz
    }

    fn cell_of(&self, x: f32, z: f32) -> Option<usize> {
        let i = ((x - self.x0) / self.cell).round();
        let j = ((z - self.z0) / self.cell).round();
        (i >= 0.0 && j >= 0.0 && (i as usize) < self.nx && (j as usize) < self.nz)
            .then(|| j as usize * self.nx + i as usize)
    }

    fn centre(&self, c: usize) -> [f32; 2] {
        [
            self.x0 + (c % self.nx) as f32 * self.cell,
            self.z0 + (c / self.nx) as f32 * self.cell,
        ]
    }

    /// The straight line a → b stays ≥ `clear` from the shore.
    pub fn clear_line(&self, a: [f32; 2], b: [f32; 2], clear: f32) -> bool {
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        let n = (len / (self.cell * 0.5)).ceil().max(1.0) as usize;
        (1..n).all(|k| {
            let t = k as f32 / n as f32;
            self.dist_at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) >= clear
        })
    }

    /// Waypoints a → b through water ≥ `clear` from shore (A*, string-pulled); None when there's no way through.
    pub fn route(&self, a: [f32; 2], b: [f32; 2], clear: f32) -> Option<Vec<[f32; 2]>> {
        if self.clear_line(a, b, clear) {
            return Some(vec![b]);
        }
        let (s, g) = (self.cell_of(a[0], a[1])?, self.cell_of(b[0], b[1])?);
        let nx = self.nx;
        let mut cost = vec![f32::INFINITY; self.dist.len()];
        let mut from = vec![usize::MAX; self.dist.len()];
        let mut heap = BinaryHeap::new();
        cost[s] = 0.0;
        heap.push(Open(0.0, s));
        let (gi, gj) = ((g % nx) as f32, (g / nx) as f32);
        let mut iter = 0;
        while let Some(Open(_, c)) = heap.pop() {
            if c == g {
                break;
            }
            iter += 1;
            if iter > 200_000 {
                return None;
            }
            let (ci, cj) = ((c % nx) as i32, (c / nx) as i32);
            for (di, dj) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let (ni, nj) = (ci + di, cj + dj);
                if ni < 0 || nj < 0 || ni >= nx as i32 || nj >= self.nz as i32 {
                    continue;
                }
                let nb = nj as usize * nx + ni as usize;
                if self.dist[nb] < clear && nb != g {
                    continue;
                }
                let step = if di != 0 && dj != 0 { 1.414 } else { 1.0 } * self.cell;
                let open = ((self.dist[nb] - clear) / 25.0).clamp(0.0, 1.0);
                let ng = cost[c] + step * (1.0 + 2.0 * (1.0 - open));
                if ng < cost[nb] {
                    cost[nb] = ng;
                    from[nb] = c;
                    let h = ((ni as f32 - gi).powi(2) + (nj as f32 - gj).powi(2)).sqrt() * self.cell;
                    heap.push(Open(ng + h, nb));
                }
            }
        }
        if from[g] == usize::MAX {
            return None;
        }
        let mut cells = vec![g];
        let mut c = g;
        while from[c] != usize::MAX {
            c = from[c];
            cells.push(c);
        }
        cells.reverse();
        // string pulling
        let mut out = Vec::new();
        let mut at = a;
        let mut k = 0;
        while k < cells.len() - 1 {
            let mut far = k + 1;
            for m in (k + 1..cells.len()).rev() {
                if self.clear_line(at, self.centre(cells[m]), clear * 0.9) {
                    far = m;
                    break;
                }
            }
            k = far;
            at = self.centre(cells[k]);
            out.push(at);
        }
        if let Some(last) = out.last_mut() {
            *last = b;
        }
        Some(out)
    }
}

#[derive(PartialEq)]
struct Open(f32, usize);
impl Eq for Open {}
impl Ord for Open {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.total_cmp(&self.0).then(self.1.cmp(&o.1))
    }
}
impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Everything a bot needs to find its way on one map.
pub struct Nav {
    pub roads: Vec<Road>,
    pub edges: Vec<Edge>,
    pub nodes: Vec<Node>,
    /// Road samples every ~5 m (edge, t forward) in 32 m cells — nearest-road queries.
    index: FastMap<(i32, i32), Vec<RoadSample>>,
    pub water: Option<WaterGrid>,
    /// Places to drive into / out of the water.
    pub shores: Vec<Shore>,
    /// Open-water points (≥ 20 m from shore) to sail to.
    pub open_water: Vec<[f32; 2]>,
}

/// A road sample in the nearest-road index: x, z, edge, t (m along the edge, forward).
type RoadSample = (f32, f32, u32, f32);

const INDEX_CELL: f32 = 32.0;
/// Water at least this deep is water to a bot (m).
const WET: f32 = 0.9;

impl Nav {
    pub fn get(map: &MapData) -> Arc<Nav> {
        map.nav.get_or_init(|| Arc::new(Nav::build(map))).clone()
    }

    pub fn build(map: &MapData) -> Nav {
        let roads: Vec<Road> = map
            .roads
            .iter()
            .filter(|r| r.pts.len() >= 2)
            .map(|r| {
                let mut cum = vec![0.0];
                let n = r.pts.len();
                let segs = if r.closed { n } else { n - 1 };
                for i in 0..segs {
                    let (a, b) = (r.pts[i], r.pts[(i + 1) % n]);
                    let l = ((b[0] - a[0]).powi(2) + (b[2] - a[2]).powi(2)).sqrt();
                    cum.push(cum[i] + l);
                }
                Road {
                    class: r.class.clone(),
                    closed: r.closed,
                    half_width: r.half_width,
                    len: *cum.last().unwrap(),
                    pts: r.pts.clone(),
                    cum,
                    bridge: r.bridge.clone(),
                }
            })
            .collect();
        // split points: (road, s) — every open road's two ends, and where another road's end meets a road
        let mut splits: Vec<(usize, f32)> = Vec::new();
        let mut joins: Vec<(usize, usize)> = Vec::new();
        for (ri, r) in roads.iter().enumerate() {
            if r.closed {
                continue;
            }
            for s in [0.0, r.len] {
                let p = r.at(s);
                let me = splits.len();
                splits.push((ri, s));
                for (qi, q) in roads.iter().enumerate() {
                    let (sq, d) = q.project(p.x, p.z);
                    // (a road meeting itself only counts far from this end)
                    if d < 12.0 && (qi != ri || (sq - s).abs() > 40.0) {
                        joins.push((me, splits.len()));
                        splits.push((qi, sq));
                    }
                }
            }
        }
        for (ri, r) in roads.iter().enumerate() {
            if r.closed && !splits.iter().any(|&(q, _)| q == ri) {
                splits.push((ri, 0.0));
            }
        }
        // union-find: joined pairs, and split points within 8 m of each other
        let mut parent: Vec<usize> = (0..splits.len()).collect();
        fn find(p: &mut [usize], mut i: usize) -> usize {
            while p[i] != i {
                p[i] = p[p[i]];
                i = p[i];
            }
            i
        }
        let pos: Vec<RoadPt> = splits.iter().map(|&(r, s)| roads[r].at(s)).collect();
        for &(a, b) in &joins {
            let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
            parent[ra] = rb;
        }
        for a in 0..splits.len() {
            for b in a + 1..splits.len() {
                if (pos[a].x - pos[b].x).powi(2) + (pos[a].z - pos[b].z).powi(2) < 64.0 {
                    let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                    parent[ra] = rb;
                }
            }
        }
        let mut node_of: HashMap<usize, usize> = HashMap::new();
        let mut nodes: Vec<Node> = Vec::new();
        let mut acc: Vec<(f32, f32, f32)> = Vec::new();
        let mut split_node = vec![0usize; splits.len()];
        for (i, sn) in split_node.iter_mut().enumerate() {
            let root = find(&mut parent, i);
            let id = *node_of.entry(root).or_insert_with(|| {
                nodes.push(Node {
                    x: 0.0,
                    z: 0.0,
                    out: Vec::new(),
                });
                acc.push((0.0, 0.0, 0.0));
                nodes.len() - 1
            });
            acc[id].0 += pos[i].x;
            acc[id].1 += pos[i].z;
            acc[id].2 += 1.0;
            *sn = id;
        }
        for (n, a) in nodes.iter_mut().zip(&acc) {
            n.x = a.0 / a.2;
            n.z = a.1 / a.2;
        }
        // edges: consecutive split points along each road (round the loop on a closed one)
        let mut edges: Vec<Edge> = Vec::new();
        for (ri, r) in roads.iter().enumerate() {
            let mut pts: Vec<(f32, usize)> = splits
                .iter()
                .enumerate()
                .filter(|(_, (q, _))| *q == ri)
                .map(|(i, &(_, s))| (s, split_node[i]))
                .collect();
            pts.sort_by(|a, b| a.0.total_cmp(&b.0));
            pts.dedup_by(|b, a| b.0 - a.0 < 3.0 && a.1 == b.1);
            let n = pts.len();
            let count = if r.closed { n } else { n.saturating_sub(1) };
            for k in 0..count {
                let (s0, a) = pts[k];
                let (mut s1, b) = pts[(k + 1) % n];
                if k + 1 >= n {
                    s1 += r.len;
                }
                if s1 - s0 < 2.0 {
                    continue;
                }
                let e = edges.len();
                edges.push(Edge { road: ri, s0, s1, a, b });
                nodes[a].out.push((e, true));
                nodes[b].out.push((e, false));
            }
        }
        // nearest-road index
        let mut index: FastMap<(i32, i32), Vec<RoadSample>> = FastMap::default();
        for (ei, e) in edges.iter().enumerate() {
            let r = &roads[e.road];
            let steps = (e.len() / 5.0).ceil().max(1.0) as usize;
            for k in 0..=steps {
                let t = e.len() * k as f32 / steps as f32;
                let p = r.at(e.s0 + t);
                let key = ((p.x / INDEX_CELL).floor() as i32, (p.z / INDEX_CELL).floor() as i32);
                index.entry(key).or_default().push((p.x, p.z, ei as u32, t));
            }
        }
        let (water, shores, open_water) = water_of(map);
        Nav {
            roads,
            edges,
            nodes,
            index,
            water,
            shores,
            open_water,
        }
    }

    /// Position on edge `e` travelling `forward`, `t` m from the start of the travel.
    pub fn at(&self, on: OnEdge) -> RoadPt {
        let e = &self.edges[on.edge];
        let r = &self.roads[e.road];
        if on.forward {
            r.at(e.s0 + on.t)
        } else {
            let mut p = r.at(e.s1 - on.t);
            p.dx = -p.dx;
            p.dz = -p.dz;
            p
        }
    }

    /// The node a travel ends at.
    pub fn end_node(&self, on: OnEdge) -> usize {
        let e = &self.edges[on.edge];
        if on.forward { e.b } else { e.a }
    }

    /// Nearest road point within `max` m: (edge, t forward, distance).
    pub fn nearest(&self, x: f32, z: f32, max: f32) -> Option<(usize, f32, f32)> {
        let r = (max / INDEX_CELL).ceil() as i32;
        let (ci, cj) = ((x / INDEX_CELL).floor() as i32, (z / INDEX_CELL).floor() as i32);
        let mut best: Option<(usize, f32, f32)> = None;
        for i in ci - r..=ci + r {
            for j in cj - r..=cj + r {
                if let Some(v) = self.index.get(&(i, j)) {
                    for &(px, pz, e, t) in v {
                        let d = ((px - x).powi(2) + (pz - z).powi(2)).sqrt();
                        if d <= max && best.is_none_or(|b| d < b.2) {
                            best = Some((e as usize, t, d));
                        }
                    }
                }
            }
        }
        best
    }

    /// Shortest route (edges with their travel direction) from the end of `from` to node `goal`.
    pub fn route(&self, from_node: usize, goal: usize) -> Option<Vec<(usize, bool)>> {
        let n = self.nodes.len();
        let mut dist = vec![f32::INFINITY; n];
        let mut prev: Vec<Option<(usize, usize, bool)>> = vec![None; n];
        let mut heap = BinaryHeap::new();
        dist[from_node] = 0.0;
        heap.push(Open(0.0, from_node));
        while let Some(Open(d, u)) = heap.pop() {
            if u == goal {
                break;
            }
            if d > dist[u] {
                continue;
            }
            for &(e, fwd) in &self.nodes[u].out {
                let ed = &self.edges[e];
                let v = if fwd { ed.b } else { ed.a };
                let nd = d + ed.len();
                if nd < dist[v] {
                    dist[v] = nd;
                    prev[v] = Some((u, e, fwd));
                    heap.push(Open(nd, v));
                }
            }
        }
        if !dist[goal].is_finite() {
            return None;
        }
        let mut out = Vec::new();
        let mut v = goal;
        while let Some((u, e, fwd)) = prev[v] {
            out.push((e, fwd));
            v = u;
        }
        out.reverse();
        Some(out)
    }

    /// Total length of a route (m).
    pub fn route_len(&self, r: &[(usize, bool)]) -> f32 {
        r.iter().map(|&(e, _)| self.edges[e].len()).sum()
    }
}

/// The map's water: shore-distance grid (map + 400 m of sea round it, 8 m cells), shore crossings, open water.
fn water_of(map: &MapData) -> (Option<WaterGrid>, Vec<Shore>, Vec<[f32; 2]>) {
    let cell = 8.0;
    let ext = map.half + 400.0;
    let n = ((2.0 * ext) / cell) as usize + 1;
    let (x0, z0) = (-ext, -ext);
    let mut h = vec![0f32; n * n];
    for j in 0..n {
        for i in 0..n {
            h[j * n + i] = map.height(x0 + i as f32 * cell, z0 + j as f32 * cell);
        }
    }
    let wet: Vec<bool> = (0..n * n)
        .map(|k| {
            let (i, j) = (k % n, k / n);
            i > 0 && j > 0 && i < n - 1 && j < n - 1 && h[k] < WATER - WET
        })
        .collect();
    if !wet.iter().any(|&w| w) {
        return (None, Vec::new(), Vec::new());
    }
    let dist = distance_field(&wet, n, n, cell);
    let g = WaterGrid {
        x0,
        z0,
        cell,
        nx: n,
        nz: n,
        dist,
    };
    // shore crossings: gentle land (≤ ~20°) just above the water with water ≥ 12 m from shore within 40 m
    let mut shores = Vec::new();
    let mut taken: HashMap<(i32, i32), ()> = HashMap::new();
    for j in 2..n - 2 {
        for i in 2..n - 2 {
            let k = j * n + i;
            if wet[k] || h[k] > WATER + 3.0 || h[k] < WATER - 0.2 {
                continue;
            }
            let slope = ((h[k + 1] - h[k - 1]).abs().max((h[k + n] - h[k - n]).abs())) / (2.0 * cell);
            if slope > 0.35 {
                continue;
            }
            let (x, z) = (x0 + i as f32 * cell, z0 + j as f32 * cell);
            // the water this way: step along the distance gradient
            let (mut wx, mut wz) = (x, z);
            let mut found = false;
            for _ in 0..10 {
                let e = cell;
                let gx = g.dist_at(wx + e, wz) - g.dist_at(wx - e, wz);
                let gz = g.dist_at(wx, wz + e) - g.dist_at(wx, wz - e);
                let gl = (gx * gx + gz * gz).sqrt();
                if gl < 1e-4 {
                    // still on land: head for the nearest wet cell nearby
                    let mut best = None;
                    for dj in -3i32..=3 {
                        for di in -3i32..=3 {
                            let q = (j as i32 + dj) as usize * n + (i as i32 + di) as usize;
                            if wet[q] {
                                best = Some((di, dj));
                            }
                        }
                    }
                    let Some((di, dj)) = best else { break };
                    wx += di as f32 * cell * 0.5;
                    wz += dj as f32 * cell * 0.5;
                    continue;
                }
                wx += gx / gl * 4.0;
                wz += gz / gl * 4.0;
                if g.dist_at(wx, wz) >= 12.0 {
                    found = true;
                    break;
                }
            }
            if !found || ((wx - x).powi(2) + (wz - z).powi(2)).sqrt() > 45.0 {
                continue;
            }
            let key = ((x / 48.0).floor() as i32, (z / 48.0).floor() as i32);
            if taken.insert(key, ()).is_none() {
                shores.push(Shore {
                    land: [x, z],
                    water: [wx, wz],
                });
            }
        }
    }
    let mut open_water = Vec::new();
    for j in (0..n).step_by(5) {
        for i in (0..n).step_by(5) {
            if g.dist[j * n + i] >= 20.0 {
                open_water.push(g.centre(j * n + i));
            }
        }
    }
    (Some(g), shores, open_water)
}

/// Exact Euclidean distance (m) from each wet cell to the nearest dry one (Felzenszwalb & Huttenlocher).
fn distance_field(wet: &[bool], nx: usize, nz: usize, cell: f32) -> Vec<f32> {
    const INF: f64 = 1e20;
    let mut g: Vec<f64> = wet.iter().map(|&w| if w { INF } else { 0.0 }).collect();
    let m = nx.max(nz);
    let (mut f, mut d, mut zz, mut v) = (vec![0f64; m], vec![0f64; m], vec![0f64; m + 1], vec![0usize; m]);
    let mut pass = |f: &[f64], d: &mut [f64], len: usize| {
        let mut k = 0usize;
        v[0] = 0;
        zz[0] = -INF;
        zz[1] = INF;
        for q in 1..len {
            let qf = q as f64;
            let mut s;
            loop {
                let vk = v[k] as f64;
                s = ((f[q] + qf * qf) - (f[v[k]] + vk * vk)) / (2.0 * qf - 2.0 * vk);
                if s <= zz[k] && k > 0 {
                    k -= 1;
                } else {
                    break;
                }
            }
            if s <= zz[k] {
                // k == 0 and still dominated: replace the first parabola
                v[0] = q;
                zz[0] = -INF;
                zz[1] = INF;
                continue;
            }
            k += 1;
            v[k] = q;
            zz[k] = s;
            zz[k + 1] = INF;
        }
        k = 0;
        for (q, dq) in d.iter_mut().enumerate().take(len) {
            while zz[k + 1] < q as f64 {
                k += 1;
            }
            let dv = q as f64 - v[k] as f64;
            *dq = dv * dv + f[v[k]];
        }
    };
    for i in 0..nx {
        for j in 0..nz {
            f[j] = g[j * nx + i];
        }
        pass(&f, &mut d, nz);
        for j in 0..nz {
            g[j * nx + i] = d[j];
        }
    }
    let mut out = vec![0f32; nx * nz];
    for j in 0..nz {
        f[..nx].copy_from_slice(&g[j * nx..j * nx + nx]);
        pass(&f, &mut d, nx);
        for i in 0..nx {
            out[j * nx + i] = (d[i].sqrt() as f32) * cell;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn distance_field_is_euclidean() {
        let (nx, nz) = (9, 7);
        let mut wet = vec![true; nx * nz];
        wet[3 * nx + 4] = false;
        let d = distance_field(&wet, nx, nz, 2.0);
        assert_eq!(d[3 * nx + 4], 0.0);
        assert!((d[3 * nx + 6] - 4.0).abs() < 1e-5);
        assert!((d[5 * nx + 6] - (8f32).sqrt() * 2.0).abs() < 1e-4);
    }

    #[test]
    fn island_graph_water_and_routes() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps/island");
        if !dir.exists() {
            return;
        }
        let map = MapData::load(&dir).unwrap();
        let t = std::time::Instant::now();
        let nav = Nav::build(&map);
        let ms = t.elapsed().as_millis();
        assert!(nav.edges.len() >= 30, "{} edges", nav.edges.len());
        assert!(nav.nodes.iter().filter(|n| n.out.len() >= 3).count() >= 8, "junctions");
        // the whole network is one piece: a route from the first node to every other
        let reach = (0..nav.nodes.len()).filter(|&k| nav.route(0, k).is_some()).count();
        assert!(
            reach * 10 >= nav.nodes.len() * 9,
            "{reach}/{} nodes reachable",
            nav.nodes.len()
        );
        let w = nav.water.as_ref().expect("the island has a sea");
        assert!(nav.shores.len() > 20, "{} shores", nav.shores.len());
        assert!(nav.open_water.len() > 100);
        // across the sea between two open-water points
        let (a, b) = (nav.open_water[0], nav.open_water[nav.open_water.len() / 2]);
        let r = w.route(a, b, 12.0);
        assert!(r.is_some());
        assert!(nav.nearest(map.lobby[0], map.lobby[1], 200.0).is_some());
        eprintln!(
            "island nav: {} roads, {} edges, {} nodes, {} shores, {} open water pts, {ms} ms",
            nav.roads.len(),
            nav.edges.len(),
            nav.nodes.len(),
            nav.shores.len(),
            nav.open_water.len()
        );
    }
}
