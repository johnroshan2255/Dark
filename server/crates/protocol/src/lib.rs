//! DARK wire protocol (version [`PROTOCOL_VERSION`]).
//!
//! Every WebSocket *binary* frame carries exactly one packet: `[kind: u8][payload]`, little-endian, no padding.
//! Client → server kinds are `0x01..=0x7f`, server → client kinds `0x80..=0xff`. Strings are UTF-8 with a `u8`
//! byte length (≤ 255). Positions are `i32` centimetres in world space (±21 474 km), angles are quantised
//! ([`yaw_to_u16`], [`pitch_to_i16`]) and velocities `i16` cm/s (±327 m/s).
//!
//! Decoding never panics: truncated, oversized or unknown packets return a [`DecodeError`]. The format is pinned by
//! golden vectors (`tests/golden.rs` → `golden.json`) that the TypeScript client's codec is tested against too
//! (`game/src/net/protocol.ts`). Any change to a packet layout must bump [`PROTOCOL_VERSION`].
//!
//! See `server/docs/PROTOCOL.md` for the full table.

mod codec;
mod messages;

pub use codec::{DecodeError, Reader, Writer};
pub use messages::*;

/// Bumped on any incompatible layout change; the server rejects a `Hello` with another version.
pub const PROTOCOL_VERSION: u16 = 4;

/// Largest packet either side accepts (bytes). Snapshots are bounded by [`MAX_SNAPSHOT_ENTITIES`].
pub const MAX_PACKET: usize = 16 * 1024;

/// Most entities one snapshot may carry (interest management keeps the nearest ones).
pub const MAX_SNAPSHOT_ENTITIES: usize = 96;

/// `Welcome.spawn[1]` (height) with this value: the server has no spawn for you (an endless-world room whose terrain only
/// the clients know) — start where your own world puts you.
pub const NO_SPAWN: i32 = i32::MIN;

/// Sentinel player id: "nobody" (e.g. the zone as a killer).
pub const NO_PLAYER: u16 = u16::MAX;

/// Server-run players (room bots) have ids from here up (`BOT_ID_BASE + slot`, ≤ 100 of them); clients mark them.
pub const BOT_ID_BASE: u16 = 0xC000;

/// Metres → wire centimetres (saturating).
#[inline]
pub fn m_to_cm(m: f32) -> i32 {
    let v = (m * 100.0).round();
    if v.is_nan() {
        0
    } else {
        v.clamp(i32::MIN as f32, i32::MAX as f32) as i32
    }
}

/// Wire centimetres → metres.
#[inline]
pub fn cm_to_m(cm: i32) -> f32 {
    cm as f32 * 0.01
}

/// Metres per second → wire cm/s (saturating to ±327.67 m/s).
#[inline]
pub fn mps_to_cms(v: f32) -> i16 {
    let x = (v * 100.0).round();
    if x.is_nan() {
        0
    } else {
        x.clamp(i16::MIN as f32, i16::MAX as f32) as i16
    }
}

/// Wire cm/s → metres per second.
#[inline]
pub fn cms_to_mps(v: i16) -> f32 {
    v as f32 * 0.01
}

/// Yaw (radians, any range; game convention: 0 faces −Z, + turns left) → `u16` over one turn.
#[inline]
pub fn yaw_to_u16(yaw: f32) -> u16 {
    let t = yaw.rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU;
    if t.is_nan() {
        0
    } else {
        ((t * 65536.0).round() as u32 & 0xffff) as u16
    }
}

/// `u16` yaw → radians in `[0, 2π)`.
#[inline]
pub fn u16_to_yaw(v: u16) -> f32 {
    v as f32 / 65536.0 * std::f32::consts::TAU
}

/// Pitch (radians, clamped to ±π/2) → `i16`.
#[inline]
pub fn pitch_to_i16(p: f32) -> i16 {
    let h = std::f32::consts::FRAC_PI_2;
    let x = (p.clamp(-h, h) / h * 32767.0).round();
    if x.is_nan() { 0 } else { x as i16 }
}

/// `i16` pitch → radians.
#[inline]
pub fn i16_to_pitch(v: i16) -> f32 {
    v as f32 / 32767.0 * std::f32::consts::FRAC_PI_2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantisation_round_trips_within_one_step() {
        for &m in &[0.0f32, 1.234, -1199.99, 20000.5] {
            assert!((cm_to_m(m_to_cm(m)) - m).abs() <= 0.005 + m.abs() * 1e-6);
        }
        for i in 0..64 {
            let a = i as f32 * 0.1 - 3.0;
            let back = u16_to_yaw(yaw_to_u16(a));
            let d = (back - a.rem_euclid(std::f32::consts::TAU)).abs();
            assert!(d < 1e-3 || (std::f32::consts::TAU - d) < 1e-3, "{a} -> {back}");
            assert!((i16_to_pitch(pitch_to_i16(a.clamp(-1.5, 1.5))) - a.clamp(-1.5, 1.5)).abs() < 1e-4);
        }
        assert_eq!(mps_to_cms(1000.0), i16::MAX);
        assert_eq!(m_to_cm(f32::NAN), 0);
    }
}
