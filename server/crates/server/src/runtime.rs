//! The MATCH RUNTIME: one tokio task per match running `dark_sim::Match` at its tick rate.
//!
//! * Inputs arrive on a bounded command queue and are applied only at the tick (state changes one step at a time).
//! * Per connection: a RELIABLE lane (bounded; events, corrections, kicks — overflowing it means the client is dead
//!   or hopelessly behind, and it is dropped) and a LATEST-ONLY snapshot slot (`watch`: a slow client gets the newest
//!   snapshot, never a backlog).
//! * The tick body runs under `catch_unwind`: a bug in one match closes that match, never the process.

use crate::metrics as m;
use bytes::Bytes;
use dark_protocol::{ClientMsg, KickReason, Phase, RoomSettings, ServerMsg, Writer};
use dark_sim::{MapData, Match, MatchConfig, Out};
use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::MissedTickBehavior;
use tracing::{error, info, warn};

/// Reliable-lane depth per connection.
pub const RELIABLE_DEPTH: usize = 512;
/// Command queue depth per match (≈ 2 s of states from 100 players at 30 Hz).
pub const CMD_DEPTH: usize = 8192;
/// An empty lobby closes after this.
const IDLE_CLOSE: Duration = Duration::from_secs(120);

/// What the connection's writer task sends.
#[derive(Debug)]
pub enum Outgoing {
    Packet(Bytes),
    /// Send a `Kick` and close the socket.
    Close(KickReason, &'static str),
}

/// The match's handle on one connection.
pub struct Conn {
    pub tx: mpsc::Sender<Outgoing>,
    pub snap: watch::Sender<Bytes>,
}

pub enum Cmd {
    Join {
        pid: u16,
        name: String,
        conn: Conn,
        reply: oneshot::Sender<Result<Bytes, KickReason>>,
    },
    Msg {
        pid: u16,
        msg: ClientMsg,
    },
    /// Rooms: the owner's new settings.
    Configure(RoomSettings),
    /// Rooms: the owner removes a player.
    Kick(u16),
    Leave {
        pid: u16,
    },
    /// Server shutdown past the drain deadline: kick everyone, close.
    Shutdown,
}

/// Shared, lock-free view of a match (matchmaking, listings, readiness).
pub struct MatchInfo {
    pub id: u64,
    /// Map id, or "world" for an endless-world room.
    pub map: String,
    pub seed: u32,
    pub created: Instant,
    pub max_players: AtomicUsize,
    pub players: AtomicUsize,
    /// Server-run bots (rooms).
    pub bots: AtomicUsize,
    pub alive: AtomicUsize,
    phase: AtomicU8,
    pub joinable: AtomicBool,
    pub finished: AtomicBool,
    /// Player ids with a live connection (seat reservations count until then).
    pub connected: Mutex<HashSet<u16>>,
    /// Rooms: the current settings (owner, name, flags, seats) as the match last published them.
    pub room: Mutex<Option<RoomSettings>>,
}

impl MatchInfo {
    pub fn phase(&self) -> Phase {
        match self.phase.load(Ordering::Relaxed) {
            0 => Phase::Lobby,
            1 => Phase::Countdown,
            2 => Phase::Running,
            4 => Phase::FreeRoam,
            _ => Phase::Ended,
        }
    }
}

#[derive(Clone)]
pub struct MatchHandle {
    pub tx: mpsc::Sender<Cmd>,
    pub info: Arc<MatchInfo>,
    /// The match clock's zero (server_time in packets = ms since this).
    pub epoch: Instant,
}

impl MatchHandle {
    pub fn server_time(&self) -> u32 {
        self.epoch.elapsed().as_millis().min(u32::MAX as u128) as u32
    }
}

/// Start a match task. `on_close` runs once when the task ends (the registry forgets the match).
pub fn spawn_match(
    id: u64,
    seed: u32,
    map: Option<Arc<MapData>>,
    rules: MatchConfig,
    room: Option<RoomSettings>,
    on_close: impl FnOnce(u64) + Send + 'static,
) -> MatchHandle {
    let (tx, rx) = mpsc::channel(CMD_DEPTH);
    let epoch = Instant::now();
    let info = Arc::new(MatchInfo {
        id,
        map: map.as_ref().map_or_else(|| "world".to_owned(), |m| m.id.clone()),
        seed,
        created: epoch,
        max_players: AtomicUsize::new(rules.max_players),
        players: AtomicUsize::new(0),
        bots: AtomicUsize::new(0),
        alive: AtomicUsize::new(0),
        phase: AtomicU8::new(Phase::Lobby as u8),
        joinable: AtomicBool::new(true),
        finished: AtomicBool::new(false),
        connected: Mutex::new(HashSet::new()),
        room: Mutex::new(room.clone()),
    });
    let handle = MatchHandle {
        tx,
        info: info.clone(),
        epoch,
    };
    let hz = rules.tick_hz.max(1);
    let game = Match::new(id, seed, map, rules, room, 0);
    tokio::spawn(async move {
        info!(match_id = format_args!("{id:016x}"), map = %info.map, "match open");
        metrics::counter!(m::MATCHES_STARTED).increment(1);
        metrics::gauge!(m::MATCHES_ACTIVE).increment(1.0);
        let mut rt = Runtime {
            game,
            conns: HashMap::new(),
            info: info.clone(),
            epoch,
            rx,
            w: Writer::with_capacity(512),
            snaps: Vec::new(),
            empty_since: Some(Instant::now()),
            last_reject: None,
        };
        rt.run(hz).await;
        metrics::gauge!(m::BOTS_ACTIVE).decrement(info.bots.swap(0, Ordering::Relaxed) as f64);
        info.finished.store(true, Ordering::Relaxed);
        info.joinable.store(false, Ordering::Relaxed);
        metrics::gauge!(m::MATCHES_ACTIVE).decrement(1.0);
        metrics::counter!(m::MATCHES_FINISHED).increment(1);
        info!(match_id = format_args!("{id:016x}"), "match closed");
        on_close(id);
    });
    handle
}

struct Runtime {
    game: Match,
    conns: HashMap<u16, Conn>,
    info: Arc<MatchInfo>,
    epoch: Instant,
    rx: mpsc::Receiver<Cmd>,
    w: Writer,
    snaps: Vec<(u16, Vec<u8>)>,
    empty_since: Option<Instant>,
    /// The player whose rejection was just routed (its `Correction` follows it).
    last_reject: Option<u16>,
}

enum Flow {
    Continue,
    Close(KickReason, &'static str),
}

impl Runtime {
    async fn run(&mut self, hz: u32) {
        let period = Duration::from_secs_f64(1.0 / hz as f64);
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let t0 = Instant::now();
            let flow = match std::panic::catch_unwind(AssertUnwindSafe(|| self.tick())) {
                Ok(f) => f,
                Err(_) => {
                    error!(
                        match_id = format_args!("{:016x}", self.info.id),
                        "match panicked — closing it"
                    );
                    metrics::counter!(m::MATCH_PANICS).increment(1);
                    Flow::Close(KickReason::MatchOver, "server error")
                }
            };
            let took = t0.elapsed();
            metrics::histogram!(m::TICK_SECONDS).record(took.as_secs_f64());
            if took > period {
                metrics::counter!(m::TICK_OVERRUNS).increment(1);
            }
            if let Flow::Close(reason, why) = flow {
                for (_, c) in self.conns.drain() {
                    let _ = c.tx.try_send(Outgoing::Close(reason, why));
                    metrics::gauge!(m::PLAYERS_CONNECTED).decrement(1.0);
                }
                return;
            }
        }
    }

    /// One tick: commands → simulation → packets. Synchronous (panics are caught by `run`).
    fn tick(&mut self) -> Flow {
        loop {
            match self.rx.try_recv() {
                Ok(Cmd::Shutdown) => return Flow::Close(KickReason::ServerShutdown, "server shutting down"),
                Ok(cmd) => self.command(cmd),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    return Flow::Close(KickReason::ServerShutdown, "server shutting down");
                }
            }
        }
        let now = self.epoch.elapsed().as_millis() as u64;
        self.game.step(now);
        let outs: Vec<Out> = self.game.drain().collect();
        for o in outs {
            self.route(o);
        }
        self.game.snapshots(&mut self.snaps);
        let mut bytes = 0u64;
        for (pid, b) in self.snaps.drain(..) {
            if let Some(c) = self.conns.get(&pid) {
                bytes += b.len() as u64;
                c.snap.send_replace(Bytes::from(b));
            }
        }
        metrics::counter!(m::SNAPSHOT_BYTES).increment(bytes);
        let info = &self.info;
        info.players.store(self.game.player_count(), Ordering::Relaxed);
        let bots = self.game.bot_count();
        let before = info.bots.swap(bots, Ordering::Relaxed);
        if bots != before {
            metrics::gauge!(m::BOTS_ACTIVE).increment(bots as f64 - before as f64);
        }
        info.alive.store(self.game.alive_count(), Ordering::Relaxed);
        info.phase.store(self.game.phase() as u8, Ordering::Relaxed);
        info.joinable.store(self.game.joinable(), Ordering::Relaxed);
        info.max_players
            .store(self.game.config().max_players, Ordering::Relaxed);
        if let Some(r) = self.game.room()
            && let Ok(mut cur) = info.room.lock()
            && cur.as_ref() != Some(r)
        {
            *cur = Some(r.clone());
        }
        if self.game.finished() {
            return Flow::Close(KickReason::MatchOver, "match over");
        }
        if self.conns.is_empty() {
            let since = *self.empty_since.get_or_insert_with(Instant::now);
            // an empty lobby / room waits a while (seats may be reserved, the owner may be reloading into the room's
            // world); a match everyone left ends now
            if !matches!(self.game.phase(), Phase::Lobby | Phase::FreeRoam) || since.elapsed() > IDLE_CLOSE {
                return Flow::Close(KickReason::MatchOver, "match closed");
            }
        } else {
            self.empty_since = None;
        }
        Flow::Continue
    }

    fn command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Join { pid, name, conn, reply } => match self.game.join(pid, &name) {
                Ok(welcome) => {
                    self.w.clear();
                    welcome.encode(&mut self.w);
                    if reply.send(Ok(Bytes::copy_from_slice(&self.w.buf))).is_ok() {
                        self.conns.insert(pid, conn);
                        if let Ok(mut c) = self.info.connected.lock() {
                            c.insert(pid);
                        }
                        metrics::gauge!(m::PLAYERS_CONNECTED).increment(1.0);
                    } else {
                        self.game.leave(pid); // the connection went away while joining
                    }
                }
                Err(reason) => {
                    let _ = reply.send(Err(reason));
                }
            },
            Cmd::Msg { pid, msg } => match msg {
                ClientMsg::State(s) => self.game.on_state(pid, &s),
                ClientMsg::Action { kind, target } => self.game.on_action(pid, kind, target),
                ClientMsg::Leave => self.drop_player(pid),
                ClientMsg::Hello { .. } | ClientMsg::Ping { .. } => {}
            },
            Cmd::Configure(r) => self.game.configure(r),
            Cmd::Kick(pid) => self.game.kick(pid),
            Cmd::Leave { pid } => self.drop_player(pid),
            Cmd::Shutdown => {}
        }
    }

    fn drop_player(&mut self, pid: u16) {
        if self.conns.remove(&pid).is_some() {
            metrics::gauge!(m::PLAYERS_CONNECTED).decrement(1.0);
        }
        if let Ok(mut c) = self.info.connected.lock() {
            c.remove(&pid);
        }
        self.game.leave(pid);
    }

    fn encode(&mut self, msg: &ServerMsg) -> Bytes {
        self.w.clear();
        msg.encode(&mut self.w);
        Bytes::copy_from_slice(&self.w.buf)
    }

    fn route(&mut self, o: Out) {
        match o {
            Out::To(pid, msg) => {
                if matches!(msg, ServerMsg::Correction { .. })
                    && self.game.phase() == Phase::Running
                    && self.last_reject != Some(pid)
                {
                    // a correction without a rejection = the server moved the player (the drop to a spawn)
                    metrics::counter!(m::CORRECTIONS, "why" => "reposition").increment(1);
                }
                self.last_reject = None;
                let b = self.encode(&msg);
                self.send(pid, b);
            }
            Out::All(msg) => {
                let b = self.encode(&msg);
                let ids: Vec<u16> = self.conns.keys().copied().collect();
                for pid in ids {
                    self.send(pid, b.clone());
                }
            }
            Out::Rejected(pid, why) => {
                metrics::counter!(m::CORRECTIONS, "why" => why.as_str()).increment(1);
                self.last_reject = Some(pid);
            }
            Out::Kick(pid, reason, why) => {
                warn!(match_id = format_args!("{:016x}", self.info.id), player = pid, reason = ?reason, why, "kick");
                metrics::counter!(m::KICKS, "reason" => why).increment(1);
                if let Some(c) = self.conns.get(&pid) {
                    let _ = c.tx.try_send(Outgoing::Close(reason, why));
                }
                self.drop_player(pid);
            }
        }
    }

    /// Reliable send; a full lane drops the client (it can't keep up).
    fn send(&mut self, pid: u16, b: Bytes) {
        let Some(c) = self.conns.get(&pid) else { return };
        if let Err(mpsc::error::TrySendError::Full(_)) = c.tx.try_send(Outgoing::Packet(b)) {
            warn!(
                match_id = format_args!("{:016x}", self.info.id),
                player = pid,
                "reliable lane full — dropping client"
            );
            metrics::counter!(m::KICKS, "reason" => "backlog").increment(1);
            self.drop_player(pid);
        }
    }
}
