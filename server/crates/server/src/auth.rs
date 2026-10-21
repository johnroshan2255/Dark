//! Signed tokens (HMAC-SHA256, JWT-like: `base64url(json).base64url(mac)`).
//!
//! * SESSION — who you are (`/v1/auth/guest` today; an account login later), presented as `Authorization: Bearer`.
//! * TICKET  — a seat: one player id in one match, minted by `/v1/matchmake`, sent in the WebSocket `Hello`
//!   (never in a URL, so it doesn't land in proxy logs). Short-lived.
//!
//! Stateless: any server of a deployment sharing `DARK_SECRET` can verify them.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TokenError {
    #[error("malformed token")]
    Malformed,
    #[error("bad signature")]
    Signature,
    #[error("wrong token type")]
    Kind,
    #[error("token expired")]
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    /// Stable player identity (random for guests).
    pub sub: String,
    pub name: String,
    pub exp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ticket {
    pub sub: String,
    pub name: String,
    /// Match id (hex string: JSON numbers lose u64 precision in browsers).
    pub mid: String,
    /// Seat (player id) in that match.
    pub pid: u16,
    pub exp: u64,
}

#[derive(Serialize, Deserialize)]
struct Envelope<T> {
    typ: String,
    #[serde(flatten)]
    claims: T,
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct Signer {
    key: Vec<u8>,
}

impl Signer {
    pub fn new(key: Vec<u8>) -> Self {
        Self { key }
    }

    fn mac(&self) -> HmacSha256 {
        <HmacSha256 as KeyInit>::new_from_slice(&self.key).expect("HMAC takes any key length")
    }

    fn sign<T: Serialize>(&self, typ: &str, claims: &T) -> String {
        let body = serde_json::to_vec(&Envelope {
            typ: typ.to_owned(),
            claims,
        })
        .expect("claims serialize");
        let body = B64.encode(body);
        let mut m = self.mac();
        m.update(body.as_bytes());
        let sig = B64.encode(m.finalize().into_bytes());
        format!("{body}.{sig}")
    }

    fn verify<T: DeserializeOwned>(&self, typ: &str, token: &str, now: u64) -> Result<T, TokenError> {
        let (body, sig) = token.split_once('.').ok_or(TokenError::Malformed)?;
        let sig = B64.decode(sig).map_err(|_| TokenError::Malformed)?;
        let mut m = self.mac();
        m.update(body.as_bytes());
        m.verify_slice(&sig).map_err(|_| TokenError::Signature)?;
        let raw = B64.decode(body).map_err(|_| TokenError::Malformed)?;
        let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| TokenError::Malformed)?;
        if v.get("typ").and_then(|t| t.as_str()) != Some(typ) {
            return Err(TokenError::Kind);
        }
        let exp = v.get("exp").and_then(|e| e.as_u64()).ok_or(TokenError::Malformed)?;
        if exp <= now {
            return Err(TokenError::Expired);
        }
        serde_json::from_value(v).map_err(|_| TokenError::Malformed)
    }

    pub fn session(&self, s: &Session) -> String {
        self.sign("session", s)
    }
    pub fn verify_session(&self, token: &str, now: u64) -> Result<Session, TokenError> {
        self.verify("session", token, now)
    }
    pub fn ticket(&self, t: &Ticket) -> String {
        self.sign("ticket", t)
    }
    pub fn verify_ticket(&self, token: &str, now: u64) -> Result<Ticket, TokenError> {
        self.verify("ticket", token, now)
    }
}

/// A random 64-bit id.
pub fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("OS randomness");
    u64::from_le_bytes(b)
}

/// A random guest identity (128 bits, hex).
pub fn random_sub() -> String {
    format!("g{:016x}{:016x}", random_u64(), random_u64())
}

/// A display name: 1–20 visible characters (control characters dropped, whitespace collapsed); `None` if empty.
pub fn clean_name(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut space = false;
    for c in raw.chars() {
        if c.is_control() {
            continue;
        }
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
        if out.chars().count() >= 20 {
            break;
        }
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_and_reject_tampering() {
        let s = Signer::new(b"0123456789abcdef0123456789abcdef".to_vec());
        let t = Ticket {
            sub: "g1".into(),
            name: "A".into(),
            mid: "ff".into(),
            pid: 3,
            exp: 100,
        };
        let tok = s.ticket(&t);
        assert_eq!(s.verify_ticket(&tok, 50), Ok(t.clone()));
        assert_eq!(s.verify_ticket(&tok, 100), Err(TokenError::Expired));
        // a session can't be used as a ticket
        let st = s.session(&Session {
            sub: "g1".into(),
            name: "A".into(),
            exp: 100,
        });
        assert_eq!(s.verify_ticket(&st, 50), Err(TokenError::Kind));
        // tampered body / other key
        let (body, sig) = tok.split_once('.').unwrap();
        let mut forged = B64.decode(body).unwrap();
        let i = forged.iter().position(|&c| c == b'3').unwrap();
        forged[i] = b'4';
        assert_eq!(
            s.verify_ticket(&format!("{}.{sig}", B64.encode(forged)), 50),
            Err(TokenError::Signature)
        );
        let other = Signer::new(b"another-key-another-key-another!".to_vec());
        assert_eq!(other.verify_ticket(&tok, 50), Err(TokenError::Signature));
        assert_eq!(s.verify_ticket("garbage", 50), Err(TokenError::Malformed));
    }

    #[test]
    fn names() {
        assert_eq!(clean_name("  Big \u{7}  Truck\n "), Some("Big Truck".into()));
        assert_eq!(clean_name("\u{1}\u{2}"), None);
        assert_eq!(clean_name(&"x".repeat(50)).unwrap().len(), 20);
    }
}
