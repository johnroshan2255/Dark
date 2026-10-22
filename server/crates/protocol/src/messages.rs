//! The packets. Kind bytes are part of the wire contract (see `docs/PROTOCOL.md`).

use crate::codec::{DecodeError, Reader, Writer};
use crate::{MAX_PACKET, MAX_SNAPSHOT_ENTITIES};

/// Entity / state flag bits (`State.flags`, `EntityState.flags`).
pub mod flags {
    /// In a vehicle (`model` says which).
    pub const DRIVING: u8 = 1 << 0;
    /// The vehicle is in boat form / afloat.
    pub const BOAT: u8 = 1 << 1;
    /// No ground contact (jump, fall, car in the air).
    pub const AIRBORNE: u8 = 1 << 2;
    /// Eliminated (spectating) — server-set only.
    pub const DEAD: u8 = 1 << 3;
    /// Sprinting / boosting.
    pub const BOOST: u8 = 1 << 4;
    /// Headlights / flashlight on.
    pub const LIGHTS: u8 = 1 << 5;
    /// Braking (brake lamps).
    pub const BRAKING: u8 = 1 << 6;
    /// Flying (debug / creative only — rejected in matches).
    pub const FLYING: u8 = 1 << 7;
}

// ---------------------------------------------------------------- client → server

pub const C_HELLO: u8 = 0x01;
pub const C_STATE: u8 = 0x02;
pub const C_PING: u8 = 0x03;
pub const C_ACTION: u8 = 0x04;
pub const C_LEAVE: u8 = 0x05;
pub const C_INPUT: u8 = 0x06;
pub const C_VEHICLE: u8 = 0x07;

/// Most input frames one [`Input`] packet carries (the newest last).
pub const MAX_INPUT_FRAMES: usize = 8;

/// `InputFrame.buttons` bits.
pub mod buttons {
    /// The handbrake (Space).
    pub const HANDBRAKE: u8 = 1 << 0;
    /// Boost / nitrous (Shift).
    pub const BOOST: u8 = 1 << 1;
    /// The brake key is down (S / stick back) — arcade drift taps, the brake lamps.
    pub const BRAKE: u8 = 1 << 2;
    /// Lights on.
    pub const LIGHTS: u8 = 1 << 3;
    /// One-shot events (the frame the key went down): manual gear up / down, low range, the lockers.
    pub const SHIFT_UP: u8 = 1 << 4;
    pub const SHIFT_DOWN: u8 = 1 << 5;
    pub const LOW_RANGE: u8 = 1 << 6;
    pub const LOCKERS: u8 = 1 << 7;
}

/// `Input.opts` bits: the driver's settings (Settings → Controls) the car model runs with.
pub mod drive_opts {
    /// Driving aids: 0 off · 1 std · 2 full (the game's 'auto' = full).
    pub const AIDS_MASK: u8 = 0b11;
    /// Off-road assist on.
    pub const OFFROAD: u8 = 1 << 2;
    /// Manual gearbox.
    pub const MANUAL: u8 = 1 << 3;
}

/// A driver's controls for ONE physics step (the game's fixed 1/60 s) — what the server's car model runs on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputFrame {
    /// Stick steer −127 … 127 (+ = right) and the one-axis throttle −127 … 127 (+ = gas, − = brake / reverse).
    pub steer: i8,
    pub throttle: i8,
    /// Foot brake held together with the gas, 0 … 255.
    pub foot_brake: u8,
    /// [`buttons`] bits.
    pub buttons: u8,
    /// Air suspension up / down −127 … 127.
    pub lift: i8,
}

/// The newest input frames (oldest first; the last is frame `seq`). Sent ~30 Hz with the last few frames again, so a
/// lost packet loses no input; the server applies each frame once, in order, one per physics step.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Input {
    pub seq: u32,
    /// [`drive_opts`] bits.
    pub opts: u8,
    pub frames: Vec<InputFrame>,
}

/// Getting into (`enter`) or out of the server-simulated car: the car of wire `model` standing at `pos` facing `yaw`
/// (the server checks it is where the player is).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VehicleMsg {
    pub enter: bool,
    pub model: u8,
    pub pos: [i32; 3],
    pub yaw: u16,
}

/// The client's simulated pose this frame (sent at the client's tick, ~30 Hz). The server validates it
/// (speed, teleport, ground, map bounds) and either accepts it or answers with a [`ServerMsg::Correction`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    /// Increments per sent state; acked in snapshots.
    pub seq: u32,
    /// Client clock (ms, wrapping) when the state was sampled.
    pub client_time: u32,
    /// The last [`ServerMsg::Correction`] `epoch` the client has applied. States sampled before a server reposition
    /// (still in flight when it was sent) carry the old epoch and are ignored, not judged.
    pub epoch: u8,
    pub flags: u8,
    /// 0 = on foot, else the vehicle catalogue index + 1.
    pub model: u8,
    /// World position (cm): x, y (height), z.
    pub pos: [i32; 3],
    pub yaw: u16,
    pub pitch: i16,
    /// Velocity (cm/s): x, y, z.
    pub vel: [i16; 3],
}

/// One-shot intents (the server decides the outcome).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    /// "Respawn my car upright here" (R) — the server only records it; movement validation allows the jump.
    RespawnVehicle = 1,
    /// Ready in the lobby.
    Ready = 2,
    /// Spectate another player (`target`).
    Spectate = 3,
}

impl ActionKind {
    fn from_u8(v: u8) -> Result<Self, DecodeError> {
        Ok(match v {
            1 => Self::RespawnVehicle,
            2 => Self::Ready,
            3 => Self::Spectate,
            value => return Err(DecodeError::UnknownValue { what: "action", value }),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientMsg {
    /// First packet on a connection: the protocol version and the join ticket from `/v1/matchmake`.
    Hello {
        protocol: u16,
        ticket: String,
    },
    State(State),
    /// RTT probe; answered by [`ServerMsg::Pong`].
    Ping {
        client_time: u32,
    },
    Action {
        kind: ActionKind,
        target: u16,
    },
    /// Leaving voluntarily (the server keeps no seat).
    Leave,
    /// Driving a server-simulated car: the controls, frame by frame.
    Input(Input),
    /// Into / out of the server-simulated car.
    Vehicle(VehicleMsg),
}

impl ClientMsg {
    pub fn encode(&self, w: &mut Writer) {
        match self {
            Self::Hello { protocol, ticket } => {
                w.u8(C_HELLO);
                w.u16(*protocol);
                w.long_str(ticket);
            }
            Self::State(s) => {
                w.u8(C_STATE);
                w.u32(s.seq);
                w.u32(s.client_time);
                w.u8(s.epoch);
                w.u8(s.flags);
                w.u8(s.model);
                for v in s.pos {
                    w.i32(v);
                }
                w.u16(s.yaw);
                w.i16(s.pitch);
                for v in s.vel {
                    w.i16(v);
                }
            }
            Self::Ping { client_time } => {
                w.u8(C_PING);
                w.u32(*client_time);
            }
            Self::Action { kind, target } => {
                w.u8(C_ACTION);
                w.u8(*kind as u8);
                w.u16(*target);
            }
            Self::Leave => w.u8(C_LEAVE),
            Self::Input(i) => {
                w.u8(C_INPUT);
                w.u32(i.seq);
                w.u8(i.opts);
                let n = i.frames.len().min(MAX_INPUT_FRAMES);
                w.u8(n as u8);
                for f in &i.frames[i.frames.len() - n..] {
                    w.i8(f.steer);
                    w.i8(f.throttle);
                    w.u8(f.foot_brake);
                    w.u8(f.buttons);
                    w.i8(f.lift);
                }
            }
            Self::Vehicle(v) => {
                w.u8(C_VEHICLE);
                w.u8(v.enter as u8);
                w.u8(v.model);
                for p in v.pos {
                    w.i32(p);
                }
                w.u16(v.yaw);
            }
        }
    }

    pub fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        if buf.len() > MAX_PACKET {
            return Err(DecodeError::TooLarge(MAX_PACKET));
        }
        let mut r = Reader::new(buf);
        let kind = r.u8().map_err(|_| DecodeError::Empty)?;
        let msg = match kind {
            C_HELLO => Self::Hello {
                protocol: r.u16()?,
                ticket: r.long_str()?,
            },
            C_STATE => Self::State(State {
                seq: r.u32()?,
                client_time: r.u32()?,
                epoch: r.u8()?,
                flags: r.u8()?,
                model: r.u8()?,
                pos: [r.i32()?, r.i32()?, r.i32()?],
                yaw: r.u16()?,
                pitch: r.i16()?,
                vel: [r.i16()?, r.i16()?, r.i16()?],
            }),
            C_PING => Self::Ping { client_time: r.u32()? },
            C_ACTION => Self::Action {
                kind: ActionKind::from_u8(r.u8()?)?,
                target: r.u16()?,
            },
            C_LEAVE => Self::Leave,
            C_INPUT => {
                let seq = r.u32()?;
                let opts = r.u8()?;
                let n = r.u8()? as usize;
                if n == 0 || n > MAX_INPUT_FRAMES {
                    return Err(DecodeError::TooMany {
                        what: "input frames",
                        count: n,
                        max: MAX_INPUT_FRAMES,
                    });
                }
                let mut frames = Vec::with_capacity(n);
                for _ in 0..n {
                    frames.push(InputFrame {
                        steer: r.i8()?,
                        throttle: r.i8()?,
                        foot_brake: r.u8()?,
                        buttons: r.u8()?,
                        lift: r.i8()?,
                    });
                }
                Self::Input(Input { seq, opts, frames })
            }
            C_VEHICLE => Self::Vehicle(VehicleMsg {
                enter: r.u8()? != 0,
                model: r.u8()?,
                pos: [r.i32()?, r.i32()?, r.i32()?],
                yaw: r.u16()?,
            }),
            k => return Err(DecodeError::UnknownKind(k)),
        };
        r.finish()?;
        Ok(msg)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::with_capacity(64);
        self.encode(&mut w);
        w.buf
    }
}

// ---------------------------------------------------------------- server → client

pub const S_WELCOME: u8 = 0x81;
pub const S_SNAPSHOT: u8 = 0x82;
pub const S_PLAYER_JOINED: u8 = 0x83;
pub const S_PLAYER_LEFT: u8 = 0x84;
pub const S_PHASE: u8 = 0x85;
pub const S_ZONE: u8 = 0x86;
pub const S_ELIMINATED: u8 = 0x87;
pub const S_MATCH_END: u8 = 0x88;
pub const S_CORRECTION: u8 = 0x89;
pub const S_PONG: u8 = 0x8a;
pub const S_KICK: u8 = 0x8b;
pub const S_ROOM: u8 = 0x8c;
pub const S_VEHICLE: u8 = 0x8d;

/// The authoritative state of the player's own server-simulated car (sent to its driver every tick): what the client
/// reconciles its prediction against.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VehicleState {
    pub tick: u32,
    pub server_time: u32,
    /// The last [`Input`] frame applied (the state is the car AFTER it).
    pub ack: u32,
    /// Position (cm), rotation (quaternion x, y, z, w × 32767), velocity (cm/s), angular velocity (mrad/s).
    pub pos: [i32; 3],
    pub rot: [i16; 4],
    pub vel: [i16; 3],
    pub angvel: [i16; 3],
    /// Gear (−1 reverse, 0 neutral, 1…), engine speed (rad/s × 10), wheel spin per wheel (rad/s × 10).
    pub gear: i8,
    pub engine: u16,
    pub omega: [i16; 4],
}

/// Match phases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Waiting for players (everyone may move freely, no damage).
    Lobby = 0,
    /// Countdown to the start (positions are reset to spawn points at the end).
    Countdown = 1,
    /// The match: the zone closes, damage counts.
    Running = 2,
    /// A winner (or none); the match closes after `ends_in_ms`.
    Ended = 3,
    /// A ROOM: free roam, join any time, no zone; damage only if the room allows roadkill.
    FreeRoam = 4,
}

impl Phase {
    fn from_u8(v: u8) -> Result<Self, DecodeError> {
        Ok(match v {
            0 => Self::Lobby,
            1 => Self::Countdown,
            2 => Self::Running,
            3 => Self::Ended,
            4 => Self::FreeRoam,
            value => return Err(DecodeError::UnknownValue { what: "phase", value }),
        })
    }
}

/// Room flag bits (`RoomSettings.flags`).
pub mod room_flags {
    /// Hidden from the public room list (join by code only).
    pub const PRIVATE: u8 = 1 << 0;
    /// Vehicles hurt players on foot.
    pub const ROADKILL: u8 = 1 << 1;
    /// Flying vehicles allowed (else a FLYING state is rejected).
    pub const FLYING: u8 = 1 << 2;
    /// The server simulates the cars (a map room): drive with [`super::Input`], not poses (server-set).
    pub const PHYSICS: u8 = 1 << 3;
}

/// A room's settings as clients see them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RoomSettings {
    /// Join code (also shown for public rooms).
    pub code: String,
    pub name: String,
    pub flags: u8,
    pub max_players: u16,
    /// The owner's player id (NO_PLAYER when the owner has left).
    pub owner: u16,
    /// Server-run bots in the room (0–100; ids from `BOT_ID_BASE`).
    pub bots: u8,
}

/// Why a player was eliminated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    /// Outside the safe zone.
    Zone = 1,
    /// Hit by another player's vehicle.
    Roadkill = 2,
    /// Disconnected during the match.
    Disconnect = 3,
}

impl Cause {
    fn from_u8(v: u8) -> Result<Self, DecodeError> {
        Ok(match v {
            1 => Self::Zone,
            2 => Self::Roadkill,
            3 => Self::Disconnect,
            value => return Err(DecodeError::UnknownValue { what: "cause", value }),
        })
    }
}

/// Why the server closed the connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KickReason {
    BadTicket = 1,
    VersionMismatch = 2,
    MatchFull = 3,
    MatchOver = 4,
    Cheating = 5,
    Flooding = 6,
    Malformed = 7,
    Timeout = 8,
    ServerShutdown = 9,
    Duplicate = 10,
    /// The room's owner removed this player.
    Kicked = 11,
}

impl KickReason {
    fn from_u8(v: u8) -> Result<Self, DecodeError> {
        Ok(match v {
            1 => Self::BadTicket,
            2 => Self::VersionMismatch,
            3 => Self::MatchFull,
            4 => Self::MatchOver,
            5 => Self::Cheating,
            6 => Self::Flooding,
            7 => Self::Malformed,
            8 => Self::Timeout,
            9 => Self::ServerShutdown,
            10 => Self::Duplicate,
            11 => Self::Kicked,
            value => {
                return Err(DecodeError::UnknownValue {
                    what: "kick reason",
                    value,
                });
            }
        })
    }
}

/// One remote entity in a snapshot (28 bytes on the wire).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EntityState {
    pub id: u16,
    pub flags: u8,
    pub model: u8,
    pub pos: [i32; 3],
    pub yaw: u16,
    pub pitch: i16,
    /// Roll (+ = right side down), like pitch: ±32 767 = ±π/2. Server-simulated cars lean and bank.
    pub roll: i16,
    pub vel: [i16; 3],
}

/// The safe zone: the current circle, the circle it is closing to, and when it gets there.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Zone {
    /// Current centre (cm) and radius (cm).
    pub x: i32,
    pub z: i32,
    pub radius: u32,
    /// Target centre / radius (cm).
    pub target_x: i32,
    pub target_z: i32,
    pub target_radius: u32,
    /// Server time (ms since match start) the shrink starts / ends.
    pub shrink_start_ms: u32,
    pub shrink_end_ms: u32,
    /// Damage per second outside (HP).
    pub dps: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerMsg {
    Welcome {
        protocol: u16,
        player_id: u16,
        match_id: u64,
        /// Simulation ticks per second.
        tick_rate: u8,
        map: String,
        seed: u32,
        /// Where to start (cm) and facing.
        spawn: [i32; 3],
        yaw: u16,
        /// Server clock (ms since match creation) for clock sync.
        server_time: u32,
    },
    /// Remote entities near the player (interest-managed), the player's own health and the last accepted state.
    Snapshot {
        tick: u32,
        server_time: u32,
        /// Last `State.seq` the server accepted from this client.
        ack_seq: u32,
        hp: u8,
        alive: u8,
        entities: Vec<EntityState>,
        /// Entity ids no longer relevant to this client (remove them).
        removed: Vec<u16>,
    },
    PlayerJoined {
        id: u16,
        name: String,
    },
    PlayerLeft {
        id: u16,
    },
    Phase {
        phase: Phase,
        ends_in_ms: u32,
    },
    Zone(Zone),
    Eliminated {
        victim: u16,
        killer: u16,
        cause: Cause,
        placement: u8,
    },
    MatchEnd {
        winner: u16,
        placement: u8,
    },
    /// The server rejected the client's state, or moved the player (the drop at the start): snap to this pose and
    /// send `epoch` in every following `State`.
    Correction {
        seq: u32,
        epoch: u8,
        pos: [i32; 3],
        yaw: u16,
    },
    Pong {
        client_time: u32,
        server_time: u32,
    },
    Kick {
        reason: KickReason,
        message: String,
    },
    /// The room's settings (on join and whenever the owner changes them).
    Room(RoomSettings),
    /// The player's own server-simulated car.
    Vehicle(VehicleState),
}

impl ServerMsg {
    pub fn encode(&self, w: &mut Writer) {
        match self {
            Self::Welcome {
                protocol,
                player_id,
                match_id,
                tick_rate,
                map,
                seed,
                spawn,
                yaw,
                server_time,
            } => {
                w.u8(S_WELCOME);
                w.u16(*protocol);
                w.u16(*player_id);
                w.u64(*match_id);
                w.u8(*tick_rate);
                w.str(map);
                w.u32(*seed);
                for v in spawn {
                    w.i32(*v);
                }
                w.u16(*yaw);
                w.u32(*server_time);
            }
            Self::Snapshot {
                tick,
                server_time,
                ack_seq,
                hp,
                alive,
                entities,
                removed,
            } => {
                w.u8(S_SNAPSHOT);
                w.u32(*tick);
                w.u32(*server_time);
                w.u32(*ack_seq);
                w.u8(*hp);
                w.u8(*alive);
                let n = entities.len().min(MAX_SNAPSHOT_ENTITIES);
                w.u8(n as u8);
                for e in &entities[..n] {
                    encode_entity(w, e);
                }
                let m = removed.len().min(255);
                w.u8(m as u8);
                for id in &removed[..m] {
                    w.u16(*id);
                }
            }
            Self::PlayerJoined { id, name } => {
                w.u8(S_PLAYER_JOINED);
                w.u16(*id);
                w.str(name);
            }
            Self::PlayerLeft { id } => {
                w.u8(S_PLAYER_LEFT);
                w.u16(*id);
            }
            Self::Phase { phase, ends_in_ms } => {
                w.u8(S_PHASE);
                w.u8(*phase as u8);
                w.u32(*ends_in_ms);
            }
            Self::Zone(z) => {
                w.u8(S_ZONE);
                w.i32(z.x);
                w.i32(z.z);
                w.u32(z.radius);
                w.i32(z.target_x);
                w.i32(z.target_z);
                w.u32(z.target_radius);
                w.u32(z.shrink_start_ms);
                w.u32(z.shrink_end_ms);
                w.u8(z.dps);
            }
            Self::Eliminated {
                victim,
                killer,
                cause,
                placement,
            } => {
                w.u8(S_ELIMINATED);
                w.u16(*victim);
                w.u16(*killer);
                w.u8(*cause as u8);
                w.u8(*placement);
            }
            Self::MatchEnd { winner, placement } => {
                w.u8(S_MATCH_END);
                w.u16(*winner);
                w.u8(*placement);
            }
            Self::Correction { seq, epoch, pos, yaw } => {
                w.u8(S_CORRECTION);
                w.u32(*seq);
                w.u8(*epoch);
                for v in pos {
                    w.i32(*v);
                }
                w.u16(*yaw);
            }
            Self::Pong {
                client_time,
                server_time,
            } => {
                w.u8(S_PONG);
                w.u32(*client_time);
                w.u32(*server_time);
            }
            Self::Kick { reason, message } => {
                w.u8(S_KICK);
                w.u8(*reason as u8);
                w.str(message);
            }
            Self::Room(r) => {
                w.u8(S_ROOM);
                w.str(&r.code);
                w.str(&r.name);
                w.u8(r.flags);
                w.u16(r.max_players);
                w.u16(r.owner);
                w.u8(r.bots);
            }
            Self::Vehicle(v) => {
                w.u8(S_VEHICLE);
                w.u32(v.tick);
                w.u32(v.server_time);
                w.u32(v.ack);
                for x in v.pos {
                    w.i32(x);
                }
                for x in v.rot {
                    w.i16(x);
                }
                for x in v.vel {
                    w.i16(x);
                }
                for x in v.angvel {
                    w.i16(x);
                }
                w.i8(v.gear);
                w.u16(v.engine);
                for x in v.omega {
                    w.i16(x);
                }
            }
        }
    }

    pub fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        if buf.len() > MAX_PACKET {
            return Err(DecodeError::TooLarge(MAX_PACKET));
        }
        let mut r = Reader::new(buf);
        let kind = r.u8().map_err(|_| DecodeError::Empty)?;
        let msg = match kind {
            S_WELCOME => Self::Welcome {
                protocol: r.u16()?,
                player_id: r.u16()?,
                match_id: r.u64()?,
                tick_rate: r.u8()?,
                map: r.str()?,
                seed: r.u32()?,
                spawn: [r.i32()?, r.i32()?, r.i32()?],
                yaw: r.u16()?,
                server_time: r.u32()?,
            },
            S_SNAPSHOT => {
                let tick = r.u32()?;
                let server_time = r.u32()?;
                let ack_seq = r.u32()?;
                let hp = r.u8()?;
                let alive = r.u8()?;
                let n = r.u8()? as usize;
                if n > MAX_SNAPSHOT_ENTITIES {
                    return Err(DecodeError::TooMany {
                        what: "entities",
                        count: n,
                        max: MAX_SNAPSHOT_ENTITIES,
                    });
                }
                let mut entities = Vec::with_capacity(n);
                for _ in 0..n {
                    entities.push(decode_entity(&mut r)?);
                }
                let m = r.u8()? as usize;
                let mut removed = Vec::with_capacity(m);
                for _ in 0..m {
                    removed.push(r.u16()?);
                }
                Self::Snapshot {
                    tick,
                    server_time,
                    ack_seq,
                    hp,
                    alive,
                    entities,
                    removed,
                }
            }
            S_PLAYER_JOINED => Self::PlayerJoined {
                id: r.u16()?,
                name: r.str()?,
            },
            S_PLAYER_LEFT => Self::PlayerLeft { id: r.u16()? },
            S_PHASE => Self::Phase {
                phase: Phase::from_u8(r.u8()?)?,
                ends_in_ms: r.u32()?,
            },
            S_ZONE => Self::Zone(Zone {
                x: r.i32()?,
                z: r.i32()?,
                radius: r.u32()?,
                target_x: r.i32()?,
                target_z: r.i32()?,
                target_radius: r.u32()?,
                shrink_start_ms: r.u32()?,
                shrink_end_ms: r.u32()?,
                dps: r.u8()?,
            }),
            S_ELIMINATED => Self::Eliminated {
                victim: r.u16()?,
                killer: r.u16()?,
                cause: Cause::from_u8(r.u8()?)?,
                placement: r.u8()?,
            },
            S_MATCH_END => Self::MatchEnd {
                winner: r.u16()?,
                placement: r.u8()?,
            },
            S_CORRECTION => Self::Correction {
                seq: r.u32()?,
                epoch: r.u8()?,
                pos: [r.i32()?, r.i32()?, r.i32()?],
                yaw: r.u16()?,
            },
            S_PONG => Self::Pong {
                client_time: r.u32()?,
                server_time: r.u32()?,
            },
            S_KICK => Self::Kick {
                reason: KickReason::from_u8(r.u8()?)?,
                message: r.str()?,
            },
            S_ROOM => Self::Room(RoomSettings {
                code: r.str()?,
                name: r.str()?,
                flags: r.u8()?,
                max_players: r.u16()?,
                owner: r.u16()?,
                bots: r.u8()?,
            }),
            S_VEHICLE => Self::Vehicle(VehicleState {
                tick: r.u32()?,
                server_time: r.u32()?,
                ack: r.u32()?,
                pos: [r.i32()?, r.i32()?, r.i32()?],
                rot: [r.i16()?, r.i16()?, r.i16()?, r.i16()?],
                vel: [r.i16()?, r.i16()?, r.i16()?],
                angvel: [r.i16()?, r.i16()?, r.i16()?],
                gear: r.i8()?,
                engine: r.u16()?,
                omega: [r.i16()?, r.i16()?, r.i16()?, r.i16()?],
            }),
            k => return Err(DecodeError::UnknownKind(k)),
        };
        r.finish()?;
        Ok(msg)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::with_capacity(64);
        self.encode(&mut w);
        w.buf
    }
}

fn encode_entity(w: &mut Writer, e: &EntityState) {
    w.u16(e.id);
    w.u8(e.flags);
    w.u8(e.model);
    for v in e.pos {
        w.i32(v);
    }
    w.u16(e.yaw);
    w.i16(e.pitch);
    w.i16(e.roll);
    for v in e.vel {
        w.i16(v);
    }
}

fn decode_entity(r: &mut Reader) -> Result<EntityState, DecodeError> {
    Ok(EntityState {
        id: r.u16()?,
        flags: r.u8()?,
        model: r.u8()?,
        pos: [r.i32()?, r.i32()?, r.i32()?],
        yaw: r.u16()?,
        pitch: r.i16()?,
        roll: r.i16()?,
        vel: [r.i16()?, r.i16()?, r.i16()?],
    })
}

/// Bytes one [`EntityState`] takes on the wire.
pub const ENTITY_BYTES: usize = 28;
