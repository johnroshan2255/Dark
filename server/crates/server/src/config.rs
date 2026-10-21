//! Configuration: command-line flags, each with an environment variable (12-factor), plus an optional TOML file
//! for match rules. Production refuses to start without a real secret.

use anyhow::{Context, Result, bail};
use clap::builder::BoolishValueParser;
use clap::{ArgAction, Parser};
use dark_sim::MatchConfig;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Parser, Debug, Clone)]
#[command(name = "dark-server", version, about = "DARK multiplayer backend")]
pub struct Config {
    /// Address to listen on (HTTP + WebSocket).
    #[arg(long, env = "DARK_BIND", default_value = "0.0.0.0:7350")]
    pub bind: SocketAddr,

    /// Public WebSocket URL handed to clients (e.g. wss://eu1.example.com/v1/ws). Default: derived from the request's
    /// Host header (ws:// in dev, wss:// behind a TLS proxy when DARK_TRUST_PROXY sets X-Forwarded-Proto).
    #[arg(long, env = "DARK_PUBLIC_WS_URL")]
    pub public_ws_url: Option<String>,

    /// Folder holding the game's maps (<id>/map.json + heights.bin) — game/public/maps in the repo.
    #[arg(long, env = "DARK_MAPS_DIR", default_value = "../game/public/maps")]
    pub maps_dir: PathBuf,

    /// Maps this server hosts (comma separated). The first is the default for matchmaking.
    #[arg(long, env = "DARK_MAPS", value_delimiter = ',', default_value = "island")]
    pub maps: Vec<String>,

    /// HMAC secret for session tokens and join tickets (≥ 32 bytes). Share it between servers of one deployment.
    #[arg(long, env = "DARK_SECRET", hide_env_values = true)]
    pub secret: Option<String>,

    /// Development mode: a random secret if none is set, permissive CORS, human-readable logs by default.
    /// (Boolean flags accept true/false/1/0/yes/no, or the bare flag.)
    #[arg(long, env = "DARK_DEV", default_value_t = false, value_parser = BoolishValueParser::new(), action = ArgAction::Set, num_args = 0..=1, default_missing_value = "true")]
    pub dev: bool,

    /// Browser origins allowed to call the API (comma separated); empty = any (dev only).
    #[arg(long, env = "DARK_ALLOWED_ORIGINS", value_delimiter = ',')]
    pub allowed_origins: Vec<String>,

    /// Trust X-Forwarded-For / X-Forwarded-Proto (set when behind a reverse proxy / load balancer).
    #[arg(long, env = "DARK_TRUST_PROXY", default_value_t = false, value_parser = BoolishValueParser::new(), action = ArgAction::Set, num_args = 0..=1, default_missing_value = "true")]
    pub trust_proxy: bool,

    /// Per-IP rate limit on the HTTP API (guest sessions, matchmaking): requests per second and burst.
    #[arg(long, env = "DARK_HTTP_RATE", default_value_t = 2.0)]
    pub http_rate: f32,
    #[arg(long, env = "DARK_HTTP_BURST", default_value_t = 20.0)]
    pub http_burst: f32,

    /// Most matches this process runs at once (one match ≈ one core at 100 players).
    #[arg(long, env = "DARK_MAX_MATCHES", default_value_t = 8)]
    pub max_matches: usize,

    /// Most player-hosted rooms this process runs at once (free roam: light — a few players each, mostly).
    #[arg(long, env = "DARK_MAX_ROOMS", default_value_t = 400)]
    pub max_rooms: usize,

    /// Optional TOML file overriding match rules (players per match, timers, zone, limits…).
    #[arg(long, env = "DARK_MATCH_CONFIG")]
    pub match_config: Option<PathBuf>,

    /// Session token lifetime (s).
    #[arg(long, env = "DARK_SESSION_TTL", default_value_t = 24 * 3600)]
    pub session_ttl_s: u64,

    /// Join ticket lifetime (s): connect within this after matchmaking.
    #[arg(long, env = "DARK_TICKET_TTL", default_value_t = 60)]
    pub ticket_ttl_s: u64,

    /// On SIGTERM: stop matchmaking at once, then wait up to this long for running matches to finish (s).
    #[arg(long, env = "DARK_DRAIN_SECS", default_value_t = 1200)]
    pub drain_s: u64,

    /// Log as JSON lines (default in production).
    #[arg(long, env = "DARK_LOG_JSON", value_parser = BoolishValueParser::new(), action = ArgAction::Set, num_args = 0..=1, default_missing_value = "true")]
    pub log_json: Option<bool>,

    /// Region label reported by /v1/matches and the metrics (e.g. eu-west).
    #[arg(long, env = "DARK_REGION", default_value = "local")]
    pub region: String,
}

impl Config {
    /// The secret to sign with (a random one in dev mode when unset).
    pub fn secret_bytes(&self) -> Result<Vec<u8>> {
        match &self.secret {
            Some(s) if s.len() >= 32 => Ok(s.as_bytes().to_vec()),
            Some(_) => bail!("DARK_SECRET must be at least 32 bytes"),
            None if self.dev => {
                let mut b = vec![0u8; 32];
                getrandom::fill(&mut b).map_err(|e| anyhow::anyhow!("random secret: {e}"))?;
                Ok(b)
            }
            None => bail!("DARK_SECRET is required (or run with --dev)"),
        }
    }

    pub fn log_json(&self) -> bool {
        self.log_json.unwrap_or(!self.dev)
    }

    /// Match rules: defaults, overridden by the TOML file if given.
    pub fn match_rules(&self) -> Result<MatchConfig> {
        let Some(p) = &self.match_config else {
            return Ok(MatchConfig::default());
        };
        let text = std::fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?;
        let cfg: MatchConfig = toml::from_str(&text).with_context(|| format!("parsing {}", p.display()))?;
        if cfg.max_players == 0
            || cfg.max_players > u16::MAX as usize - 1
            || cfg.min_players == 0
            || cfg.tick_hz == 0
            || cfg.tick_hz > 120
        {
            bail!("{}: max_players 1…65534, min_players ≥ 1, tick_hz 1…120", p.display());
        }
        Ok(cfg)
    }

    /// A config for tests / embedding: dev mode, ephemeral port.
    pub fn for_tests(maps_dir: PathBuf) -> Self {
        Self {
            bind: "127.0.0.1:0".parse().expect("addr"),
            public_ws_url: None,
            maps_dir,
            maps: vec!["island".into()],
            secret: Some("test-secret-test-secret-test-secret!!".into()),
            dev: true,
            allowed_origins: vec![],
            trust_proxy: false,
            max_matches: 4,
            max_rooms: 16,
            http_rate: 100.0,
            http_burst: 100.0,
            match_config: None,
            session_ttl_s: 3600,
            ticket_ttl_s: 60,
            drain_s: 5,
            log_json: Some(false),
            region: "test".into(),
        }
    }
}
