//! The registry of running sessions: BATTLE-ROYALE matches (matchmaking) and ROOMS (player-hosted free roam).
//!
//! * `/v1/matchmake` reserves a SEAT (a player id) in the fullest joinable match of the requested map — filling
//!   matches one by one so they start sooner — or opens a new match (≤ `max_matches`).
//! * `POST /v1/rooms` opens a ROOM for whoever starts playing: the endless world (their seed) or a map, public or
//!   private, with the owner's settings; it gets a short JOIN CODE. Public rooms are listed; any room can be joined
//!   by its code while it has seats (≤ `max_rooms` rooms).
//!
//! Seats are idempotent (asking again returns the same seat), lapse if the player never connects, and are refused to
//! players the room's owner removed.

use crate::runtime::{Cmd, MatchHandle, spawn_match};
use dark_protocol::{BOT_ID_BASE, NO_PLAYER, RoomSettings, room_flags};
use dark_sim::game::Mode;
use dark_sim::{MapData, MatchConfig};
use std::collections::{HashMap, HashSet};
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
    #[error("no such room")]
    NoRoom,
    #[error("the room is full")]
    RoomFull,
    #[error("you were removed from this room")]
    Banned,
    #[error("only the room's owner can do that")]
    NotOwner,
}

/// What a room plays.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomKind {
    /// The endless procedural world with this seed (the server has no terrain for it).
    World { seed: u32 },
    /// A fixed map.
    Map { id: String },
}

/// The owner's choices when opening a room (code and owner are the server's).
#[derive(Clone, Debug)]
pub struct RoomSetup {
    pub kind: RoomKind,
    pub name: String,
    pub private: bool,
    pub max_players: u16,
    pub roadkill: bool,
    pub flying: bool,
    /// Server-run bots (0–100).
    pub bots: u8,
}

/// A change to a room's settings (absent = unchanged).
#[derive(Clone, Debug, Default)]
pub struct RoomPatch {
    pub name: Option<String>,
    pub private: Option<bool>,
    pub max_players: Option<u16>,
    pub roadkill: Option<bool>,
    pub flying: Option<bool>,
    pub bots: Option<u8>,
}

struct Entry {
    handle: MatchHandle,
    next_pid: u16,
    /// session sub → (seat, reserved at)
    seats: HashMap<String, (u16, Instant)>,
    /// Rooms only: what it plays, its code, the owner's removals.
    room: Option<(RoomKind, String)>,
    banned: HashSet<String>,
}

impl Entry {
    fn take_seat(&mut self, sub: &str) -> u16 {
        let pid = self.next_pid;
        // ids 1 … BOT_ID_BASE − 1 (0 unused; bots have the ids above)
        self.next_pid = if self.next_pid >= BOT_ID_BASE - 1 {
            1
        } else {
            self.next_pid + 1
        };
        self.seats.insert(sub.to_owned(), (pid, Instant::now()));
        pid
    }

    /// Drop lapsed reservations; seats taken (reserved or connected).
    fn taken(&mut self, ttl: Duration) -> usize {
        let now = Instant::now();
        let connected = self.handle.info.connected.lock().map(|c| c.clone()).unwrap_or_default();
        self.seats
            .retain(|_, (pid, at)| connected.contains(pid) || now.duration_since(*at) < ttl);
        self.seats.len().max(self.handle.info.players.load(Ordering::Relaxed))
    }
}

pub struct Registry {
    maps: HashMap<String, Arc<MapData>>,
    default_map: String,
    rules: MatchConfig,
    max_matches: usize,
    max_rooms: usize,
    seat_ttl: Duration,
    accepting: AtomicBool,
    matches: Mutex<HashMap<u64, Entry>>,
    codes: Mutex<HashMap<String, u64>>,
    me: Weak<Registry>,
}

/// A reserved seat.
pub struct Seat {
    pub handle: MatchHandle,
    pub pid: u16,
}

/// A room as listings show it.
#[derive(Clone, Debug)]
pub struct RoomView {
    pub code: String,
    pub kind: RoomKind,
    pub settings: RoomSettings,
    pub players: usize,
    pub age_s: u64,
}

/// Room join codes: 6 characters without look-alikes (0/O, 1/I/L).
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

impl Registry {
    pub fn new(
        maps: HashMap<String, Arc<MapData>>,
        default_map: String,
        rules: MatchConfig,
        max_matches: usize,
        max_rooms: usize,
        seat_ttl: Duration,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            maps,
            default_map,
            rules,
            max_matches,
            max_rooms,
            seat_ttl,
            accepting: AtomicBool::new(true),
            matches: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
            me: me.clone(),
        })
    }

    pub fn default_map(&self) -> &str {
        &self.default_map
    }
    pub fn maps(&self) -> impl Iterator<Item = &str> {
        self.maps.keys().map(String::as_str)
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
    fn codes(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.codes.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn on_close(&self) -> impl FnOnce(u64) + Send + 'static {
        let me = self.me.clone();
        move |id| {
            if let Some(r) = me.upgrade() {
                if let Some(e) = r.lock().remove(&id)
                    && let Some((_, code)) = e.room
                {
                    r.codes().remove(&code);
                }
            }
        }
    }

    // ------------------------------------------------------------ battle royale

    pub fn matchmake(&self, sub: &str, map: Option<&str>) -> Result<Seat, MatchmakeError> {
        if !self.accepting() {
            return Err(MatchmakeError::Draining);
        }
        let map_id = map.unwrap_or(&self.default_map);
        let map = self.maps.get(map_id).ok_or(MatchmakeError::UnknownMap)?.clone();
        let mut all = self.lock();
        // 1. a seat this player already holds
        for e in all.values() {
            if e.room.is_none()
                && e.handle.info.map == map_id
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
        let ttl = self.seat_ttl;
        let mut best: Option<(u64, usize)> = None;
        for (&id, e) in all.iter_mut() {
            let info = e.handle.info.clone();
            if e.room.is_some() || info.map != map_id || !info.joinable.load(Ordering::Relaxed) {
                continue;
            }
            let taken = e.taken(ttl);
            if taken < info.max_players.load(Ordering::Relaxed) && best.is_none_or(|(_, b)| taken > b) {
                best = Some((id, taken));
            }
        }
        let id = match best {
            Some((id, _)) => id,
            None => {
                if all.values().filter(|e| e.room.is_none()).count() >= self.max_matches {
                    return Err(MatchmakeError::Full);
                }
                let id = crate::auth::random_u64();
                let seed = (crate::auth::random_u64() >> 32) as u32;
                let rules = MatchConfig {
                    mode: Mode::BattleRoyale,
                    ..self.rules.clone()
                };
                let handle = spawn_match(id, seed, Some(map), rules, None, self.on_close());
                all.insert(
                    id,
                    Entry {
                        handle,
                        next_pid: 1,
                        seats: HashMap::new(),
                        room: None,
                        banned: HashSet::new(),
                    },
                );
                id
            }
        };
        let e = all.get_mut(&id).expect("just found or inserted");
        let pid = e.take_seat(sub);
        Ok(Seat {
            handle: e.handle.clone(),
            pid,
        })
    }

    // ------------------------------------------------------------ rooms

    fn new_code(&self) -> String {
        let codes = self.codes();
        loop {
            let mut v = crate::auth::random_u64();
            let code: String = (0..6)
                .map(|_| {
                    let c = CODE_ALPHABET[(v % CODE_ALPHABET.len() as u64) as usize] as char;
                    v /= CODE_ALPHABET.len() as u64;
                    c
                })
                .collect();
            if !codes.contains_key(&code) {
                return code;
            }
        }
    }

    /// Open a room for its owner (who gets the first seat).
    pub fn create_room(&self, sub: &str, setup: RoomSetup) -> Result<(Seat, RoomView), MatchmakeError> {
        if !self.accepting() {
            return Err(MatchmakeError::Draining);
        }
        let map = match &setup.kind {
            RoomKind::World { .. } => None,
            RoomKind::Map { id } => Some(self.maps.get(id).ok_or(MatchmakeError::UnknownMap)?.clone()),
        };
        let seed = match &setup.kind {
            RoomKind::World { seed } => *seed,
            RoomKind::Map { .. } => (crate::auth::random_u64() >> 32) as u32,
        };
        let mut all = self.lock();
        if all.values().filter(|e| e.room.is_some()).count() >= self.max_rooms {
            return Err(MatchmakeError::Full);
        }
        let code = self.new_code();
        let mut flags = 0;
        if setup.private {
            flags |= room_flags::PRIVATE;
        }
        if setup.roadkill {
            flags |= room_flags::ROADKILL;
        }
        if setup.flying {
            flags |= room_flags::FLYING;
        }
        let max_players = setup.max_players.clamp(1, 100);
        let settings = RoomSettings {
            code: code.clone(),
            name: setup.name,
            flags,
            max_players,
            owner: 1,
            bots: setup.bots.min(100),
        };
        let id = crate::auth::random_u64();
        let rules = MatchConfig {
            mode: Mode::FreeRoam,
            max_players: max_players as usize,
            ..self.rules.clone()
        };
        let handle = spawn_match(id, seed, map, rules, Some(settings.clone()), self.on_close());
        let mut e = Entry {
            handle: handle.clone(),
            next_pid: 1,
            seats: HashMap::new(),
            room: Some((setup.kind.clone(), code.clone())),
            banned: HashSet::new(),
        };
        let pid = e.take_seat(sub);
        all.insert(id, e);
        self.codes().insert(code.clone(), id);
        let view = RoomView {
            code,
            kind: setup.kind,
            settings,
            players: 0,
            age_s: 0,
        };
        Ok((Seat { handle, pid }, view))
    }

    fn room_id(&self, code: &str) -> Option<u64> {
        self.codes().get(&code.trim().to_ascii_uppercase()).copied()
    }

    fn view(e: &Entry) -> Option<RoomView> {
        let (kind, code) = e.room.as_ref()?;
        let info = &e.handle.info;
        let settings = info.room.lock().ok()?.clone()?;
        Some(RoomView {
            code: code.clone(),
            kind: kind.clone(),
            settings,
            players: info.players.load(Ordering::Relaxed),
            age_s: info.created.elapsed().as_secs(),
        })
    }

    /// A room by its code (private ones too: knowing the code is the invitation).
    pub fn room(&self, code: &str) -> Option<RoomView> {
        let id = self.room_id(code)?;
        self.lock().get(&id).and_then(Self::view)
    }

    /// Public rooms, fullest first (then newest).
    pub fn public_rooms(&self) -> Vec<RoomView> {
        let mut v: Vec<RoomView> = self
            .lock()
            .values()
            .filter_map(Self::view)
            .filter(|r| r.settings.flags & room_flags::PRIVATE == 0)
            // (an emptied room lingers IDLE_CLOSE for its owner's reload, but there is no one to play with)
            .filter(|r| r.players > 0)
            .collect();
        v.sort_by(|a, b| b.players.cmp(&a.players).then(a.age_s.cmp(&b.age_s)));
        v
    }

    /// A seat in the room with this code.
    pub fn join_room(&self, code: &str, sub: &str) -> Result<(Seat, RoomView), MatchmakeError> {
        if !self.accepting() {
            return Err(MatchmakeError::Draining);
        }
        let id = self.room_id(code).ok_or(MatchmakeError::NoRoom)?;
        let mut all = self.lock();
        let e = all.get_mut(&id).ok_or(MatchmakeError::NoRoom)?;
        if e.banned.contains(sub) {
            return Err(MatchmakeError::Banned);
        }
        let view = Self::view(e).ok_or(MatchmakeError::NoRoom)?;
        if let Some(&(pid, _)) = e.seats.get(sub) {
            return Ok((
                Seat {
                    handle: e.handle.clone(),
                    pid,
                },
                view,
            ));
        }
        let max = e.handle.info.max_players.load(Ordering::Relaxed);
        if !e.handle.info.joinable.load(Ordering::Relaxed) || e.taken(self.seat_ttl) >= max {
            return Err(MatchmakeError::RoomFull);
        }
        let pid = e.take_seat(sub);
        Ok((
            Seat {
                handle: e.handle.clone(),
                pid,
            },
            view,
        ))
    }

    /// The room's entry if `sub` is its current owner (the owner's seat; ownership passes on when the owner leaves).
    fn owned<'a>(all: &'a mut HashMap<u64, Entry>, id: u64, sub: &str) -> Result<&'a mut Entry, MatchmakeError> {
        let e = all.get_mut(&id).ok_or(MatchmakeError::NoRoom)?;
        let owner = e
            .handle
            .info
            .room
            .lock()
            .ok()
            .and_then(|r| r.as_ref().map(|r| r.owner))
            .unwrap_or(NO_PLAYER);
        match e.seats.get(sub) {
            Some(&(pid, _)) if pid == owner => Ok(e),
            _ => Err(MatchmakeError::NotOwner),
        }
    }

    /// The owner changes the room's settings (applied at the match's next tick; returns them as they will be).
    pub fn configure(&self, code: &str, sub: &str, patch: RoomPatch) -> Result<RoomView, MatchmakeError> {
        let id = self.room_id(code).ok_or(MatchmakeError::NoRoom)?;
        let mut all = self.lock();
        let e = Self::owned(&mut all, id, sub)?;
        let mut view = Self::view(e).ok_or(MatchmakeError::NoRoom)?;
        let s = &mut view.settings;
        if let Some(n) = patch.name {
            s.name = n;
        }
        let mut set = |bit: u8, on: Option<bool>| match on {
            Some(true) => s.flags |= bit,
            Some(false) => s.flags &= !bit,
            None => {}
        };
        set(room_flags::PRIVATE, patch.private);
        set(room_flags::ROADKILL, patch.roadkill);
        set(room_flags::FLYING, patch.flying);
        if let Some(m) = patch.max_players {
            s.max_players = m.clamp(1, 100);
        }
        if let Some(b) = patch.bots {
            s.bots = b.min(100);
        }
        // the runtime publishes them next tick; mirror now so the listing shows the change at once
        if let Ok(mut cur) = e.handle.info.room.lock() {
            *cur = Some(s.clone());
        }
        e.handle
            .info
            .max_players
            .store(s.max_players as usize, Ordering::Relaxed);
        let _ = e.handle.tx.try_send(Cmd::Configure(s.clone()));
        Ok(view)
    }

    /// The owner removes a player from the room (and bars them from rejoining it).
    pub fn kick(&self, code: &str, sub: &str, pid: u16) -> Result<(), MatchmakeError> {
        let id = self.room_id(code).ok_or(MatchmakeError::NoRoom)?;
        let mut all = self.lock();
        let e = Self::owned(&mut all, id, sub)?;
        if let Some(victim) = e.seats.iter().find(|(_, (p, _))| *p == pid).map(|(s, _)| s.clone()) {
            if victim == sub {
                return Ok(()); // (not yourself)
            }
            e.seats.remove(&victim);
            e.banned.insert(victim);
        }
        let _ = e.handle.tx.try_send(Cmd::Kick(pid));
        Ok(())
    }

    // ------------------------------------------------------------ shared

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

    /// Stop handing out seats (SIGTERM): running matches and rooms play on.
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
