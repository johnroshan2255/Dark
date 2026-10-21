//! The endless world's ROAD and RIVER on the server — a bit-exact port of the game's generator
//! (`game/src/world/noise/{rng,simplex}.ts`, `WorldFields.roadCenterX / roadHeight / riverCenterX`).
//!
//! The game's noise is integer hashing + IEEE double arithmetic + floor only, so the same operations in f64 give the
//! same bits: a bot on the server drives the road every client draws. `tests/world_golden.json` (written by the game's
//! own generator, `game/tests/protocol.test.ts` checks it against the TypeScript) pins both sides.

/// `hash4` (rng.ts): 32-bit avalanche hash of four integers.
pub fn hash4(a: i32, b: i32, c: i32, d: i32) -> u32 {
    let mut h = (a.wrapping_mul(0x27d4eb2d_u32 as i32) ^ b.wrapping_mul(0x165667b1)) as u32;
    h = (h ^ (h >> 15)).wrapping_mul(0x85ebca6b);
    h ^= (c as u32).wrapping_mul(0xc2b2ae35);
    h = (h ^ (h >> 13)).wrapping_mul(0x27d4eb2f);
    h ^= (d as u32).wrapping_mul(0x9e3779b1);
    h = (h ^ (h >> 16)).wrapping_mul(0x85ebca6b);
    h ^ (h >> 13)
}

/// `Rng` (rng.ts): mulberry32.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
    fn int(&mut self, max_exclusive: u32) -> usize {
        (self.next() * max_exclusive as f64).floor() as usize
    }
}

const GRAD: [f64; 16] = [
    1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0, 1.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0, -1.0,
];

/// `createNoise2D` (simplex.ts): seeded 2D simplex noise.
pub struct Simplex2 {
    perm: [u8; 512],
    perm_grad: [u8; 512],
}

impl Simplex2 {
    pub fn new(seed: u32) -> Self {
        let mut rng = Mulberry32(seed);
        let mut p = [0u8; 256];
        for (i, v) in p.iter_mut().enumerate() {
            *v = i as u8;
        }
        for i in (1..256).rev() {
            let j = rng.int(i as u32 + 1);
            p.swap(i, j);
        }
        let mut perm = [0u8; 512];
        let mut perm_grad = [0u8; 512];
        for i in 0..512 {
            perm[i] = p[i & 255];
            perm_grad[i] = (perm[i] % 8) * 2;
        }
        Self { perm, perm_grad }
    }

    pub fn get(&self, xin: f64, yin: f64) -> f64 {
        // (the constants exactly as the game computes them)
        let f2 = 0.5 * (3f64.sqrt() - 1.0);
        let g2 = (3.0 - 3f64.sqrt()) / 6.0;
        let s = (xin + yin) * f2;
        let i = (xin + s).floor();
        let j = (yin + s).floor();
        let t = (i + j) * g2;
        let x0 = xin - (i - t);
        let y0 = yin - (j - t);
        let (i1, j1) = if x0 > y0 { (1.0, 0.0) } else { (0.0, 1.0) };
        let x1 = x0 - i1 + g2;
        let y1 = y0 - j1 + g2;
        let x2 = x0 - 1.0 + 2.0 * g2;
        let y2 = y0 - 1.0 + 2.0 * g2;
        // `i & 255` on a JS number: ToInt32 then mask (i is an integer-valued double)
        let ii = ((i as i64) & 255) as usize;
        let jj = ((j as i64) & 255) as usize;
        let (i1u, j1u) = (i1 as usize, j1 as usize);
        let (perm, pg) = (&self.perm, &self.perm_grad);
        let mut n = 0.0;
        let mut t0 = 0.5 - x0 * x0 - y0 * y0;
        if t0 > 0.0 {
            let g = pg[ii + perm[jj] as usize] as usize;
            t0 *= t0;
            n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
        }
        let mut t1 = 0.5 - x1 * x1 - y1 * y1;
        if t1 > 0.0 {
            let g = pg[ii + i1u + perm[jj + j1u] as usize] as usize;
            t1 *= t1;
            n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
        }
        let mut t2 = 0.5 - x2 * x2 - y2 * y2;
        if t2 > 0.0 {
            let g = pg[ii + 1 + perm[jj + 1] as usize] as usize;
            t2 *= t2;
            n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
        }
        70.0 * n
    }

    /// `fbm` (simplex.ts) with lacunarity 2, gain 0.5.
    pub fn fbm(&self, x: f64, y: f64, octaves: u32) -> f64 {
        let (mut amp, mut freq, mut sum, mut norm) = (1.0, 1.0, 0.0, 0.0);
        for _ in 0..octaves {
            sum += amp * self.get(x * freq, y * freq);
            norm += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        sum / norm
    }
}

/// The game's global water level (`WorldFields.WATER`).
pub const WATER: f32 = -6.0;
/// River half width (`WorldFields.RIVER_HALF_WIDTH`).
pub const RIVER_HALF_WIDTH: f32 = 9.0;
/// Main road half width (`WorldFields.ROAD_HALF_WIDTH`).
pub const ROAD_HALF_WIDTH: f32 = 2.7;

/// The endless world's main road (runs along +Z, meanders in X) and the river beside it.
pub struct Endless {
    hills: Simplex2,
    road_n: Simplex2,
    river_n: Simplex2,
}

impl Endless {
    pub fn new(seed: u32) -> Self {
        let s = seed as i32;
        Self {
            hills: Simplex2::new(hash4(s, 11, 0, 0)),
            road_n: Simplex2::new(hash4(s, 13, 0, 0)),
            river_n: Simplex2::new(hash4(s, 17, 0, 0)),
        }
    }

    /// `roadCenterX(z)`.
    pub fn road_x(&self, z: f64) -> f64 {
        self.road_n.get(z * 0.0016, 3.7) * 110.0 + self.road_n.get(z * 0.006, 9.1) * 4.0
    }

    /// `roadHeight(z)`: the road surface.
    pub fn road_y(&self, z: f64) -> f64 {
        let x = self.road_x(z);
        (WATER as f64 + 1.8).max(self.hills.fbm(x * 0.0016, z * 0.0016, 2) * 12.0 + 2.0)
    }

    /// `riverCenterX(z)`.
    pub fn river_x(&self, z: f64) -> f64 {
        self.road_x(z) + 70.0 + self.river_n.get(z * 0.004, 21.3) * 30.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values the game's own TypeScript generator printed (game/tests/protocol.test.ts checks the same file).
    #[test]
    fn matches_the_game_bit_for_bit() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/world_golden.json");
        let text = std::fs::read_to_string(path).expect("world_golden.json");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut n = 0;
        for case in v.as_array().unwrap() {
            let seed = case["seed"].as_u64().unwrap() as u32;
            let e = Endless::new(seed);
            for s in case["samples"].as_array().unwrap() {
                let z = s[0].as_f64().unwrap();
                assert_eq!(
                    e.road_x(z).to_bits(),
                    s[1].as_f64().unwrap().to_bits(),
                    "road_x seed {seed} z {z}"
                );
                assert_eq!(
                    e.road_y(z).to_bits(),
                    s[2].as_f64().unwrap().to_bits(),
                    "road_y seed {seed} z {z}"
                );
                assert_eq!(
                    e.river_x(z).to_bits(),
                    s[3].as_f64().unwrap().to_bits(),
                    "river_x seed {seed} z {z}"
                );
                n += 1;
            }
        }
        assert!(n >= 100);
        assert_eq!(hash4(7, 13, 0, 0), crate::noise::hash4(7, 13, 0, 0));
    }
}
