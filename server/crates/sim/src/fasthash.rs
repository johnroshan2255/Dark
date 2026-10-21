//! A fast hasher for the match's small integer keys (player ids, grid cells): a multiply-xor mix instead of std's
//! SipHash, which is DoS-resistant but ~5× slower — these keys never come from untrusted input as raw hash input
//! a client controls in bulk (ids are the server's, cells are bounded by validated positions).

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default, Clone, Copy)]
pub struct IdHasher(u64);

const K: u64 = 0x9e37_79b9_7f4a_7c15;

impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        // fold the high bits down: hashbrown takes its bucket from the low bits and its tag from the top 7
        self.0 ^ (self.0 >> 29)
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(K);
        }
    }
    fn write_u16(&mut self, n: u16) {
        self.0 = (self.0 ^ n as u64).wrapping_mul(K);
    }
    fn write_u32(&mut self, n: u32) {
        self.0 = (self.0 ^ n as u64).wrapping_mul(K);
    }
    fn write_i32(&mut self, n: i32) {
        self.0 = (self.0.rotate_left(32) ^ n as u32 as u64).wrapping_mul(K);
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0 ^ n).wrapping_mul(K);
    }
    fn write_usize(&mut self, n: usize) {
        self.0 = (self.0 ^ n as u64).wrapping_mul(K);
    }
}

pub type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<IdHasher>>;
pub type FastSet<K> = HashSet<K, BuildHasherDefault<IdHasher>>;
