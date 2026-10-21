//! The game WebSocket (`GET /v1/ws`): binary frames, one packet each (`dark_protocol`).
//!
//! 1. The client sends `Hello { protocol, ticket }` within [`HELLO_TIMEOUT`]; the ticket's signature, expiry, match
//!    and seat are checked, then the match accepts the player and answers `Welcome`.
//! 2. A writer task sends the reliable lane, the latest snapshot, and WebSocket pings; the reader decodes packets,
//!    rate-limits them (token bucket), answers `Ping` with `Pong` itself (no tick latency) and forwards the rest to the
//!    match. Malformed packets, floods and silence ([`IDLE_TIMEOUT`]) end the connection with a `Kick`.

use crate::App;
use crate::auth::unix_now;
use crate::metrics as m;
use crate::runtime::{Cmd, Conn, Outgoing, RELIABLE_DEPTH};
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use bytes::Bytes;
use dark_protocol::{ClientMsg, KickReason, MAX_PACKET, PROTOCOL_VERSION, ServerMsg};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::debug;

pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(20);
const PING_EVERY: Duration = Duration::from_secs(10);
/// Packets per second a client may send on average, and the burst.
const RATE: f32 = 90.0;
const BURST: f32 = 180.0;
/// Malformed packets tolerated before the kick.
const STRIKES: u32 = 8;

pub async fn handler(State(app): State<Arc<App>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_PACKET)
        .max_frame_size(MAX_PACKET)
        .on_upgrade(move |socket| session(app, socket))
}

fn kick_frame(reason: KickReason, why: &str) -> Message {
    Message::Binary(Bytes::from(
        ServerMsg::Kick {
            reason,
            message: why.to_owned(),
        }
        .to_bytes(),
    ))
}

async fn reject(mut socket: WebSocket, reason: KickReason, why: &'static str) {
    metrics::counter!(m::KICKS, "reason" => why).increment(1);
    let _ = socket.send(kick_frame(reason, why)).await;
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 4000 + reason as u16,
            reason: why.into(),
        })))
        .await;
}

struct Bucket {
    tokens: f32,
    at: Instant,
}

impl Bucket {
    fn take(&mut self, now: Instant) -> bool {
        self.tokens = (self.tokens + now.duration_since(self.at).as_secs_f32() * RATE).min(BURST);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

async fn session(app: Arc<App>, mut socket: WebSocket) {
    metrics::counter!(m::WS_CONNECTIONS).increment(1);
    // ---- 1. Hello + ticket
    let first = match tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Binary(b)))) => b,
        Ok(_) => return reject(socket, KickReason::Malformed, "expected hello").await,
        Err(_) => return reject(socket, KickReason::Timeout, "no hello").await,
    };
    let (protocol, ticket) = match ClientMsg::decode(&first) {
        Ok(ClientMsg::Hello { protocol, ticket }) => (protocol, ticket),
        _ => return reject(socket, KickReason::Malformed, "expected hello").await,
    };
    if protocol != PROTOCOL_VERSION {
        return reject(socket, KickReason::VersionMismatch, "protocol version").await;
    }
    let Ok(t) = app.signer.verify_ticket(&ticket, unix_now()) else {
        return reject(socket, KickReason::BadTicket, "bad ticket").await;
    };
    let Some(mid) = u64::from_str_radix(&t.mid, 16).ok() else {
        return reject(socket, KickReason::BadTicket, "bad ticket").await;
    };
    let Some(handle) = app.registry.get(mid) else {
        return reject(socket, KickReason::MatchOver, "match over").await;
    };
    if !app.registry.seat_valid(mid, &t.sub, t.pid) {
        return reject(socket, KickReason::BadTicket, "seat lapsed").await;
    }
    let pid = t.pid;
    let (tx, mut rx) = mpsc::channel::<Outgoing>(RELIABLE_DEPTH);
    let (snap_tx, mut snap_rx) = watch::channel(Bytes::new());
    let (reply_tx, reply_rx) = oneshot::channel();
    if handle
        .tx
        .send(Cmd::Join {
            pid,
            name: t.name.clone(),
            conn: Conn {
                tx: tx.clone(),
                snap: snap_tx,
            },
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return reject(socket, KickReason::MatchOver, "match over").await;
    }
    let welcome = match reply_rx.await {
        Ok(Ok(w)) => w,
        Ok(Err(reason)) => return reject(socket, reason, "cannot join").await,
        Err(_) => return reject(socket, KickReason::MatchOver, "match over").await,
    };
    if socket.send(Message::Binary(welcome)).await.is_err() {
        let _ = handle.tx.send(Cmd::Leave { pid }).await;
        return;
    }
    debug!(match_id = %t.mid, player = pid, name = %t.name, "joined");

    // ---- 2. writer task
    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                biased;
                o = rx.recv() => match o {
                    Some(Outgoing::Packet(b)) => if sink.send(Message::Binary(b)).await.is_err() { break },
                    Some(Outgoing::Close(reason, why)) => {
                        let _ = sink.send(kick_frame(reason, why)).await;
                        let _ = sink.send(Message::Close(Some(CloseFrame { code: 4000 + reason as u16, reason: why.into() }))).await;
                        break;
                    }
                    None => break,
                },
                c = snap_rx.changed() => {
                    if c.is_err() { break }
                    let b = snap_rx.borrow_and_update().clone();
                    if !b.is_empty() && sink.send(Message::Binary(b)).await.is_err() { break }
                }
                _ = ping.tick() => if sink.send(Message::Ping(Bytes::new())).await.is_err() { break },
            }
        }
        let _ = sink.close().await;
    });

    // ---- 3. reader
    let mut bucket = Bucket {
        tokens: BURST,
        at: Instant::now(),
    };
    let mut strikes = 0u32;
    let mut dropped_since = None::<Instant>;
    let kick = |reason: KickReason, why: &'static str| {
        metrics::counter!(m::KICKS, "reason" => why).increment(1);
        let _ = tx.try_send(Outgoing::Close(reason, why));
    };
    loop {
        let next = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
            Err(_) => {
                kick(KickReason::Timeout, "idle");
                break;
            }
            Ok(None) | Ok(Some(Err(_))) => break,
            Ok(Some(Ok(msg))) => msg,
        };
        let data = match next {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Text(_) => {
                strikes += 1;
                if strikes > STRIKES {
                    kick(KickReason::Malformed, "malformed");
                    break;
                }
                continue;
            }
        };
        let now = Instant::now();
        if !bucket.take(now) {
            metrics::counter!(m::PACKETS_DROPPED, "why" => "rate").increment(1);
            // flooding for 2 s straight: out
            if dropped_since.get_or_insert(now).elapsed() > Duration::from_secs(2) {
                kick(KickReason::Flooding, "flooding");
                break;
            }
            continue;
        }
        dropped_since = None;
        let msg = match ClientMsg::decode(&data) {
            Ok(msg) => msg,
            Err(_) => {
                strikes += 1;
                if strikes > STRIKES {
                    kick(KickReason::Malformed, "malformed");
                    break;
                }
                continue;
            }
        };
        let kind = match &msg {
            ClientMsg::State(_) => "state",
            ClientMsg::Ping { .. } => "ping",
            ClientMsg::Action { .. } => "action",
            ClientMsg::Leave => "leave",
            ClientMsg::Hello { .. } => "hello",
        };
        metrics::counter!(m::PACKETS_IN, "kind" => kind).increment(1);
        match msg {
            ClientMsg::Ping { client_time } => {
                let pong = ServerMsg::Pong {
                    client_time,
                    server_time: handle.server_time(),
                };
                let _ = tx.try_send(Outgoing::Packet(Bytes::from(pong.to_bytes())));
            }
            ClientMsg::Hello { .. } => {}
            ClientMsg::Leave => break,
            msg => {
                // a full match queue sheds states (the next one supersedes them), never blocks the reader
                if handle.tx.try_send(Cmd::Msg { pid, msg }).is_err() {
                    metrics::counter!(m::PACKETS_DROPPED, "why" => "queue").increment(1);
                }
            }
        }
    }
    let _ = handle.tx.send(Cmd::Leave { pid }).await;
    drop(tx);
    // let the writer flush a kick, then stop it
    if tokio::time::timeout(Duration::from_secs(2), writer).await.is_err() {
        debug!(player = pid, "writer did not finish");
    }
    debug!(match_id = %t.mid, player = pid, "left");
}
