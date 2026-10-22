//! Pins the wire format. `golden.json` (next to Cargo.toml) holds one hex packet per sample message; the TypeScript
//! codec (`game/src/net/protocol.ts`, `game/tests/protocol.test.ts`) decodes and re-encodes the same file, so the two
//! implementations can't drift. Regenerate after an intentional layout change (and bump PROTOCOL_VERSION):
//!     UPDATE_GOLDEN=1 cargo test -p dark-protocol --test golden

use dark_protocol::*;
use std::fmt::Write as _;

fn client_samples() -> Vec<(&'static str, ClientMsg)> {
    vec![
        (
            "hello",
            ClientMsg::Hello {
                protocol: PROTOCOL_VERSION,
                ticket: "abc.DEF-123_xyz".into(),
            },
        ),
        (
            "state",
            ClientMsg::State(State {
                seq: 4_000_000_001,
                client_time: 123_456,
                epoch: 3,
                flags: flags::DRIVING | flags::LIGHTS,
                model: 3,
                pos: [-120_034, 4_521, 98_765],
                yaw: 40_000,
                pitch: -1_234,
                vel: [2_500, -30, -1_200],
            }),
        ),
        ("ping", ClientMsg::Ping { client_time: 7 }),
        (
            "action",
            ClientMsg::Action {
                kind: ActionKind::Spectate,
                target: 42,
            },
        ),
        ("leave", ClientMsg::Leave),
        (
            "input",
            ClientMsg::Input(Input {
                seq: 4_000_000_123,
                opts: 2 | drive_opts::OFFROAD,
                frames: vec![
                    InputFrame {
                        steer: -127,
                        throttle: 127,
                        foot_brake: 0,
                        buttons: buttons::BOOST | buttons::LIGHTS,
                        lift: 0,
                    },
                    InputFrame {
                        steer: 64,
                        throttle: -100,
                        foot_brake: 255,
                        buttons: buttons::HANDBRAKE | buttons::BRAKE,
                        lift: -127,
                    },
                ],
            }),
        ),
        (
            "vehicle",
            ClientMsg::Vehicle(VehicleMsg {
                enter: true,
                model: 2,
                pos: [-55_500, 3_620, 120_001],
                yaw: 12_345,
            }),
        ),
        (
            "tow",
            ClientMsg::Tow(TowMsg {
                op: tow_op::HANG_FIXED,
                car: 0x8003,
                end: tow_end::REAR,
                car2: 17,
                end2: tow_end::FRONT,
                pos: [-55_210, 3_400, 119_870],
            }),
        ),
    ]
}

fn server_samples() -> Vec<(&'static str, ServerMsg)> {
    vec![
        (
            "welcome",
            ServerMsg::Welcome {
                protocol: PROTOCOL_VERSION,
                player_id: 17,
                match_id: 0x0123_4567_89ab_cdef,
                tick_rate: 30,
                map: "island".into(),
                seed: 99,
                spawn: [45_000, 210, 33_000],
                yaw: 1,
                server_time: 65_000,
            },
        ),
        (
            "snapshot",
            ServerMsg::Snapshot {
                tick: 901,
                server_time: 30_033,
                ack_seq: 77,
                hp: 88,
                alive: 64,
                entities: vec![
                    EntityState {
                        id: 2,
                        flags: flags::DRIVING,
                        model: 1,
                        pos: [1, -2, 3],
                        yaw: 65_535,
                        pitch: 32_767,
                        roll: -5_000,
                        vel: [-1, 0, 1],
                    },
                    EntityState {
                        id: 300,
                        flags: flags::DEAD,
                        model: 0,
                        pos: [i32::MIN, 0, i32::MAX],
                        yaw: 0,
                        pitch: -32_767,
                        roll: 32_767,
                        vel: [i16::MIN, i16::MAX, 0],
                    },
                ],
                removed: vec![5, 6],
            },
        ),
        (
            "player_joined",
            ServerMsg::PlayerJoined {
                id: 9,
                name: "Ünïcode 🚗".into(),
            },
        ),
        ("player_left", ServerMsg::PlayerLeft { id: 9 }),
        (
            "phase",
            ServerMsg::Phase {
                phase: Phase::Countdown,
                ends_in_ms: 10_000,
            },
        ),
        (
            "zone",
            ServerMsg::Zone(Zone {
                x: -1000,
                z: 2000,
                radius: 120_000,
                target_x: -500,
                target_z: 2500,
                target_radius: 60_000,
                shrink_start_ms: 90_000,
                shrink_end_ms: 150_000,
                dps: 2,
            }),
        ),
        (
            "eliminated",
            ServerMsg::Eliminated {
                victim: 4,
                killer: NO_PLAYER,
                cause: Cause::Zone,
                placement: 37,
            },
        ),
        (
            "match_end",
            ServerMsg::MatchEnd {
                winner: 12,
                placement: 1,
            },
        ),
        (
            "correction",
            ServerMsg::Correction {
                seq: 55,
                epoch: 4,
                pos: [10, 20, 30],
                yaw: 512,
            },
        ),
        (
            "pong",
            ServerMsg::Pong {
                client_time: 1,
                server_time: 2,
            },
        ),
        (
            "room",
            ServerMsg::Room(RoomSettings {
                code: "K7QX2M".into(),
                name: "Asha's world".into(),
                flags: room_flags::PRIVATE | room_flags::ROADKILL | room_flags::PHYSICS,
                max_players: 64,
                owner: 1,
                bots: 24,
            }),
        ),
        (
            "vehicle_state",
            ServerMsg::Vehicle(VehicleState {
                tick: 7_001,
                server_time: 233_366,
                ack: 4_000_000_120,
                pos: [-55_480, 3_611, 119_402],
                rot: [-120, 23_170, 95, 23_170],
                vel: [-35, -12, -1_840],
                angvel: [4, -310, 12],
                gear: -1,
                engine: 5_861,
                omega: [-468, -470, i16::MIN, i16::MAX],
            }),
        ),
        (
            "ropes",
            ServerMsg::Ropes(vec![
                Rope {
                    id: 1,
                    car: 17,
                    end: tow_end::FRONT,
                    kind: rope_kind::FIXED,
                    who: 0,
                    end2: 0,
                    pos: [-55_210, 3_400, 119_870],
                    len: 1_250,
                },
                Rope {
                    id: 2,
                    car: 0x8003,
                    end: tow_end::REAR,
                    kind: rope_kind::CAR,
                    who: 17,
                    end2: tow_end::REAR,
                    pos: [0, 0, 0],
                    len: 2_500,
                },
            ]),
        ),
        (
            "kick",
            ServerMsg::Kick {
                reason: KickReason::Cheating,
                message: "speed".into(),
            },
        ),
    ]
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        write!(s, "{x:02x}").unwrap();
    }
    s
}

#[test]
fn golden_vectors_match() {
    let mut map = serde_json::Map::new();
    for (name, m) in client_samples() {
        map.insert(format!("c.{name}"), hex(&m.to_bytes()).into());
    }
    for (name, m) in server_samples() {
        map.insert(format!("s.{name}"), hex(&m.to_bytes()).into());
    }
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(map)).unwrap() + "\n";
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/golden.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(path, &json).unwrap();
        return;
    }
    let pinned = std::fs::read_to_string(path).expect("golden.json missing — run with UPDATE_GOLDEN=1");
    assert_eq!(
        pinned, json,
        "wire format changed — bump PROTOCOL_VERSION and regenerate golden.json"
    );
}

#[test]
fn every_message_round_trips() {
    for (name, m) in client_samples() {
        assert_eq!(ClientMsg::decode(&m.to_bytes()).unwrap(), m, "{name}");
    }
    for (name, m) in server_samples() {
        assert_eq!(ServerMsg::decode(&m.to_bytes()).unwrap(), m, "{name}");
    }
}

#[test]
fn truncated_or_padded_packets_are_errors_not_panics() {
    let packets: Vec<(bool, Vec<u8>)> = client_samples()
        .into_iter()
        .map(|(_, m)| (true, m.to_bytes()))
        .chain(server_samples().into_iter().map(|(_, m)| (false, m.to_bytes())))
        .collect();
    for (client, p) in packets {
        for cut in 0..p.len() {
            let r = if client {
                ClientMsg::decode(&p[..cut]).map(|_| ())
            } else {
                ServerMsg::decode(&p[..cut]).map(|_| ())
            };
            assert!(r.is_err(), "prefix {cut}/{} decoded", p.len());
        }
        let mut long = p.clone();
        long.push(0);
        let r = if client {
            ClientMsg::decode(&long).map(|_| ())
        } else {
            ServerMsg::decode(&long).map(|_| ())
        };
        assert_eq!(r, Err(DecodeError::Trailing(1)));
    }
    assert_eq!(ClientMsg::decode(&[0x7f]), Err(DecodeError::UnknownKind(0x7f)));
    assert_eq!(ClientMsg::decode(&[]), Err(DecodeError::Empty));
    assert!(ClientMsg::decode(&vec![C_PING; MAX_PACKET + 1]).is_err());
}

#[test]
fn entity_size_is_as_documented() {
    let one = ServerMsg::Snapshot {
        tick: 0,
        server_time: 0,
        ack_seq: 0,
        hp: 0,
        alive: 0,
        entities: vec![EntityState::default()],
        removed: vec![],
    };
    let none = ServerMsg::Snapshot {
        tick: 0,
        server_time: 0,
        ack_seq: 0,
        hp: 0,
        alive: 0,
        entities: vec![],
        removed: vec![],
    };
    assert_eq!(one.to_bytes().len() - none.to_bytes().len(), ENTITY_BYTES);
}
