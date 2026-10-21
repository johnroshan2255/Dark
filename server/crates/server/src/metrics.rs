//! Prometheus metrics (`GET /metrics`). Names are constants so dashboards and code agree.

use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};

pub const MATCHES_ACTIVE: &str = "dark_matches_active";
pub const MATCHES_STARTED: &str = "dark_matches_started_total";
pub const MATCHES_FINISHED: &str = "dark_matches_finished_total";
pub const MATCH_PANICS: &str = "dark_match_panics_total";
pub const PLAYERS_CONNECTED: &str = "dark_players_connected";
pub const BOTS_ACTIVE: &str = "dark_bots_active";
pub const TICK_SECONDS: &str = "dark_tick_seconds";
pub const TICK_OVERRUNS: &str = "dark_tick_overruns_total";
pub const SNAPSHOT_BYTES: &str = "dark_snapshot_bytes_total";
pub const PACKETS_IN: &str = "dark_packets_in_total";
pub const PACKETS_DROPPED: &str = "dark_packets_dropped_total";
pub const CORRECTIONS: &str = "dark_corrections_total";
pub const KICKS: &str = "dark_kicks_total";
pub const WS_CONNECTIONS: &str = "dark_ws_connections_total";
pub const HTTP_REJECTED: &str = "dark_http_rejected_total";

/// Install the global recorder; the handle renders the text format.
pub fn install() -> anyhow::Result<PrometheusHandle> {
    let h = PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Full(TICK_SECONDS.into()),
            &[0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.033, 0.066],
        )?
        .install_recorder()?;
    metrics::describe_gauge!(MATCHES_ACTIVE, "Matches running in this process");
    metrics::describe_gauge!(PLAYERS_CONNECTED, "Players connected to a match");
    metrics::describe_gauge!(BOTS_ACTIVE, "Server-run bots playing in rooms");
    metrics::describe_histogram!(
        TICK_SECONDS,
        metrics::Unit::Seconds,
        "Duration of one match tick (simulation + snapshots)"
    );
    metrics::describe_counter!(TICK_OVERRUNS, "Ticks that took longer than the tick period");
    metrics::describe_counter!(
        SNAPSHOT_BYTES,
        metrics::Unit::Bytes,
        "Snapshot bytes handed to connections"
    );
    metrics::describe_counter!(PACKETS_IN, "Client packets received, by kind");
    metrics::describe_counter!(
        PACKETS_DROPPED,
        "Client packets dropped (rate limit, full queue), by why"
    );
    metrics::describe_counter!(CORRECTIONS, "Client poses rejected by movement validation");
    metrics::describe_counter!(KICKS, "Clients disconnected by the server, by reason");
    metrics::describe_counter!(MATCH_PANICS, "Matches closed by a panic in their tick");
    Ok(h)
}
