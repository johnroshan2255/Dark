//! `dark-bots` — load-test a DARK server with N headless players.
//!
//!     cargo run --release -p dark-bots -- --url http://127.0.0.1:7350 --bots 100 --secs 120
//!
//! Each bot: guest session → matchmake → WebSocket `Hello` → streams its pose at 30 Hz (walking round the lobby, then
//! driving circles from its road spawn once the match runs, on the map's real terrain height), answers corrections
//! like a client (snaps to them), pings for RTT, and counts what it receives. Every 5 s a summary line; at the end the
//! totals. Run the server with short lobby timers for load tests (`deploy/loadtest.toml`).

use anyhow::{Context, Result};
use clap::Parser;
use dark_protocol::*;
use dark_sim::MapData;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[derive(Parser, Debug, Clone)]
struct Args {
    /// Server base URL.
    #[arg(long, default_value = "http://127.0.0.1:7350")]
    url: String,
    /// Number of bots.
    #[arg(long, default_value_t = 100)]
    bots: usize,
    /// Test length (s).
    #[arg(long, default_value_t = 60)]
    secs: u64,
    /// Bots started per second (ramp).
    #[arg(long, default_value_t = 50)]
    ramp: u32,
    /// Map folder (for terrain heights), like the server's DARK_MAPS_DIR/<map>.
    #[arg(long, default_value = "../game/public/maps/island")]
    map: PathBuf,
}

#[derive(Default)]
struct Stats {
    connected: AtomicU64,
    running: AtomicU64,
    snapshots: AtomicU64,
    bytes_in: AtomicU64,
    entities: AtomicU64,
    corrections: AtomicU64,
    kicks: AtomicU64,
    errors: AtomicU64,
    rtt: std::sync::Mutex<Vec<u32>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let map = Arc::new(MapData::load(&args.map).with_context(|| format!("map {}", args.map.display()))?);
    let stats = Arc::new(Stats::default());
    let http = reqwest::Client::new();
    let end = Instant::now() + Duration::from_secs(args.secs);
    let mut tasks = Vec::new();
    for i in 0..args.bots {
        let (a, map, stats, http) = (args.clone(), map.clone(), stats.clone(), http.clone());
        tasks.push(tokio::spawn(async move {
            if let Err(e) = bot(i, &a, &map, &stats, &http, end).await {
                stats.errors.fetch_add(1, Ordering::Relaxed);
                eprintln!("bot {i}: {e:#}");
            }
        }));
        if args.ramp > 0 {
            tokio::time::sleep(Duration::from_secs_f64(1.0 / args.ramp as f64)).await;
        }
    }
    let t0 = Instant::now();
    let mut last = (0u64, 0u64, Instant::now());
    while Instant::now() < end {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let (s, b) = (
            stats.snapshots.load(Ordering::Relaxed),
            stats.bytes_in.load(Ordering::Relaxed),
        );
        let dt = last.2.elapsed().as_secs_f64();
        let conn = stats.connected.load(Ordering::Relaxed).max(1);
        println!(
            "t={:>4.0}s connected {:>4} running {:>4} | snapshots {:>6.0}/s ({:.1}/s per bot) | down {:>6.1} KB/s per bot | entities/snap {:>5.1} | corrections {} kicks {} errors {}",
            t0.elapsed().as_secs_f64(),
            stats.connected.load(Ordering::Relaxed),
            stats.running.load(Ordering::Relaxed),
            (s - last.0) as f64 / dt,
            (s - last.0) as f64 / dt / conn as f64,
            (b - last.1) as f64 / dt / conn as f64 / 1024.0,
            stats.entities.load(Ordering::Relaxed) as f64 / s.max(1) as f64,
            stats.corrections.load(Ordering::Relaxed),
            stats.kicks.load(Ordering::Relaxed),
            stats.errors.load(Ordering::Relaxed),
        );
        last = (s, b, Instant::now());
    }
    for t in tasks {
        let _ = t.await;
    }
    let mut rtt = stats.rtt.lock().map(|r| r.clone()).unwrap_or_default();
    rtt.sort_unstable();
    let pct = |p: f64| {
        rtt.get(((rtt.len() as f64 - 1.0) * p).round() as usize)
            .copied()
            .unwrap_or(0)
    };
    println!(
        "done: {} bots, {} snapshots, {:.1} MB in, RTT p50 {} ms p99 {} ms, corrections {}, kicks {}, errors {}",
        args.bots,
        stats.snapshots.load(Ordering::Relaxed),
        stats.bytes_in.load(Ordering::Relaxed) as f64 / 1e6,
        pct(0.5),
        pct(0.99),
        stats.corrections.load(Ordering::Relaxed),
        stats.kicks.load(Ordering::Relaxed),
        stats.errors.load(Ordering::Relaxed),
    );
    Ok(())
}

async fn bot(i: usize, args: &Args, map: &MapData, stats: &Stats, http: &reqwest::Client, end: Instant) -> Result<()> {
    let g: Value = http
        .post(format!("{}/v1/auth/guest", args.url))
        .json(&serde_json::json!({ "name": format!("bot{i}") }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let token = g["token"].as_str().context("token")?;
    let seat: Value = http
        .post(format!("{}/v1/matchmake", args.url))
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let (ws, _) = connect_async(seat["ws_url"].as_str().context("ws_url")?).await?;
    let (mut tx, mut rx) = ws.split();
    tx.send(Message::Binary(
        ClientMsg::Hello {
            protocol: PROTOCOL_VERSION,
            ticket: seat["ticket"].as_str().context("ticket")?.into(),
        }
        .to_bytes()
        .into(),
    ))
    .await?;
    stats.connected.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    // pose: centre of the circle we move round, current angle, mode
    let mut centre = [0.0f32, 0.0];
    let mut welcomed = false;
    let mut angle = 0.0f32;
    let mut running = false;
    let mut seq = 0u32;
    let mut epoch = 0u8;
    let mut send_tick = tokio::time::interval(Duration::from_millis(33));
    let mut ping_tick = tokio::time::interval(Duration::from_secs(2));
    let result: Result<()> = async {
        loop {
            if Instant::now() > end {
                tx.send(Message::Binary(ClientMsg::Leave.to_bytes().into())).await.ok();
                return Ok(());
            }
            tokio::select! {
                m = rx.next() => {
                    let Some(m) = m else { return Ok(()) };
                    let Message::Binary(b) = m? else { continue };
                    stats.bytes_in.fetch_add(b.len() as u64, Ordering::Relaxed);
                    match ServerMsg::decode(&b)? {
                        ServerMsg::Welcome { spawn, .. } => {
                            centre = [cm_to_m(spawn[0]), cm_to_m(spawn[2])];
                            welcomed = true;
                        }
                        ServerMsg::Snapshot { entities, .. } => {
                            stats.snapshots.fetch_add(1, Ordering::Relaxed);
                            stats.entities.fetch_add(entities.len() as u64, Ordering::Relaxed);
                        }
                        ServerMsg::Correction { pos, epoch: e, .. } => {
                            epoch = e;
                            stats.corrections.fetch_add(1, Ordering::Relaxed);
                            centre = [cm_to_m(pos[0]), cm_to_m(pos[2])];
                            angle = 0.0;
                        }
                        ServerMsg::Phase { phase: Phase::Running, .. } if !running => {
                            running = true;
                            stats.running.fetch_add(1, Ordering::Relaxed);
                        }
                        ServerMsg::Pong { client_time, .. } => {
                            let now = started.elapsed().as_millis() as u32;
                            if let Ok(mut r) = stats.rtt.lock() {
                                r.push(now.wrapping_sub(client_time));
                            }
                        }
                        ServerMsg::Kick { .. } => {
                            stats.kicks.fetch_add(1, Ordering::Relaxed);
                            return Ok(());
                        }
                        _ => {}
                    }
                }
                _ = send_tick.tick(), if welcomed => {
                    // walk 4 m/s round a 6 m circle in the lobby; drive 18 m/s round a 25 m circle in the match
                    let (r, v, fl) = if running { (25.0, 18.0, flags::DRIVING) } else { (6.0, 4.0, 0) };
                    angle += v / r * 0.033;
                    let x = centre[0] + r * angle.cos() - r;
                    let z = centre[1] + r * angle.sin();
                    let y = map.height(x, z) + 0.6;
                    let vel = [-v * angle.sin(), 0.0, v * angle.cos()];
                    seq += 1;
                    let s = State {
                        seq,
                        client_time: started.elapsed().as_millis() as u32,
                        epoch,
                        flags: fl,
                        model: if running { 1 } else { 0 },
                        pos: [m_to_cm(x), m_to_cm(y), m_to_cm(z)],
                        yaw: yaw_to_u16(angle),
                        pitch: 0,
                        vel: [mps_to_cms(vel[0]), 0, mps_to_cms(vel[2])],
                    };
                    tx.send(Message::Binary(ClientMsg::State(s).to_bytes().into())).await?;
                }
                _ = ping_tick.tick() => {
                    tx.send(Message::Binary(ClientMsg::Ping { client_time: started.elapsed().as_millis() as u32 }.to_bytes().into())).await?;
                }
            }
        }
    }
    .await;
    stats.connected.fetch_sub(1, Ordering::Relaxed);
    result
}
