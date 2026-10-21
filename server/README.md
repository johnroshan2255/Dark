# DARK server

Multiplayer backend for DARK: matchmaking and authoritative **battle-royale matches of up to 100 players** over
WebSocket, written in Rust (tokio + axum).

```
crates/
  protocol/  wire format (binary, little-endian) + golden vectors shared with the TypeScript client
  sim/       match rules — pure, no I/O, no clock: map heights, zone, movement validation, interest, damage
  server/    the binary: HTTP API, WebSocket sessions, matchmaker, one tokio task per match, metrics, drain
  bots/      load tester: N headless players through the whole flow on the real map
deploy/      docker-compose + Caddy (TLS), load-test rules, .env.example
docs/        PROTOCOL.md
```

## Quick start

```sh
cd server
cargo run -p dark-server -- --dev                       # http://localhost:7350, maps from ../game/public/maps
cargo test                                              # unit + golden + end-to-end (real island, two clients)
cargo run --release -p dark-bots -- --bots 100 --secs 60   # load test (start the server with deploy/loadtest.toml)
```

`--dev` uses a random signing secret, allows any web origin and logs for humans. Production refuses to start without
`DARK_SECRET`.

## How it works

**Authority (v1).** The browser keeps simulating its own player and car with the game's Rapier physics. It streams
its pose about 30 times a second.
- **The server validates every pose** against the map's own heightfield and rules: the same bilinear grid as the
  client's `FixedMap.height`, speed caps per mode, a teleport distance, map bounds and no flying. A rejected pose is
  answered with a `Correction`, and repeat offenders are kicked.
- **The server owns everything shared:** the match lifecycle, the shrinking safe zone, health, damage (zone,
  roadkill), eliminations, placement and the winner.
- **Corrections carry an epoch**, so states still in flight from before a correction are ignored, not punished.
- **Fully server-simulated physics is the v2 step:** share the vehicle simulation as Rust → WASM so client and server
  run identical code.

**A match** is one tokio task ticking `dark_sim::Match` at 30 Hz. The pattern is the usual one for authoritative
servers (see e.g. [fairtick](https://github.com/vitaliiermolaev/fairtick)):
- Inputs wait in a bounded queue and are applied only at the tick.
- Each connection has a bounded reliable lane (events, corrections) and a latest-only snapshot slot. A slow client gets
  the newest snapshot, never a backlog; a client whose reliable lane overflows is dropped.
- A panic inside a tick closes that match only.

**Interest management.** Each client gets the players within 900 m, at most 64, nearest first:
- ≤ 150 m every tick (30 Hz)
- ≤ 400 m every 2nd tick
- ≤ 900 m every 6th tick
- out of range: removed

**Matchmaking.** `/v1/matchmake` reserves a seat in the fullest joinable match of the map, filling matches one at a
time, or opens a new one, up to `DARK_MAX_MATCHES` per process.
- **Seats are idempotent:** retrying returns the same seat.
- **Seats lapse** if the player doesn't connect within the ticket lifetime.
- **Matches run lobby → countdown → drop → zone → end:** a full lobby, or 60 s after 2 players, starts a 10 s
  countdown. Then everyone is dropped at spread-out road points (≥ 60 m apart, seeded) and the zone starts closing,
  six stages over about 14 minutes.

**Auth.** Stateless HMAC-SHA256 tokens, so any server of a deployment that shares `DARK_SECRET` can verify them:
- a **session** (`/v1/auth/guest` today; accounts later), sent as `Authorization: Bearer`;
- a short-lived **ticket** for one seat, sent inside the WebSocket `Hello` and never in a URL.

## API

| route | |
|---|---|
| `POST /v1/auth/guest` `{name}` | `{token, player, name, expires_in}` |
| `POST /v1/matchmake` `{map?}` + `Authorization: Bearer <token>` | `{match_id, player_id, ticket, ws_url, map, region, expires_in}` |
| `GET /v1/matches` | running matches: id, map, phase, players, alive |
| `GET /v1/ws` | the game socket — [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| `GET /healthz` · `/readyz` · `/metrics` | liveness · readiness (503 while draining) · Prometheus |

The API is rate-limited per IP (`DARK_HTTP_RATE`/`DARK_HTTP_BURST`) and request bodies are capped at 4 KB.

## Configuration

Every flag has an environment variable (`dark-server --help`).

| env | default | |
|---|---|---|
| `DARK_BIND` | `0.0.0.0:7350` | listen address |
| `DARK_SECRET` | — (required unless `--dev`) | ≥ 32 bytes, shared by all servers of a deployment |
| `DARK_PUBLIC_WS_URL` | from the `Host` header | e.g. `wss://eu1.example.com/v1/ws` |
| `DARK_ALLOWED_ORIGINS` | any (warns) | the game's web origin(s) |
| `DARK_TRUST_PROXY` | false | honour `X-Forwarded-For`/`-Proto` behind a proxy / load balancer |
| `DARK_MAPS_DIR`, `DARK_MAPS` | `../game/public/maps`, `island` | maps hosted (`<id>/map.json`, `heights.bin`) |
| `DARK_MAX_MATCHES` | 8 | concurrent matches per process |
| `DARK_MATCH_CONFIG` | — | TOML overriding match rules (`dark_sim::MatchConfig`: seats, timers, zone stages, limits, interest) |
| `DARK_DRAIN_SECS` | 1200 | on SIGTERM: stop matchmaking, let matches finish this long, then close |
| `DARK_SESSION_TTL` / `DARK_TICKET_TTL` | 86400 / 60 | token lifetimes (s) |
| `DARK_HTTP_RATE` / `DARK_HTTP_BURST` | 2 / 20 | per-IP API rate limit |
| `DARK_LOG_JSON`, `RUST_LOG` | true in prod | structured logs |
| `DARK_REGION` | `local` | label in listings |

Boolean flags accept `true/false/1/0/yes/no`.

## Measured

`dark-bots` against a release build on one Apple M4 laptop (bots and server on the same machine, localhost, so the
RTT figures say nothing about the internet):

| | 100 players, 1 match | 300 players, 3 matches |
|---|---|---|
| snapshots per player | 30.0 / s | 30.0 / s |
| download per player | 9.0 KB/s | 8.8 KB/s |
| average tick (sim + snapshots for all players) | 2.9 ms (9 % of the 33 ms budget) | 2.1 ms per match |
| server CPU (incl. WebSocket I/O) | ~21 % of one core | ~49 % of one core |
| server memory (RSS) | 29 MB | 59 MB |
| poses rejected / kicks / errors | 0 / 0 / 0 | 0 / 0 / 0 |

Server egress is about 0.9 MB/s per 100-player match. Plan on one match per core with headroom on cloud vCPUs, and
measure there (`dark_tick_seconds`, `dark_tick_overruns_total`).

## Operating it

- **Metrics:**
  - `dark_matches_active`, `dark_players_connected`
  - `dark_tick_seconds` (histogram), `dark_tick_overruns_total`
  - `dark_snapshot_bytes_total`, `dark_packets_in_total{kind}`, `dark_packets_dropped_total{why}`
  - `dark_corrections_total{why}` (`reposition` = the drop; `teleport`/`too_fast`/… = rejected poses)
  - `dark_kicks_total{reason}`, `dark_match_panics_total`, `dark_http_rejected_total`
- **Deploy:** `docker build -f server/Dockerfile -t dark-server .` from the repo root. The image is distroless,
  non-root, and has a built-in `HEALTHCHECK` (`dark-server healthcheck`). One region on one machine:
  `deploy/docker-compose.yml` (Caddy terminates TLS and proxies the WebSocket).
- **Scaling out:** run one server per region (or per Edgegap / Agones fleet node) with the same `DARK_SECRET`. Route
  players to a region by latency, then call that region's `/v1/matchmake`. Matches never move between processes.
- **Redeploys:** send SIGTERM. Readiness drops at once, running matches finish (up to `DARK_DRAIN_SECS`), then the
  process exits. The compose file gives it 21 minutes.

## Not in v1 (next steps)

1. **Client integration:** wire `game/src/net/protocol.ts` into the game (net client, remote-player pool,
   interpolation, the zone and the minimap). The codec exists and is tested; the game doesn't connect yet.
2. **Reconnects:** today a disconnect mid-match eliminates the player. A reconnect window with seat re-use is next.
3. **Accounts and persistence:** guests only, with no database. Accounts, stats and leaderboards would go in a
   separate service (Postgres).
4. **WebTransport datagrams:** WebSocket's TCP head-of-line blocking adds latency spikes on lossy mobile networks.
   Behind a gateway, the protocol is transport-agnostic.
5. **Server-run physics (v2):** the vehicle simulation as shared Rust → WASM, then the server simulates instead of
   validating.
6. Weapons and lag-compensated hit validation, once the game has combat.
