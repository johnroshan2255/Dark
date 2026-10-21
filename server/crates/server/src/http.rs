//! HTTP API.
//!
//! | route | |
//! |---|---|
//! | `POST /v1/auth/guest` `{name}` | a guest session token |
//! | `POST /v1/matchmake` `{map?}` (Bearer session) | a seat: match id, player id, join ticket, WebSocket URL |
//! | `GET  /v1/matches` | running matches (public summary) |
//! | `POST /v1/rooms` `{kind, seed?, map?, name?, private?, max_players?, roadkill?, flying?, bots?}` (Bearer) | open a room (you own it) |
//! | `GET  /v1/rooms` | public rooms |
//! | `GET  /v1/rooms/{code}` · `POST /v1/rooms/{code}/join` (Bearer) | a room by code · a seat in it |
//! | `PATCH /v1/rooms/{code}` (owner) · `POST /v1/rooms/{code}/kick {player_id}` (owner) | settings · remove a player |
//! | `GET  /v1/ws` | the game WebSocket (`ws.rs`) |
//! | `GET  /healthz` | process alive |
//! | `GET  /readyz` | accepting players (503 while draining / at capacity) |
//! | `GET  /metrics` | Prometheus |

use crate::App;
use crate::auth::{Session, Ticket, clean_name, random_sub, unix_now};
use crate::metrics as m;
use crate::registry::{MatchmakeError, RoomKind, RoomPatch, RoomSetup, RoomView, Seat};
use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use dark_protocol::room_flags;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct ApiError(StatusCode, &'static str, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1, "message": self.2 }))).into_response()
    }
}

fn err(status: StatusCode, code: &'static str, msg: impl Into<String>) -> ApiError {
    ApiError(status, code, msg.into())
}

/// Per-IP token bucket for the HTTP API (session and seat minting).
pub struct IpLimiter {
    rate: f32,
    burst: f32,
    buckets: Mutex<HashMap<IpAddr, (f32, Instant)>>,
}

impl IpLimiter {
    pub fn new(rate: f32, burst: f32) -> Self {
        Self {
            rate,
            burst,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut b = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if b.len() > 100_000 {
            let (rate, burst) = (self.rate, self.burst);
            b.retain(|_, (t, at)| *t + now.duration_since(*at).as_secs_f32() * rate < burst);
        }
        let e = b.entry(ip).or_insert((self.burst, now));
        e.0 = (e.0 + now.duration_since(e.1).as_secs_f32() * self.rate).min(self.burst);
        e.1 = now;
        if e.0 >= 1.0 {
            e.0 -= 1.0;
            true
        } else {
            false
        }
    }
}

fn client_ip(app: &App, addr: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if app.cfg.trust_proxy
        && let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse().ok())
    {
        return ip;
    }
    addr.ip()
}

fn limited(app: &App, addr: SocketAddr, headers: &HeaderMap) -> Result<(), ApiError> {
    if app.limiter.allow(client_ip(app, addr, headers)) {
        Ok(())
    } else {
        metrics::counter!(m::HTTP_REJECTED, "why" => "rate").increment(1);
        Err(err(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "slow down"))
    }
}

#[derive(Deserialize)]
pub struct GuestReq {
    #[serde(default)]
    name: String,
}

#[derive(Serialize)]
pub struct GuestRes {
    token: String,
    player: String,
    name: String,
    expires_in: u64,
}

pub async fn guest(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<GuestReq>,
) -> Result<Json<GuestRes>, ApiError> {
    limited(&app, addr, &headers)?;
    let sub = random_sub();
    let name = clean_name(&req.name).unwrap_or_else(|| format!("Player{}", &sub[sub.len() - 4..]));
    let exp = unix_now() + app.cfg.session_ttl_s;
    let token = app.signer.session(&Session {
        sub: sub.clone(),
        name: name.clone(),
        exp,
    });
    Ok(Json(GuestRes {
        token,
        player: sub,
        name,
        expires_in: app.cfg.session_ttl_s,
    }))
}

#[derive(Deserialize, Default)]
pub struct MatchmakeReq {
    #[serde(default)]
    map: Option<String>,
}

#[derive(Serialize)]
pub struct MatchmakeRes {
    match_id: String,
    player_id: u16,
    map: String,
    ticket: String,
    ws_url: String,
    region: String,
    expires_in: u64,
}

fn ws_url(app: &App, headers: &HeaderMap) -> String {
    if let Some(u) = &app.cfg.public_ws_url {
        return u.clone();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost:7350");
    let tls = app.cfg.trust_proxy && headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https");
    format!("{}://{host}/v1/ws", if tls { "wss" } else { "ws" })
}

pub async fn matchmake(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<MatchmakeReq>>,
) -> Result<Json<MatchmakeRes>, ApiError> {
    limited(&app, addr, &headers)?;
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized", "missing bearer session"))?;
    let session = app
        .signer
        .verify_session(token, unix_now())
        .map_err(|e| err(StatusCode::UNAUTHORIZED, "unauthorized", e.to_string()))?;
    let req = body.map(|b| b.0).unwrap_or_default();
    let seat = app
        .registry
        .matchmake(&session.sub, req.map.as_deref())
        .map_err(mm_err)?;
    let info = &seat.handle.info;
    let mid = format!("{:016x}", info.id);
    let ticket = app.signer.ticket(&Ticket {
        sub: session.sub,
        name: session.name,
        mid: mid.clone(),
        pid: seat.pid,
        exp: unix_now() + app.cfg.ticket_ttl_s,
    });
    Ok(Json(MatchmakeRes {
        match_id: mid,
        player_id: seat.pid,
        map: info.map.clone(),
        ticket,
        ws_url: ws_url(&app, &headers),
        region: app.cfg.region.clone(),
        expires_in: app.cfg.ticket_ttl_s,
    }))
}

pub async fn matches(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let list: Vec<_> = app
        .registry
        .list()
        .iter()
        .map(|h| {
            let i = &h.info;
            json!({
                "id": format!("{:016x}", i.id),
                "map": i.map,
                "phase": format!("{:?}", i.phase()).to_lowercase(),
                "players": i.players.load(Ordering::Relaxed),
                "alive": i.alive.load(Ordering::Relaxed),
                "max_players": i.max_players.load(Ordering::Relaxed),
                "age_s": i.created.elapsed().as_secs(),
            })
        })
        .collect();
    Json(json!({ "region": app.cfg.region, "accepting": app.registry.accepting(), "matches": list }))
}

pub async fn healthz() -> &'static str {
    "ok"
}

pub async fn readyz(State(app): State<Arc<App>>) -> Response {
    if !app.registry.accepting() {
        return (StatusCode::SERVICE_UNAVAILABLE, "draining").into_response();
    }
    (StatusCode::OK, "ready").into_response()
}

pub async fn metrics(State(app): State<Arc<App>>) -> Response {
    match &app.metrics {
        Some(h) => ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], h.render()).into_response(),
        None => (StatusCode::NOT_FOUND, "metrics disabled").into_response(),
    }
}

// ---------------------------------------------------------------- rooms

fn session(app: &App, headers: &HeaderMap) -> Result<Session, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized", "missing bearer session"))?;
    app.signer
        .verify_session(token, unix_now())
        .map_err(|e| err(StatusCode::UNAUTHORIZED, "unauthorized", e.to_string()))
}

fn mm_err(e: MatchmakeError) -> ApiError {
    let status = match e {
        MatchmakeError::Draining | MatchmakeError::Full => StatusCode::SERVICE_UNAVAILABLE,
        MatchmakeError::UnknownMap | MatchmakeError::NoRoom => StatusCode::NOT_FOUND,
        MatchmakeError::RoomFull => StatusCode::CONFLICT,
        MatchmakeError::Banned | MatchmakeError::NotOwner => StatusCode::FORBIDDEN,
    };
    let code = match e {
        MatchmakeError::Draining => "draining",
        MatchmakeError::Full => "full",
        MatchmakeError::UnknownMap => "unknown_map",
        MatchmakeError::NoRoom => "no_room",
        MatchmakeError::RoomFull => "room_full",
        MatchmakeError::Banned => "banned",
        MatchmakeError::NotOwner => "not_owner",
    };
    err(status, code, e.to_string())
}

/// A room as the API shows it.
#[derive(Serialize)]
pub struct RoomJson {
    code: String,
    name: String,
    /// "world" (the endless world: `seed`) or "map" (`map`).
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    map: Option<String>,
    players: usize,
    max_players: u16,
    private: bool,
    roadkill: bool,
    flying: bool,
    /// Server-run bots in the room.
    bots: u8,
    region: String,
    age_s: u64,
}

fn room_json(app: &App, r: RoomView) -> RoomJson {
    let (kind, seed, map) = match r.kind {
        RoomKind::World { seed } => ("world", Some(seed), None),
        RoomKind::Map { id } => ("map", None, Some(id)),
    };
    let f = r.settings.flags;
    RoomJson {
        code: r.code,
        name: r.settings.name,
        kind,
        seed,
        map,
        players: r.players,
        max_players: r.settings.max_players,
        private: f & room_flags::PRIVATE != 0,
        roadkill: f & room_flags::ROADKILL != 0,
        flying: f & room_flags::FLYING != 0,
        bots: r.settings.bots,
        region: app.cfg.region.clone(),
        age_s: r.age_s,
    }
}

#[derive(Serialize)]
pub struct RoomSeatRes {
    room: RoomJson,
    player_id: u16,
    ticket: String,
    ws_url: String,
    expires_in: u64,
}

fn seat_res(app: &App, headers: &HeaderMap, who: &Session, seat: Seat, view: RoomView) -> RoomSeatRes {
    let mid = format!("{:016x}", seat.handle.info.id);
    let ticket = app.signer.ticket(&Ticket {
        sub: who.sub.clone(),
        name: who.name.clone(),
        mid,
        pid: seat.pid,
        exp: unix_now() + app.cfg.ticket_ttl_s,
    });
    RoomSeatRes {
        room: room_json(app, view),
        player_id: seat.pid,
        ticket,
        ws_url: ws_url(app, headers),
        expires_in: app.cfg.ticket_ttl_s,
    }
}

#[derive(Deserialize)]
pub struct CreateRoomReq {
    /// "world" or "map".
    kind: String,
    #[serde(default)]
    seed: Option<u32>,
    #[serde(default)]
    map: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    max_players: Option<u16>,
    #[serde(default)]
    roadkill: Option<bool>,
    #[serde(default)]
    flying: Option<bool>,
    #[serde(default)]
    bots: Option<u8>,
}

/// Open a room (the caller starts playing and owns it).
pub async fn create_room(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<CreateRoomReq>,
) -> Result<Json<RoomSeatRes>, ApiError> {
    limited(&app, addr, &headers)?;
    let who = session(&app, &headers)?;
    let kind = match req.kind.as_str() {
        "world" => RoomKind::World {
            seed: req
                .seed
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "bad_request", "a world room needs its seed"))?,
        },
        "map" => RoomKind::Map {
            id: req.map.unwrap_or_else(|| app.registry.default_map().to_owned()),
        },
        _ => {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "kind is \"world\" or \"map\"",
            ));
        }
    };
    let name = req
        .name
        .as_deref()
        .and_then(clean_name)
        .unwrap_or_else(|| format!("{}'s room", who.name));
    let setup = RoomSetup {
        kind,
        name,
        private: req.private,
        max_players: req.max_players.unwrap_or(100),
        roadkill: req.roadkill.unwrap_or(false),
        flying: req.flying.unwrap_or(true),
        bots: req.bots.unwrap_or(0),
    };
    let (seat, view) = app.registry.create_room(&who.sub, setup).map_err(mm_err)?;
    Ok(Json(seat_res(&app, &headers, &who, seat, view)))
}

/// Public rooms (fullest first).
pub async fn rooms(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let list: Vec<RoomJson> = app
        .registry
        .public_rooms()
        .into_iter()
        .map(|r| room_json(&app, r))
        .collect();
    Json(json!({ "region": app.cfg.region, "accepting": app.registry.accepting(), "rooms": list }))
}

/// One room by its code (private ones too).
pub async fn room(State(app): State<Arc<App>>, Path(code): Path<String>) -> Result<Json<RoomJson>, ApiError> {
    let r = app.registry.room(&code).ok_or_else(|| mm_err(MatchmakeError::NoRoom))?;
    Ok(Json(room_json(&app, r)))
}

/// A seat in the room with this code.
pub async fn join_room(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<RoomSeatRes>, ApiError> {
    limited(&app, addr, &headers)?;
    let who = session(&app, &headers)?;
    let (seat, view) = app.registry.join_room(&code, &who.sub).map_err(mm_err)?;
    Ok(Json(seat_res(&app, &headers, &who, seat, view)))
}

#[derive(Deserialize, Default)]
pub struct RoomPatchReq {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    private: Option<bool>,
    #[serde(default)]
    max_players: Option<u16>,
    #[serde(default)]
    roadkill: Option<bool>,
    #[serde(default)]
    flying: Option<bool>,
    #[serde(default)]
    bots: Option<u8>,
}

/// The owner changes the room's settings.
pub async fn configure_room(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(code): Path<String>,
    Json(req): Json<RoomPatchReq>,
) -> Result<Json<RoomJson>, ApiError> {
    limited(&app, addr, &headers)?;
    let who = session(&app, &headers)?;
    let name = match req.name {
        Some(n) => Some(clean_name(&n).ok_or_else(|| err(StatusCode::BAD_REQUEST, "bad_request", "empty name"))?),
        None => None,
    };
    let patch = RoomPatch {
        name,
        private: req.private,
        max_players: req.max_players,
        roadkill: req.roadkill,
        flying: req.flying,
        bots: req.bots,
    };
    let view = app.registry.configure(&code, &who.sub, patch).map_err(mm_err)?;
    Ok(Json(room_json(&app, view)))
}

#[derive(Deserialize)]
pub struct KickReq {
    player_id: u16,
}

/// The owner removes a player (they can't rejoin this room).
pub async fn kick(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(code): Path<String>,
    Json(req): Json<KickReq>,
) -> Result<StatusCode, ApiError> {
    limited(&app, addr, &headers)?;
    let who = session(&app, &headers)?;
    app.registry.kick(&code, &who.sub, req.player_id).map_err(mm_err)?;
    Ok(StatusCode::NO_CONTENT)
}
