//! DARK multiplayer backend — the imperative shell round `dark_sim` (see the README for the architecture).

pub mod auth;
pub mod config;
pub mod http;
pub mod metrics;
pub mod registry;
pub mod runtime;
pub mod ws;

use anyhow::{Context, Result};
use axum::Router;
use axum::http::{HeaderValue, Method, header};
use axum::routing::{get, post};
use config::Config;
use dark_sim::{MapData, MatchConfig};
use metrics_exporter_prometheus::PrometheusHandle;
use registry::Registry;
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

pub struct App {
    pub cfg: Config,
    pub signer: auth::Signer,
    pub registry: Arc<Registry>,
    pub metrics: Option<PrometheusHandle>,
    pub limiter: http::IpLimiter,
}

/// Load the configured maps (fails fast on a missing / broken map).
pub fn load_maps(cfg: &Config) -> Result<HashMap<String, Arc<MapData>>> {
    let mut maps = HashMap::new();
    for id in &cfg.maps {
        let dir = cfg.maps_dir.join(id);
        let m = MapData::load(&dir).with_context(|| format!("map {id} ({})", dir.display()))?;
        info!(map = %id, roads = m.road_point_count(), half = m.half, "map loaded");
        maps.insert(id.clone(), Arc::new(m));
    }
    Ok(maps)
}

pub fn router(app: Arc<App>) -> Router {
    let cors = if app.cfg.allowed_origins.is_empty() {
        CorsLayer::new().allow_origin(AllowOrigin::any())
    } else {
        let origins: Vec<HeaderValue> = app.cfg.allowed_origins.iter().filter_map(|o| o.parse().ok()).collect();
        CorsLayer::new().allow_origin(origins)
    }
    .allow_methods([Method::GET, Method::POST])
    .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);
    Router::new()
        .route("/v1/auth/guest", post(http::guest))
        .route("/v1/matchmake", post(http::matchmake))
        .route("/v1/matches", get(http::matches))
        .route("/v1/ws", get(ws::handler))
        .route("/healthz", get(http::healthz))
        .route("/readyz", get(http::readyz))
        .route("/metrics", get(http::metrics))
        .layer(RequestBodyLimitLayer::new(4 * 1024))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(app)
}

/// Run the server on `listener` until `shutdown` resolves, then DRAIN: stop matchmaking (readyz → 503), let running
/// matches finish for up to `drain_s`, close the rest, stop.
pub async fn serve(
    cfg: Config,
    rules: Option<MatchConfig>,
    listener: TcpListener,
    metrics: Option<PrometheusHandle>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    if !cfg.dev && cfg.allowed_origins.is_empty() {
        warn!("DARK_ALLOWED_ORIGINS is empty: any website may call this API");
    }
    let maps = load_maps(&cfg)?;
    let rules = match rules {
        Some(r) => r,
        None => cfg.match_rules()?,
    };
    let default_map = cfg.maps.first().cloned().context("no maps configured")?;
    let registry = Registry::new(
        maps,
        default_map,
        rules,
        cfg.max_matches,
        Duration::from_secs(cfg.ticket_ttl_s + 5),
    );
    let signer = auth::Signer::new(cfg.secret_bytes()?);
    let drain = Duration::from_secs(cfg.drain_s);
    let (cfg_rate, cfg_burst) = (cfg.http_rate, cfg.http_burst);
    let app = Arc::new(App {
        cfg,
        signer,
        registry: registry.clone(),
        metrics,
        limiter: http::IpLimiter::new(cfg_rate, cfg_burst),
    });
    info!(addr = %listener.local_addr()?, region = %app.cfg.region, "listening");
    let (stop_http_tx, stop_http_rx) = tokio::sync::oneshot::channel::<()>();
    let reg = registry.clone();
    tokio::spawn(async move {
        shutdown.await;
        info!(matches = reg.count(), "draining: no new seats");
        reg.begin_drain();
        let deadline = Instant::now() + drain;
        while reg.count() > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if reg.count() > 0 {
            warn!(matches = reg.count(), "drain deadline: closing running matches");
            reg.shutdown_all().await;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let _ = stop_http_tx.send(());
    });
    axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = stop_http_rx.await;
    })
    .await?;
    info!("stopped");
    Ok(())
}
