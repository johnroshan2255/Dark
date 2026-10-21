//! End to end: the real server (HTTP + WebSocket) on an ephemeral port, the real island map, two clients.

use dark_protocol::*;
use dark_server::config::Config;
use dark_sim::MatchConfig;
use dark_sim::zone::Stage;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn maps_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../game/public/maps")
}

async fn start() -> (String, tokio::sync::oneshot::Sender<()>) {
    let rules = MatchConfig {
        min_players: 2,
        lobby_s: 0.3,
        countdown_s: 0.3,
        end_linger_s: 0.5,
        zone: vec![Stage {
            wait_s: 600.0,
            shrink_s: 60.0,
            radius_factor: 0.5,
            dps: 1.0,
        }],
        interest: dark_sim::interest::InterestConfig {
            near_m: 5000.0,
            mid_m: 5000.0,
            far_m: 5000.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        dark_server::serve(Config::for_tests(maps_dir()), Some(rules), listener, None, async move {
            let _ = rx.await;
        })
        .await
        .unwrap();
    });
    (format!("http://{addr}"), tx)
}

async fn guest(http: &reqwest::Client, base: &str, name: &str) -> String {
    let g: Value = http
        .post(format!("{base}/v1/auth/guest"))
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    g["token"].as_str().unwrap().to_owned()
}

async fn seat(http: &reqwest::Client, base: &str, token: &str) -> Value {
    let r = http
        .post(format!("{base}/v1/matchmake"))
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success(), "{}", r.status());
    r.json().await.unwrap()
}

async fn guest_and_seat(http: &reqwest::Client, base: &str, name: &str) -> Value {
    let token = guest(http, base, name).await;
    seat(http, base, &token).await
}

async fn send(ws: &mut Ws, m: ClientMsg) {
    ws.send(Message::Binary(m.to_bytes().into())).await.unwrap();
}

/// Next server packet (skipping WebSocket pings) within `secs`.
async fn recv(ws: &mut Ws, secs: u64) -> Option<ServerMsg> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let m = tokio::time::timeout_at(deadline, ws.next()).await.ok()??.ok()?;
        if let Message::Binary(b) = m {
            return Some(ServerMsg::decode(&b).expect("server packets decode"));
        }
    }
}

/// Packets until `pred` matches (or the time runs out).
async fn until(ws: &mut Ws, secs: u64, mut pred: impl FnMut(&ServerMsg) -> bool) -> Option<ServerMsg> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while tokio::time::Instant::now() < deadline {
        match recv(ws, 1).await {
            Some(m) if pred(&m) => return Some(m),
            _ => {}
        }
    }
    None
}

async fn join(seat: &Value) -> (Ws, u16, [i32; 3]) {
    let (mut ws, _) = connect_async(seat["ws_url"].as_str().unwrap()).await.unwrap();
    send(
        &mut ws,
        ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            ticket: seat["ticket"].as_str().unwrap().into(),
        },
    )
    .await;
    match recv(&mut ws, 5).await {
        Some(ServerMsg::Welcome {
            player_id, map, spawn, ..
        }) => {
            assert_eq!(map, "island");
            (ws, player_id, spawn)
        }
        other => panic!("expected Welcome, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_players_play_a_match() {
    let (base, stop) = start().await;
    let http = reqwest::Client::new();
    assert_eq!(
        http.get(format!("{base}/healthz"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ok"
    );
    assert_eq!(http.get(format!("{base}/readyz")).send().await.unwrap().status(), 200);

    let alice = guest(&http, &base, "Alice").await;
    let a = seat(&http, &base, &alice).await;
    let b = guest_and_seat(&http, &base, "Bob").await;
    assert_eq!(a["match_id"], b["match_id"], "both seated in one match");
    assert_ne!(a["player_id"], b["player_id"]);
    // retrying matchmaking gives the same seat back (idempotent)
    let again = seat(&http, &base, &alice).await;
    assert_eq!(
        (&again["match_id"], &again["player_id"]),
        (&a["match_id"], &a["player_id"])
    );

    let (mut wa, ida, spawn_a) = join(&a).await;
    let (mut wb, idb, _) = join(&b).await;
    assert_ne!(ida, idb);

    // A learns of B; the lobby → countdown → running; A is moved to a road spawn
    assert!(
        until(
            &mut wa,
            5,
            |m| matches!(m, ServerMsg::PlayerJoined { id, .. } if *id == idb)
        )
        .await
        .is_some()
    );
    let corr = until(&mut wa, 8, |m| matches!(m, ServerMsg::Correction { .. }))
        .await
        .expect("drop to spawn");
    let ServerMsg::Correction { pos, epoch, .. } = corr else {
        unreachable!()
    };
    assert_ne!(pos, spawn_a, "moved from the lobby to a road");
    assert!(
        until(&mut wa, 5, |m| matches!(
            m,
            ServerMsg::Phase {
                phase: Phase::Running,
                ..
            }
        ))
        .await
        .is_some()
    );

    // A streams its pose at the spawn; B sees A in its snapshots
    for seq in 1..=10u32 {
        send(
            &mut wa,
            ClientMsg::State(State {
                seq,
                epoch,
                pos,
                ..Default::default()
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
    let snap = until(
        &mut wb,
        5,
        |m| matches!(m, ServerMsg::Snapshot { entities, .. } if entities.iter().any(|e| e.id == ida)),
    )
    .await;
    assert!(snap.is_some(), "B sees A");
    // A's own snapshots ack its states
    let ack = until(
        &mut wa,
        5,
        |m| matches!(m, ServerMsg::Snapshot { ack_seq, .. } if *ack_seq >= 5),
    )
    .await;
    assert!(ack.is_some());
    // a teleport is corrected
    send(
        &mut wa,
        ClientMsg::State(State {
            seq: 11,
            epoch,
            pos: [pos[0] + 50_000, pos[1], pos[2]],
            ..Default::default()
        }),
    )
    .await;
    assert!(
        until(&mut wa, 3, |m| matches!(m, ServerMsg::Correction { seq: 11, .. }))
            .await
            .is_some()
    );
    // RTT probe
    send(&mut wa, ClientMsg::Ping { client_time: 1234 }).await;
    assert!(
        until(&mut wa, 3, |m| matches!(m, ServerMsg::Pong { client_time: 1234, .. }))
            .await
            .is_some()
    );

    // B quits mid-match: eliminated (disconnect) → A wins
    wb.close(None).await.unwrap();
    let elim = until(
        &mut wa,
        5,
        |m| matches!(m, ServerMsg::Eliminated { victim, .. } if *victim == idb),
    )
    .await;
    assert!(matches!(
        elim,
        Some(ServerMsg::Eliminated {
            cause: Cause::Disconnect,
            placement: 2,
            ..
        })
    ));
    let end = until(&mut wa, 5, |m| matches!(m, ServerMsg::MatchEnd { .. })).await;
    assert_eq!(
        end,
        Some(ServerMsg::MatchEnd {
            winner: ida,
            placement: 1
        })
    );
    // the match closes after the linger: A is told
    let kick = until(&mut wa, 5, |m| matches!(m, ServerMsg::Kick { .. })).await;
    assert!(matches!(
        kick,
        Some(ServerMsg::Kick {
            reason: KickReason::MatchOver,
            ..
        })
    ));
    let _ = stop.send(());
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_tickets_and_versions_are_refused() {
    let (base, stop) = start().await;
    let http = reqwest::Client::new();
    let seat = guest_and_seat(&http, &base, "Eve").await;
    let url = seat["ws_url"].as_str().unwrap();

    let (mut ws, _) = connect_async(url).await.unwrap();
    send(
        &mut ws,
        ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            ticket: "forged.ticket".into(),
        },
    )
    .await;
    assert!(matches!(
        recv(&mut ws, 3).await,
        Some(ServerMsg::Kick {
            reason: KickReason::BadTicket,
            ..
        })
    ));

    let (mut ws, _) = connect_async(url).await.unwrap();
    send(
        &mut ws,
        ClientMsg::Hello {
            protocol: PROTOCOL_VERSION + 1,
            ticket: seat["ticket"].as_str().unwrap().into(),
        },
    )
    .await;
    assert!(matches!(
        recv(&mut ws, 3).await,
        Some(ServerMsg::Kick {
            reason: KickReason::VersionMismatch,
            ..
        })
    ));

    // no session → 401; unknown map → 404
    let r = http.post(format!("{base}/v1/matchmake")).send().await.unwrap();
    assert_eq!(r.status(), 401);
    let g: Value = http
        .post(format!("{base}/v1/auth/guest"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(g["name"].as_str().unwrap().starts_with("Player"));
    let r = http
        .post(format!("{base}/v1/matchmake"))
        .bearer_auth(g["token"].as_str().unwrap())
        .json(&serde_json::json!({ "map": "nowhere" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let list: Value = http
        .get(format!("{base}/v1/matches"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["accepting"], true);
    assert_eq!(list["matches"].as_array().unwrap().len(), 1);
    let _ = stop.send(());
}

async fn post(http: &reqwest::Client, url: String, token: &str, body: Value) -> reqwest::Response {
    http.post(url).bearer_auth(token).json(&body).send().await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn rooms_list_join_configure_and_kick() {
    let (base, stop) = start().await;
    let http = reqwest::Client::new();
    let asha = guest(&http, &base, "Asha").await;
    let ben = guest(&http, &base, "Ben").await;

    // Asha starts playing the endless world (seed 4242): a public room opens with her settings
    let r = post(
        &http,
        format!("{base}/v1/rooms"),
        &asha,
        serde_json::json!({ "kind": "world", "seed": 4242, "max_players": 8, "roadkill": true }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let a: Value = r.json().await.unwrap();
    let code = a["room"]["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 6);
    assert_eq!(a["room"]["name"], "Asha's room");
    assert_eq!(
        (a["room"]["kind"].as_str(), a["room"]["seed"].as_u64()),
        (Some("world"), Some(4242))
    );
    let (mut wa, ida, spawn_a) = join_room_ws(&a).await;
    assert_eq!(
        spawn_a[1], NO_SPAWN,
        "the owner of an endless world picks her own spawn"
    );
    let room = until(&mut wa, 3, |m| matches!(m, ServerMsg::Room(_))).await;
    assert!(matches!(room, Some(ServerMsg::Room(RoomSettings { owner, max_players: 8, .. })) if owner == ida));
    // she streams a pose
    for seq in 1..=5u32 {
        send(
            &mut wa,
            ClientMsg::State(State {
                seq,
                pos: [10_000, 5_000, -2_000],
                ..Default::default()
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    // Ben sees it in the public list and joins by its code
    let list: Value = http
        .get(format!("{base}/v1/rooms"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let listed = list["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["code"] == code.as_str())
        .cloned()
        .expect("listed");
    assert_eq!(listed["players"], 1);
    let b: Value = post(
        &http,
        format!("{base}/v1/rooms/{}/join", code.to_lowercase()),
        &ben,
        serde_json::json!({}),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(b["room"]["code"], code.as_str());
    let (mut wb, idb, spawn_b) = join_room_ws(&b).await;
    let d = (((spawn_b[0] - 10_000) as f64).powi(2) + ((spawn_b[2] + 2_000) as f64).powi(2)).sqrt();
    assert!(d < 600.0, "Ben starts beside Asha ({d} cm)");
    // Ben settles and streams; each sees the other
    for seq in 1..=5u32 {
        send(
            &mut wb,
            ClientMsg::State(State {
                seq,
                pos: [spawn_b[0], 5_000, spawn_b[2]],
                ..Default::default()
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    assert!(
        until(
            &mut wb,
            3,
            |m| matches!(m, ServerMsg::Snapshot { entities, .. } if entities.iter().any(|e| e.id == ida))
        )
        .await
        .is_some()
    );
    assert!(
        until(
            &mut wa,
            3,
            |m| matches!(m, ServerMsg::Snapshot { entities, .. } if entities.iter().any(|e| e.id == idb))
        )
        .await
        .is_some()
    );

    // only the owner configures: Ben can't, Asha makes it private and smaller — Ben is told, the list hides it
    let r = http
        .patch(format!("{base}/v1/rooms/{code}"))
        .bearer_auth(&ben)
        .json(&serde_json::json!({ "private": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = http
        .patch(format!("{base}/v1/rooms/{code}"))
        .bearer_auth(&asha)
        .json(&serde_json::json!({ "private": true, "name": "Night drive", "max_players": 4 }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let got = until(
        &mut wb,
        3,
        |m| matches!(m, ServerMsg::Room(r) if r.name == "Night drive"),
    )
    .await;
    assert!(
        matches!(got, Some(ServerMsg::Room(RoomSettings { flags, max_players: 4, .. })) if flags & room_flags::PRIVATE != 0)
    );
    let list: Value = http
        .get(format!("{base}/v1/rooms"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        list["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["code"] != code.as_str()),
        "private rooms aren't listed"
    );
    let byc: Value = http
        .get(format!("{base}/v1/rooms/{code}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(byc["private"], true, "but the code still finds it");

    // Asha removes Ben: he's kicked and can't come back
    let r = post(
        &http,
        format!("{base}/v1/rooms/{code}/kick"),
        &asha,
        serde_json::json!({ "player_id": idb }),
    )
    .await;
    assert_eq!(r.status(), 204);
    assert!(matches!(
        until(&mut wb, 3, |m| matches!(m, ServerMsg::Kick { .. })).await,
        Some(ServerMsg::Kick {
            reason: KickReason::Kicked,
            ..
        })
    ));
    let r = post(
        &http,
        format!("{base}/v1/rooms/{code}/join"),
        &ben,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(r.status(), 403);
    assert!(
        until(&mut wa, 3, |m| matches!(m, ServerMsg::PlayerLeft { id } if *id == idb))
            .await
            .is_some()
    );

    // a map room: spawns on the map; a wrong code is 404
    let m: Value = post(
        &http,
        format!("{base}/v1/rooms"),
        &ben,
        serde_json::json!({ "kind": "map", "map": "island" }),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(m["room"]["map"], "island");
    let r = post(
        &http,
        format!("{base}/v1/rooms/ZZZZZZ/join"),
        &asha,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(r.status(), 404);
    let _ = stop.send(());
}

async fn join_room_ws(seat: &Value) -> (Ws, u16, [i32; 3]) {
    let (mut ws, _) = connect_async(seat["ws_url"].as_str().unwrap()).await.unwrap();
    send(
        &mut ws,
        ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            ticket: seat["ticket"].as_str().unwrap().into(),
        },
    )
    .await;
    match recv(&mut ws, 5).await {
        Some(ServerMsg::Welcome { player_id, spawn, .. }) => (ws, player_id, spawn),
        other => panic!("expected Welcome, got {other:?}"),
    }
}
