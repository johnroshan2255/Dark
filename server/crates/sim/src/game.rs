//! One MATCH: lobby → countdown → running (zone closes, damage, eliminations) → ended.

use crate::interest::{self, Grid, InterestConfig};
use crate::map::MapData;
use crate::rng::Rng;
use crate::validate::{self, Ctx, Limits, Pose, Reject};
use crate::zone::{self, Stage, ZoneState};
use dark_protocol::*;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct MatchConfig {
    /// Seats per match.
    pub max_players: usize,
    /// Players needed before the lobby timer starts.
    pub min_players: usize,
    /// Lobby wait once `min_players` are in (s); a full lobby starts at once.
    pub lobby_s: f32,
    /// Countdown before the drop (s).
    pub countdown_s: f32,
    /// How long the result stays up before the match closes (s).
    pub end_linger_s: f32,
    /// Simulation / snapshot ticks per second.
    pub tick_hz: u32,
    /// Minimum distance between start points (m).
    pub spawn_spacing_m: f32,
    pub limits: Limits,
    pub interest: InterestConfig,
    pub zone: Vec<Stage>,
    /// Roadkill: a vehicle faster than this relative to a player on foot (m/s) within `roadkill_radius_m` hurts them,
    /// `roadkill_hp_per_mps` HP per m/s over `roadkill_min_mps − 2`.
    pub roadkill_min_mps: f32,
    pub roadkill_radius_m: f32,
    pub roadkill_hp_per_mps: f32,
    /// Violation score that gets a client kicked, and how fast it decays (per s).
    pub violation_kick: f32,
    pub violation_decay: f32,
}

impl Default for MatchConfig {
    fn default() -> Self {
        Self {
            max_players: 100,
            min_players: 2,
            lobby_s: 60.0,
            countdown_s: 10.0,
            end_linger_s: 20.0,
            tick_hz: 30,
            spawn_spacing_m: 60.0,
            limits: Limits::default(),
            interest: InterestConfig::default(),
            zone: zone::default_stages(),
            roadkill_min_mps: 8.0,
            roadkill_radius_m: 3.0,
            roadkill_hp_per_mps: 6.0,
            violation_kick: 25.0,
            violation_decay: 1.0,
        }
    }
}

/// A packet (or a kick) the runtime must deliver.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    To(u16, ServerMsg),
    All(ServerMsg),
    Kick(u16, KickReason, &'static str),
    /// Informational: a pose was rejected (the `Correction` follows) — for metrics / logs.
    Rejected(u16, Reject),
}

/// Read-only view of a player (admin listing, metrics).
#[derive(Clone, Debug, PartialEq)]
pub struct PlayerView {
    pub id: u16,
    pub name: String,
    pub alive: bool,
    pub hp: f32,
    pub pos: [f32; 3],
    pub placement: u8,
}

struct Player {
    name: String,
    pose: Pose,
    has_pose: bool,
    last_accept_ms: u64,
    last_seq: u32,
    /// Bumped by every correction / reposition; states carrying an older one were sent before the client saw it.
    epoch: u8,
    hp: f32,
    alive: bool,
    placement: u8,
    violations: f32,
    bail_ms: Option<u64>,
    grace: bool,
    last_hit_ms: u64,
    known: HashSet<u16>,
    spectate: Option<u16>,
}

pub struct Match {
    pub id: u64,
    pub seed: u32,
    cfg: MatchConfig,
    map: Arc<MapData>,
    rng: Rng,
    now_ms: u64,
    tick: u32,
    phase: Phase,
    phase_until_ms: u64,
    lobby_armed: bool,
    players: BTreeMap<u16, Player>,
    lobby_slots: usize,
    zone: Option<ZoneState>,
    running_start_ms: u64,
    started_with: usize,
    finished: bool,
    out: Vec<Out>,
    grid: Grid,
    cand: Vec<(u16, f32)>,
    sel: Vec<u16>,
    w: Writer,
}

fn pose_from(s: &State) -> Pose {
    Pose {
        pos: [cm_to_m(s.pos[0]), cm_to_m(s.pos[1]), cm_to_m(s.pos[2])],
        vel: [cms_to_mps(s.vel[0]), cms_to_mps(s.vel[1]), cms_to_mps(s.vel[2])],
        yaw: u16_to_yaw(s.yaw),
        pitch: i16_to_pitch(s.pitch),
        flags: s.flags,
        model: s.model,
    }
}

fn violation_weight(r: Reject) -> f32 {
    match r {
        Reject::TooFast | Reject::UnderGround => 1.0,
        Reject::OutOfBounds => 3.0,
        Reject::Teleport | Reject::Flying | Reject::BadNumber => 6.0,
    }
}

impl Match {
    pub fn new(id: u64, seed: u32, map: Arc<MapData>, cfg: MatchConfig, now_ms: u64) -> Self {
        Self {
            id,
            seed,
            rng: Rng::new(id ^ ((seed as u64) << 32)),
            cfg,
            map,
            now_ms,
            tick: 0,
            phase: Phase::Lobby,
            phase_until_ms: 0,
            lobby_armed: false,
            players: BTreeMap::new(),
            lobby_slots: 0,
            zone: None,
            running_start_ms: 0,
            started_with: 0,
            finished: false,
            out: Vec::new(),
            grid: Grid::new(64.0),
            cand: Vec::new(),
            sel: Vec::new(),
            w: Writer::with_capacity(4096),
        }
    }

    pub fn config(&self) -> &MatchConfig {
        &self.cfg
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn tick(&self) -> u32 {
        self.tick
    }
    pub fn player_count(&self) -> usize {
        self.players.len()
    }
    pub fn alive_count(&self) -> usize {
        self.players.values().filter(|p| p.alive).count()
    }
    /// Seats can still be taken (lobby / countdown, not full).
    pub fn joinable(&self) -> bool {
        matches!(self.phase, Phase::Lobby | Phase::Countdown)
            && self.players.len() < self.cfg.max_players
            && !self.finished
    }
    /// The match is over and its result has been shown: the runtime closes it.
    pub fn finished(&self) -> bool {
        self.finished
    }
    pub fn map_id(&self) -> &str {
        &self.map.id
    }
    pub fn players(&self) -> impl Iterator<Item = PlayerView> + '_ {
        self.players.iter().map(|(&id, p)| PlayerView {
            id,
            name: p.name.clone(),
            alive: p.alive,
            hp: p.hp,
            pos: p.pose.pos,
            placement: p.placement,
        })
    }

    /// Packets produced since the last drain.
    pub fn drain(&mut self) -> std::vec::Drain<'_, Out> {
        self.out.drain(..)
    }

    fn phase_msg(&self) -> ServerMsg {
        let left = self.phase_until_ms.saturating_sub(self.now_ms).min(u32::MAX as u64) as u32;
        ServerMsg::Phase {
            phase: self.phase,
            ends_in_ms: if self.phase == Phase::Lobby && !self.lobby_armed {
                0
            } else {
                left
            },
        }
    }

    /// A ticketed player connects. Returns the `Welcome` for them; the roster / phase go out via [`Match::drain`].
    pub fn join(&mut self, id: u16, name: &str) -> Result<ServerMsg, KickReason> {
        if self.players.contains_key(&id) {
            return Err(KickReason::Duplicate);
        }
        if !self.joinable() {
            return Err(if self.players.len() >= self.cfg.max_players {
                KickReason::MatchFull
            } else {
                KickReason::MatchOver
            });
        }
        let s = self.map.lobby_spawn(self.lobby_slots);
        self.lobby_slots += 1;
        let pose = Pose {
            pos: s.pos,
            yaw: s.yaw,
            ..Default::default()
        };
        // the newcomer learns who is here; everyone learns the newcomer
        for (&other, p) in &self.players {
            self.out.push(Out::To(
                id,
                ServerMsg::PlayerJoined {
                    id: other,
                    name: p.name.clone(),
                },
            ));
        }
        self.players.insert(
            id,
            Player {
                name: name.to_owned(),
                pose,
                has_pose: true,
                last_accept_ms: self.now_ms,
                last_seq: 0,
                epoch: 0,
                hp: 100.0,
                alive: true,
                placement: 0,
                violations: 0.0,
                bail_ms: None,
                grace: false, // the client starts where Welcome puts it: validated from there
                last_hit_ms: 0,
                known: HashSet::new(),
                spectate: None,
            },
        );
        self.out.push(Out::All(ServerMsg::PlayerJoined {
            id,
            name: name.to_owned(),
        }));
        self.out.push(Out::To(id, self.phase_msg()));
        Ok(ServerMsg::Welcome {
            protocol: PROTOCOL_VERSION,
            player_id: id,
            match_id: self.id,
            tick_rate: self.cfg.tick_hz.min(255) as u8,
            map: self.map.id.clone(),
            seed: self.seed,
            spawn: [m_to_cm(s.pos[0]), m_to_cm(s.pos[1]), m_to_cm(s.pos[2])],
            yaw: yaw_to_u16(s.yaw),
            server_time: self.now_ms.min(u32::MAX as u64) as u32,
        })
    }

    /// A player's connection closed. Mid-match an alive player is eliminated (no reconnect seat in v1).
    pub fn leave(&mut self, id: u16) {
        let Some(p) = self.players.get(&id) else { return };
        if self.phase == Phase::Running && p.alive {
            self.eliminate(id, NO_PLAYER, Cause::Disconnect);
        }
        self.players.remove(&id);
        for p in self.players.values_mut() {
            p.known.remove(&id);
        }
        self.out.push(Out::All(ServerMsg::PlayerLeft { id }));
    }

    /// The client's pose. Accepted, or answered with a correction (and a kick past the violation limit).
    pub fn on_state(&mut self, id: u16, s: &State) {
        let now = self.now_ms;
        let (map, lim, kick_at) = (&self.map, &self.cfg.limits, self.cfg.violation_kick);
        let Some(p) = self.players.get_mut(&id) else { return };
        // spectators don't move; old / duplicate states and states from before a correction are ignored
        if !p.alive || s.epoch != p.epoch || s.seq <= p.last_seq && p.last_seq != 0 {
            return;
        }
        let next = pose_from(s);
        if p.pose.model != 0 && next.model == 0 {
            p.bail_ms = Some(now);
        }
        let ctx = Ctx {
            dt: now.saturating_sub(p.last_accept_ms) as f32 / 1000.0,
            since_bail: p
                .bail_ms
                .map_or(f32::INFINITY, |b| now.saturating_sub(b) as f32 / 1000.0),
            grace: p.grace,
        };
        match validate::check(&p.pose, &next, ctx, map, lim) {
            Ok(()) => {
                p.pose = next;
                p.has_pose = true;
                p.last_seq = s.seq;
                p.last_accept_ms = now;
                p.grace = false;
            }
            Err(r) => {
                p.violations += violation_weight(r);
                self.out.push(Out::Rejected(id, r));
                p.last_seq = s.seq; // acked as handled: the client snaps to the correction
                p.epoch = p.epoch.wrapping_add(1);
                let c = p.pose;
                self.out.push(Out::To(
                    id,
                    ServerMsg::Correction {
                        seq: s.seq,
                        epoch: p.epoch,
                        pos: [m_to_cm(c.pos[0]), m_to_cm(c.pos[1]), m_to_cm(c.pos[2])],
                        yaw: yaw_to_u16(c.yaw),
                    },
                ));
                if p.violations >= kick_at {
                    self.out.push(Out::Kick(id, KickReason::Cheating, r.as_str()));
                }
            }
        }
    }

    pub fn on_action(&mut self, id: u16, kind: ActionKind, target: u16) {
        let Some(p) = self.players.get_mut(&id) else { return };
        match kind {
            // the car is set down upright near where it was (≤ 9 m): skip one distance check
            ActionKind::RespawnVehicle => p.grace = true,
            ActionKind::Ready => {}
            ActionKind::Spectate => {
                if !p.alive {
                    p.spectate = Some(target);
                }
            }
        }
    }

    /// Advance the match to `now_ms` (called once per tick).
    pub fn step(&mut self, now_ms: u64) {
        let dt = now_ms.saturating_sub(self.now_ms) as f32 / 1000.0;
        self.now_ms = now_ms;
        self.tick = self.tick.wrapping_add(1);
        let decay = self.cfg.violation_decay * dt;
        for p in self.players.values_mut() {
            p.violations = (p.violations - decay).max(0.0);
        }
        match self.phase {
            Phase::Lobby => {
                let n = self.players.len();
                if n >= self.cfg.max_players {
                    self.begin_countdown();
                } else if n >= self.cfg.min_players {
                    if !self.lobby_armed {
                        self.lobby_armed = true;
                        self.phase_until_ms = now_ms + (self.cfg.lobby_s * 1000.0) as u64;
                        self.out.push(Out::All(self.phase_msg()));
                    } else if now_ms >= self.phase_until_ms {
                        self.begin_countdown();
                    }
                } else if self.lobby_armed {
                    self.lobby_armed = false;
                    self.out.push(Out::All(self.phase_msg()));
                }
            }
            Phase::Countdown => {
                if self.players.len() < self.cfg.min_players {
                    self.phase = Phase::Lobby;
                    self.lobby_armed = false;
                    self.out.push(Out::All(self.phase_msg()));
                } else if now_ms >= self.phase_until_ms {
                    self.begin_running();
                }
            }
            Phase::Running => {
                if let Some(z) = self.zone.as_mut()
                    && z.update(&self.map, now_ms, &mut self.rng)
                {
                    let w = z.wire(self.running_start_ms);
                    self.out.push(Out::All(ServerMsg::Zone(w)));
                }
                self.zone_damage(dt);
                self.roadkill();
            }
            Phase::Ended => {
                if now_ms >= self.phase_until_ms {
                    self.finished = true;
                }
            }
        }
        self.rebuild_grid();
    }

    fn begin_countdown(&mut self) {
        self.phase = Phase::Countdown;
        self.phase_until_ms = self.now_ms + (self.cfg.countdown_s * 1000.0) as u64;
        self.out.push(Out::All(self.phase_msg()));
    }

    fn begin_running(&mut self) {
        self.phase = Phase::Running;
        self.running_start_ms = self.now_ms;
        self.started_with = self.players.len();
        let spawns = self
            .map
            .spawn_points(self.players.len(), self.cfg.spawn_spacing_m, &mut self.rng);
        for ((&id, p), s) in self.players.iter_mut().zip(spawns) {
            p.pose = Pose {
                pos: s.pos,
                yaw: s.yaw,
                ..Default::default()
            };
            p.hp = 100.0;
            p.alive = true;
            p.grace = true;
            p.last_accept_ms = self.now_ms;
            p.epoch = p.epoch.wrapping_add(1);
            self.out.push(Out::To(
                id,
                ServerMsg::Correction {
                    seq: p.last_seq,
                    epoch: p.epoch,
                    pos: [m_to_cm(s.pos[0]), m_to_cm(s.pos[1]), m_to_cm(s.pos[2])],
                    yaw: yaw_to_u16(s.yaw),
                },
            ));
        }
        let z = ZoneState::new(&self.map, self.cfg.zone.clone(), self.now_ms, &mut self.rng);
        self.out.push(Out::All(ServerMsg::Zone(z.wire(self.running_start_ms))));
        self.zone = Some(z);
        self.phase_until_ms = self.now_ms;
        self.out.push(Out::All(self.phase_msg()));
        self.check_end();
    }

    fn zone_damage(&mut self, dt: f32) {
        let Some(z) = &self.zone else { return };
        let c = z.circle(self.now_ms);
        let dps = z.dps();
        let mut dead = Vec::new();
        for (&id, p) in self.players.iter_mut() {
            if p.alive && !c.contains(p.pose.pos[0], p.pose.pos[2]) {
                p.hp -= dps * dt;
                if p.hp <= 0.0 {
                    dead.push(id);
                }
            }
        }
        for id in dead {
            self.eliminate(id, NO_PLAYER, Cause::Zone);
        }
    }

    /// A player on foot hit by another player's vehicle.
    fn roadkill(&mut self) {
        let (min, r, k) = (
            self.cfg.roadkill_min_mps,
            self.cfg.roadkill_radius_m,
            self.cfg.roadkill_hp_per_mps,
        );
        let drivers: Vec<(u16, Pose)> = self
            .players
            .iter()
            .filter(|(_, p)| p.alive && p.pose.flags & flags::DRIVING != 0 && speed(&p.pose.vel) > min)
            .map(|(&id, p)| (id, p.pose))
            .collect();
        let mut hits: Vec<(u16, u16, f32)> = Vec::new();
        for (did, d) in drivers {
            self.grid.query(d.pos[0], d.pos[2], r, did, &mut self.cand);
            for &(vid, _) in &self.cand {
                let Some(v) = self.players.get(&vid) else { continue };
                if !v.alive || v.pose.flags & flags::DRIVING != 0 || (v.pose.pos[1] - d.pos[1]).abs() > 2.5 {
                    continue;
                }
                if self.now_ms < v.last_hit_ms + 1000 {
                    continue;
                }
                let rel = speed(&[
                    d.vel[0] - v.pose.vel[0],
                    d.vel[1] - v.pose.vel[1],
                    d.vel[2] - v.pose.vel[2],
                ]);
                if rel > min {
                    hits.push((vid, did, (rel - (min - 2.0)) * k));
                }
            }
        }
        for (vid, did, dmg) in hits {
            let now = self.now_ms;
            let Some(v) = self.players.get_mut(&vid) else { continue };
            if !v.alive {
                continue;
            }
            v.last_hit_ms = now;
            v.hp -= dmg;
            if v.hp <= 0.0 {
                self.eliminate(vid, did, Cause::Roadkill);
            }
        }
    }

    fn eliminate(&mut self, victim: u16, killer: u16, cause: Cause) {
        let placement = self.alive_count().min(255) as u8;
        let Some(p) = self.players.get_mut(&victim) else { return };
        if !p.alive {
            return;
        }
        p.alive = false;
        p.hp = 0.0;
        p.placement = placement;
        p.pose.flags |= flags::DEAD;
        self.out.push(Out::All(ServerMsg::Eliminated {
            victim,
            killer,
            cause,
            placement,
        }));
        self.check_end();
    }

    fn check_end(&mut self) {
        if self.phase != Phase::Running {
            return;
        }
        let alive = self.alive_count();
        let last = if self.started_with > 1 { 1 } else { 0 };
        if alive > last {
            return;
        }
        let winner = self.players.iter_mut().find(|(_, p)| p.alive).map(|(&id, p)| {
            p.placement = 1;
            id
        });
        self.phase = Phase::Ended;
        self.phase_until_ms = self.now_ms + (self.cfg.end_linger_s * 1000.0) as u64;
        self.out.push(Out::All(ServerMsg::MatchEnd {
            winner: winner.unwrap_or(NO_PLAYER),
            placement: 1,
        }));
        self.out.push(Out::All(self.phase_msg()));
    }

    fn rebuild_grid(&mut self) {
        self.grid.clear();
        for (&id, p) in &self.players {
            if p.alive && p.has_pose {
                self.grid.insert(id, p.pose.pos[0], p.pose.pos[2]);
            }
        }
    }

    /// Encode this tick's snapshot for every player into `out` (player id, packet bytes). Reuses buffers.
    pub fn snapshots(&mut self, out: &mut Vec<(u16, Vec<u8>)>) {
        out.clear();
        let ids: Vec<u16> = self.players.keys().copied().collect();
        let alive = self.alive_count().min(255) as u8;
        let far = self.cfg.interest.far_m;
        for id in ids {
            let (centre, hp, ack) = {
                let p = &self.players[&id];
                let focus = if p.alive {
                    None
                } else {
                    p.spectate.and_then(|t| self.players.get(&t)).filter(|t| t.alive)
                };
                (
                    focus.map_or(p.pose.pos, |t| t.pose.pos),
                    p.hp.max(0.0).ceil().min(255.0) as u8,
                    p.last_seq,
                )
            };
            self.grid.query(centre[0], centre[2], far, id, &mut self.cand);
            let relevant: HashSet<u16> = self.cand.iter().map(|c| c.0).collect();
            {
                let known = &self.players[&id].known;
                interest::select(
                    &self.cfg.interest,
                    self.tick,
                    &mut self.cand,
                    |e| known.contains(&e),
                    &mut self.sel,
                );
            }
            let p = self.players.get(&id).expect("listed");
            let removed: Vec<u16> = p.known.iter().copied().filter(|e| !relevant.contains(e)).collect();
            let entities: Vec<EntityState> = self
                .sel
                .iter()
                .filter_map(|e| self.players.get(e).map(|q| (*e, q)))
                .map(|(e, q)| EntityState {
                    id: e,
                    flags: q.pose.flags,
                    model: q.pose.model,
                    pos: [m_to_cm(q.pose.pos[0]), m_to_cm(q.pose.pos[1]), m_to_cm(q.pose.pos[2])],
                    yaw: yaw_to_u16(q.pose.yaw),
                    pitch: pitch_to_i16(q.pose.pitch),
                    vel: [
                        mps_to_cms(q.pose.vel[0]),
                        mps_to_cms(q.pose.vel[1]),
                        mps_to_cms(q.pose.vel[2]),
                    ],
                })
                .collect();
            let msg = ServerMsg::Snapshot {
                tick: self.tick,
                server_time: self.now_ms.min(u32::MAX as u64) as u32,
                ack_seq: ack,
                hp,
                alive,
                entities,
                removed,
            };
            self.w.clear();
            msg.encode(&mut self.w);
            out.push((id, self.w.buf.clone()));
            let p = self.players.get_mut(&id).expect("listed");
            p.known.retain(|e| relevant.contains(e));
            p.known.extend(self.sel.iter().copied());
        }
    }
}

fn speed(v: &[f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> MatchConfig {
        MatchConfig {
            min_players: 2,
            lobby_s: 1.0,
            countdown_s: 1.0,
            end_linger_s: 1.0,
            zone: vec![Stage {
                wait_s: 1.0,
                shrink_s: 1.0,
                radius_factor: 0.0,
                dps: 50.0,
            }],
            ..Default::default()
        }
    }

    fn state(seq: u32, pos: [f32; 3], vel: [f32; 3], fl: u8) -> State {
        State {
            seq,
            client_time: 0,
            epoch: 0,
            flags: fl,
            model: if fl & flags::DRIVING != 0 { 1 } else { 0 },
            pos: [m_to_cm(pos[0]), m_to_cm(pos[1]), m_to_cm(pos[2])],
            yaw: 0,
            pitch: 0,
            vel: [mps_to_cms(vel[0]), mps_to_cms(vel[1]), mps_to_cms(vel[2])],
        }
    }

    /// A client that has applied every correction: its state carries the player's current epoch.
    fn send(m: &mut Match, id: u16, mut s: State) {
        s.epoch = m.players[&id].epoch;
        m.on_state(id, &s);
    }

    fn kinds(m: &mut Match) -> Vec<Out> {
        m.drain().collect()
    }

    /// Steps until `t` ms in 33 ms ticks.
    fn run(m: &mut Match, from: u64, to: u64) {
        let mut t = from;
        while t < to {
            t += 33;
            m.step(t);
        }
    }

    #[test]
    fn lobby_countdown_running_zone_kills_and_a_winner() {
        let map = Arc::new(MapData::flat(1000.0, 0.0));
        let mut m = Match::new(1, 2, map, cfg(), 0);
        assert!(matches!(
            m.join(1, "a").unwrap(),
            ServerMsg::Welcome { player_id: 1, .. }
        ));
        assert_eq!(m.join(1, "again"), Err(KickReason::Duplicate));
        m.join(2, "b").unwrap();
        kinds(&mut m);
        run(&mut m, 0, 1100); // lobby timer (1 s)
        assert_eq!(m.phase(), Phase::Countdown);
        run(&mut m, 1100, 2200);
        assert_eq!(m.phase(), Phase::Running);
        assert!(!m.joinable());
        let out = kinds(&mut m);
        assert!(out.iter().any(|o| matches!(o, Out::All(ServerMsg::Zone(_)))));
        assert_eq!(
            out.iter()
                .filter(|o| matches!(o, Out::To(_, ServerMsg::Correction { .. })))
                .count(),
            2
        );
        // the zone closes to nothing at 50 HP/s: both die, the second one's death ends the match — no winner
        // (they die the same tick) or the survivor wins; either way the match ends
        run(&mut m, 2200, 9000);
        assert_eq!(m.phase(), Phase::Ended);
        let out = kinds(&mut m);
        assert!(
            out.iter()
                .any(|o| matches!(o, Out::All(ServerMsg::Eliminated { cause: Cause::Zone, .. })))
        );
        assert!(out.iter().any(|o| matches!(o, Out::All(ServerMsg::MatchEnd { .. }))));
        run(&mut m, 9000, 10_500);
        assert!(m.finished());
    }

    #[test]
    fn cheats_are_corrected_then_kicked() {
        let map = Arc::new(MapData::flat(1000.0, 0.0));
        let mut m = Match::new(1, 2, map, cfg(), 0);
        let ServerMsg::Welcome { spawn, .. } = m.join(1, "a").unwrap() else {
            panic!()
        };
        let s = [cm_to_m(spawn[0]), cm_to_m(spawn[1]), cm_to_m(spawn[2])];
        m.step(33);
        send(&mut m, 1, state(1, s, [0.0; 3], 0)); // first state (grace)
        m.step(66);
        send(&mut m, 1, state(2, [s[0] + 0.2, s[1], s[2]], [6.0, 0.0, 0.0], 0)); // a sprint step
        kinds(&mut m);
        let mut kicked = false;
        for i in 0..10u32 {
            m.step(100 + i as u64 * 33);
            send(&mut m, 1, state(3 + i, [s[0] + 500.0, s[1], s[2]], [0.0; 3], 0)); // teleport
            for o in kinds(&mut m) {
                match o {
                    Out::To(1, ServerMsg::Correction { pos, .. }) => {
                        assert!((cm_to_m(pos[0]) - (s[0] + 0.2)).abs() < 0.02)
                    }
                    Out::Kick(1, KickReason::Cheating, why) => {
                        assert_eq!(why, "teleport");
                        kicked = true;
                    }
                    _ => {}
                }
            }
        }
        assert!(kicked);
    }

    #[test]
    fn roadkill_credits_the_driver() {
        let map = Arc::new(MapData::flat(1000.0, 0.0));
        let mut m = Match::new(
            1,
            2,
            map,
            MatchConfig {
                zone: vec![Stage {
                    wait_s: 999.0,
                    shrink_s: 1.0,
                    radius_factor: 1.0,
                    dps: 0.0,
                }],
                ..cfg()
            },
            0,
        );
        for id in 1..=3 {
            m.join(id, "p").unwrap();
        }
        run(&mut m, 0, 2200);
        assert_eq!(m.phase(), Phase::Running);
        kinds(&mut m);
        // put 2 (on foot) and 1 (driving at 30 m/s) on the same spot
        let mut t = 2200;
        for k in 0..20u32 {
            t += 33;
            m.step(t);
            m.on_action(1, ActionKind::RespawnVehicle, 0);
            m.on_action(2, ActionKind::RespawnVehicle, 0);
            send(
                &mut m,
                1,
                state(100 + k, [0.0, 0.5, 0.0], [30.0, 0.0, 0.0], flags::DRIVING),
            );
            send(&mut m, 2, state(100 + k, [1.0, 0.5, 0.0], [0.0; 3], 0));
        }
        m.step(t + 33);
        let out = kinds(&mut m);
        assert!(
            out.iter().any(|o| matches!(
                o,
                Out::All(ServerMsg::Eliminated {
                    victim: 2,
                    killer: 1,
                    cause: Cause::Roadkill,
                    ..
                })
            )),
            "{out:?}"
        );
        assert_eq!(m.alive_count(), 2);
    }

    #[test]
    fn snapshots_are_interest_managed() {
        let map = Arc::new(MapData::flat(2000.0, 0.0));
        let mut m = Match::new(
            1,
            2,
            map,
            MatchConfig {
                min_players: 99,
                ..cfg()
            },
            0,
        );
        for id in 1..=30u16 {
            m.join(id, "p").unwrap();
        }
        // spread them along x, 100 m apart (each a granted reposition)
        for id in 1..=30u16 {
            m.on_action(id, ActionKind::RespawnVehicle, 0); // a granted reposition
            send(
                &mut m,
                id,
                state(1, [id as f32 * 100.0 - 1500.0, 0.5, 0.0], [0.0; 3], 0),
            );
        }
        m.step(33);
        let mut out = Vec::new();
        m.snapshots(&mut out);
        assert_eq!(out.len(), 30);
        let (_, bytes) = out.iter().find(|(id, _)| *id == 1).unwrap();
        let ServerMsg::Snapshot { entities, .. } = ServerMsg::decode(bytes).unwrap() else {
            panic!()
        };
        // player 1 at x = −1400: within 900 m are players 2..=10
        assert_eq!(entities.len(), 9);
        assert!(entities.iter().all(|e| (2..=10).contains(&e.id)));
        // move player 2 far away: next snapshot removes it
        m.step(66);
        m.on_action(2, ActionKind::RespawnVehicle, 0);
        send(&mut m, 2, state(2, [1900.0, 0.5, 0.0], [0.0; 3], 0));
        m.step(99);
        m.snapshots(&mut out);
        let (_, bytes) = out.iter().find(|(id, _)| *id == 1).unwrap();
        let ServerMsg::Snapshot { removed, .. } = ServerMsg::decode(bytes).unwrap() else {
            panic!()
        };
        assert_eq!(removed, vec![2]);
    }

    #[test]
    fn states_from_before_a_correction_are_ignored_not_judged() {
        let map = Arc::new(MapData::flat(1000.0, 0.0));
        let mut m = Match::new(1, 2, map, cfg(), 0);
        let ServerMsg::Welcome { spawn, .. } = m.join(1, "a").unwrap() else {
            panic!()
        };
        let s = [cm_to_m(spawn[0]), cm_to_m(spawn[1]), cm_to_m(spawn[2])];
        m.step(33);
        send(&mut m, 1, state(1, s, [0.0; 3], 0));
        m.step(66);
        send(&mut m, 1, state(2, [s[0] + 300.0, s[1], s[2]], [0.0; 3], 0)); // rejected → epoch 1
        let out = kinds(&mut m);
        assert!(
            out.iter()
                .any(|o| matches!(o, Out::To(1, ServerMsg::Correction { epoch: 1, .. })))
        );
        let v = m.players[&1].violations;
        // ten more in flight from before the client saw the correction (epoch 0): ignored, no new violations
        for k in 0..10u32 {
            m.step(100 + k as u64 * 33);
            m.on_state(1, &state(3 + k, [s[0] + 300.0 + k as f32, s[1], s[2]], [0.0; 3], 0));
        }
        assert!(
            kinds(&mut m)
                .iter()
                .all(|o| !matches!(o, Out::To(_, ServerMsg::Correction { .. })))
        );
        assert!(m.players[&1].violations <= v);
        assert_eq!(m.players[&1].pose.pos, s);
    }
}
