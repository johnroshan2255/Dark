//! MATCHMAKING + the registry of running matches.
//!
//! `/v1/matchmake` reserves a SEAT (a player id) in the fullest joinable match of the requested map — filling matches
//! one by one so they start sooner — or opens a new match when none has room (up to `max_matches` per process). A
//! player already holding a seat in a joinable match gets the same seat back (idempotent retries). Reservations that
//! never connect lapse after the ticket lifetime.

use crate::runtime::{Cmd, MatchHandle, spawn_match};
use dark_sim::{MapData, MatchConfig};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MatchmakeError {
    #[error("this server is draining")]
    Draining,
    #[error("unknown map")]
    UnknownMap,
    #[error("server at capacity")]
    Full,
}

struct Entry {
    handle: MatchHandle,
    next_pid: u16,
    /// session sub → (seat, reserved at)
    seats: HashMap<String, (u16, Instant)>,
}

pub struct Registry {
    maps: HashMap<String, Arc<MapData>>,
    default_map: String,
    rules: MatchConfig,
    max_matches: usize,
    seat_ttl: Duration,
    accepting: AtomicBool,
    matches: Mutex<HashMap<u64, Entry>>,
    me: Weak<Registry>,
}

/// A reserved seat.
pub struct Seat {
    pub handle: MatchHandle,
    pub pid: u16,
}

impl Registry {
    pub fn new(
        maps: HashMap<String, Arc<MapData>>,
        default_map: String,
        rules: MatchConfig,
        max_matches: usize,
        seat_ttl: Duration,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            maps,
            default_map,
            rules,
            max_matches,
            seat_ttl,
            accepting: AtomicBool::new(true),
            matches: Mutex::new(HashMap::new()),
            me: me.clone(),
        })
    }

    pub fn default_map(&self) -> &str {
        &self.default_map
    }
    pub fn accepting(&self) -> bool {
        self.accepting.load(Ordering::Relaxed)
    }
    pub fn rules(&self) -> &MatchConfig {
        &self.rules
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Entry>> {
        self.matches.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn matchmake(&self, sub: &str, map: Option<&str>) -> Result<Seat, MatchmakeError> {
        if !self.accepting() {
            return Err(MatchmakeError::Draining);
        }
        let map_id = map.unwrap_or(&self.default_map);
        let map = self.maps.get(map_id).ok_or(MatchmakeError::UnknownMap)?.clone();
        let mut all = self.lock();
        // 1. a seat this player already holds
        for e in all.values() {
            if e.handle.info.map == map_id
                && e.handle.info.joinable.load(Ordering::Relaxed)
                && let Some(&(pid, _)) = e.seats.get(sub)
            {
                return Ok(Seat {
                    handle: e.handle.clone(),
                    pid,
                });
            }
        }
        // 2. the fullest joinable match with room
        let now = Instant::now();
        let ttl = self.seat_ttl;
        let mut best: Option<(u64, usize)> = None;
        for (&id, e) in all.iter_mut() {
            let info = &e.handle.info;
            if info.map != map_id || !info.joinable.load(Ordering::Relaxed) {
                continue;
            }
            let connected = info.connected.lock().map(|c| c.clone()).unwrap_or_default();
            e.seats
                .retain(|_, (pid, at)| connected.contains(pid) || now.duration_since(*at) < ttl);
            let taken = e.seats.len().max(info.players.load(Ordering::Relaxed));
            if taken < info.max_players && best.is_none_or(|(_, b)| taken > b) {
                best = Some((id, taken));
            }
        }
        let id = match best {
            Some((id, _)) => id,
            None => {
                if all.len() >= self.max_matches {
                    return Err(MatchmakeError::Full);
                }
                let id = crate::auth::random_u64();
                let seed = (crate::auth::random_u64() >> 32) as u32;
                let me = self.me.clone();
                let handle = spawn_match(id, seed, map, self.rules.clone(), move |id| {
                    if let Some(r) = me.upgrade() {
                        r.lock().remove(&id);
                    }
                });
                all.insert(
                    id,
                    Entry {
                        handle,
                        next_pid: 1,
                        seats: HashMap::new(),
                    },
                );
                id
            }
        };
        let e = all.get_mut(&id).expect("just found or inserted");
        let pid = e.next_pid;
        // ids 1 … 65 534 (0 unused, u16::MAX = NO_PLAYER)
        e.next_pid = if e.next_pid >= u16::MAX - 1 { 1 } else { e.next_pid + 1 };
        e.seats.insert(sub.to_owned(), (pid, now));
        Ok(Seat {
            handle: e.handle.clone(),
            pid,
        })
    }

    pub fn get(&self, id: u64) -> Option<MatchHandle> {
        self.lock().get(&id).map(|e| e.handle.clone())
    }

    /// Is this ticket's seat still reserved for its holder? (A seat given to someone else after it lapsed isn't.)
    pub fn seat_valid(&self, id: u64, sub: &str, pid: u16) -> bool {
        self.lock()
            .get(&id)
            .is_some_and(|e| e.seats.get(sub).is_some_and(|&(p, _)| p == pid))
    }

    pub fn list(&self) -> Vec<MatchHandle> {
        self.lock().values().map(|e| e.handle.clone()).collect()
    }

    pub fn count(&self) -> usize {
        self.lock().len()
    }

    /// Stop handing out seats (SIGTERM): running matches play on.
    pub fn begin_drain(&self) {
        self.accepting.store(false, Ordering::Relaxed);
    }

    /// Past the drain deadline: close every match now.
    pub async fn shutdown_all(&self) {
        for h in self.list() {
            let _ = h.tx.send(Cmd::Shutdown).await;
        }
    }
}
