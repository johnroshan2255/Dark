//! HTTP API.
//!
//! | route | |
//! |---|---|
//! | `POST /v1/auth/guest` `{name}` | a guest session token |
//! | `POST /v1/matchmake` `{map?}` (Bearer session) | a seat: match id, player id, join ticket, WebSocket URL |
//! | `GET  /v1/matches` | running matches (public summary) |
//! | `GET  /v1/ws` | the game WebSocket (`ws.rs`) |
//! | `GET  /healthz` | process alive |
//! | `GET  /readyz` | accepting players (503 while draining / at capacity) |
//! | `GET  /metrics` | Prometheus |

use crate::App;
use crate::auth::{Session, Ticket, clean_name, random_sub, unix_now};
use crate::metrics as m;
use crate::registry::MatchmakeError;
use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
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
        .map_err(|e| match e {
            MatchmakeError::Draining => err(StatusCode::SERVICE_UNAVAILABLE, "draining", e.to_string()),
            MatchmakeError::Full => err(StatusCode::SERVICE_UNAVAILABLE, "full", e.to_string()),
            MatchmakeError::UnknownMap => err(StatusCode::NOT_FOUND, "unknown_map", e.to_string()),
        })?;
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
                "max_players": i.max_players,
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
