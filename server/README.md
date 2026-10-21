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

**Rooms.** What the game uses: every game a player starts opens a free-roam room they own (an endless world by seed,
or a map), public or private, up to `DARK_MAX_ROOMS` per process.
- **Join any time** by a 6-character code (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), or from `GET /v1/rooms` (public rooms
  with at least one player). Joiners spawn near the owner.
- **The owner configures it** (`PATCH`: name, private, max players 1–100, roadkill, flying), and can remove players
  (banned from that room). When the owner leaves, the longest-present player becomes owner.
- **Empty rooms close** after 2 minutes (so the owner can reload into another world without losing it).

**Bots.** A room can have up to 100 server-run bots (`bots` in its settings): players with ids from `BOT_ID_BASE`
(0xC000), in the roster and the snapshots like anyone, but simulated by the match (`sim/src/bots.rs`, kinematic). Each
has a personality and picks activities the way a person plays: cruising the roads (lane keeping, IDM car-following,
overtaking, junction choices, U-turns), races (the organiser gathers 3–6 at a start line, counts down, they race a
route), convoys behind another bot or a player, exploring cross-country (and respawning when stuck), boating
(into the water at a shore crossing, round open water, out again), flying (rooms with flying), strolling on foot,
hanging out with a player, AFK. Maps: a road graph and a water grid from `map.json` / `heights.bin` (`sim/src/nav.rs`,
built once per map — water in the snow is ICE there, from `biome.bin`: bots drive on it, no boats); endless world: the game's main road and river ported bit-exactly (`sim/src/noise.rs`, pinned by
`tests/world_golden.json`). Bots far from every human update at a quarter rate and are recycled near them.
Cost (`cargo test --release -p dark-sim bench_room -- --ignored --nocapture`): 100 players + 100 bots all in one
place, **0.54 ms per tick** (step 67 µs + snapshots 468 µs; was 1.10 ms before the snapshot work below), 34 KB/s per
player. Snapshots reuse their buffers, the per-player sets use a fast integer hasher, only the nearest
`interest.near_cap` (24) go every tick inside `near_m`, and the nearest `max_entities` are partitioned before sorting.

**Auth.** Stateless HMAC-SHA256 tokens, so any server of a deployment that shares `DARK_SECRET` can verify them:
- a **session** (`/v1/auth/guest` today; accounts later), sent as `Authorization: Bearer`;
- a short-lived **ticket** for one seat, sent inside the WebSocket `Hello` and never in a URL.

## API

| route | |
|---|---|
| `POST /v1/auth/guest` `{name}` | `{token, player, name, expires_in}` |
| `POST /v1/matchmake` `{map?}` + `Authorization: Bearer <token>` | `{match_id, player_id, ticket, ws_url, map, region, expires_in}` |
| `GET /v1/matches` | running matches: id, map, phase, players, alive |
| `POST /v1/rooms` `{kind: "world"\|"map", seed?, map?, name?, private?, max_players?, roadkill?, flying?, bots?}` + Bearer | create a room you own → `{room, player_id, ticket, ws_url, …}` |
| `GET /v1/rooms` · `GET /v1/rooms/{code}` | public rooms · one room (also private, by code): `{code, name, kind, seed?, map?, players, max_players, private, roadkill, flying, bots, region, age_s}` |
| `POST /v1/rooms/{code}/join` + Bearer | a seat in that room (409 `room_full`, 404 `no_room`, 403 `banned`) |
| `PATCH /v1/rooms/{code}` `{name?, private?, max_players?, roadkill?, flying?, bots?}` + Bearer | owner only (403 `not_owner`) → the room |
| `POST /v1/rooms/{code}/kick` `{player_id}` + Bearer | owner only → 204 |
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
| `DARK_MAX_ROOMS` | 400 | concurrent rooms per process |
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
  - `dark_matches_active`, `dark_players_connected`, `dark_bots_active`
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

1. **Battle royale in the game:** rooms are wired (`game/src/net/`); the BR mode still needs its menu entry, the
   zone in the HUD / minimap and spectating.
2. **Reconnects:** today a disconnect mid-match eliminates the player. A reconnect window with seat re-use is next.
3. **Accounts and persistence:** guests only, with no database. Accounts, stats and leaderboards would go in a
   separate service (Postgres).
4. **WebTransport datagrams:** WebSocket's TCP head-of-line blocking adds latency spikes on lossy mobile networks.
   Behind a gateway, the protocol is transport-agnostic.
5. **Server-run physics (v2):** the vehicle simulation as shared Rust → WASM, then the server simulates instead of
   validating.
6. Weapons and lag-compensated hit validation, once the game has combat.
