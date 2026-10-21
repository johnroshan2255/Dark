# DARK wire protocol — version 3

v3 (2026-10-21) added room BOTS: `Room.bots u8`; bots are players with ids ≥ `BOT_ID_BASE` (0xC000).

v2 (2026-10-21) added rooms: `Phase FreeRoam`, `Kick Kicked`, the `Room` packet and `Welcome.spawn` = `NO_SPAWN`.

One packet per **binary** WebSocket frame: `[kind: u8][payload]`, little-endian, no padding, ≤ 16 KiB.
Client → server kinds are `0x01–0x7f`, server → client `0x80–0xff`.

Implementations: Rust `server/crates/protocol`, TypeScript `game/src/net/protocol.ts`. Both are tested against
`server/crates/protocol/golden.json` (`cargo test -p dark-protocol`, `npm run test:protocol`). Any layout change:
update both, bump `PROTOCOL_VERSION`, regenerate the vectors (`UPDATE_GOLDEN=1 cargo test -p dark-protocol --test golden`).

## Types

| type | encoding |
|---|---|
| `pos` | 3 × `i32` centimetres: x, y (height), z — world space |
| `vel` | 3 × `i16` cm/s (±327 m/s) |
| `yaw` | `u16`: one turn = 65 536 (game convention: 0 faces −Z, + turns left) |
| `pitch` | `i16`: ±32 767 = ±π/2 |
| `str` | `u8` byte length + UTF-8 (≤ 255 bytes) |
| `long_str` | `u16` byte length + UTF-8 |
| flags | bit 0 DRIVING · 1 BOAT · 2 AIRBORNE · 3 DEAD (server) · 4 BOOST · 5 LIGHTS · 6 BRAKING · 7 FLYING (rejected) |

## Client → server

| kind | name | payload | when |
|---|---|---|---|
| `0x01` | Hello | `protocol u16`, `ticket long_str` | first packet, within 10 s of connecting |
| `0x02` | State | `seq u32`, `client_time u32`, `epoch u8`, `flags u8`, `model u8`, `pos`, `yaw`, `pitch i16`, `vel` (34 B) | every client tick (~30 Hz) |
| `0x03` | Ping | `client_time u32` | ~every 2 s (RTT, clock sync) |
| `0x04` | Action | `kind u8` (1 RespawnVehicle · 2 Ready · 3 Spectate), `target u16` | on input |
| `0x05` | Leave | — | quitting |

`model`: 0 on foot, else the vehicle catalogue index + 1. `epoch`: the last `Correction.epoch` applied (starts 0).

## Server → client

| kind | name | payload |
|---|---|---|
| `0x81` | Welcome | `protocol u16`, `player_id u16`, `match_id u64`, `tick_rate u8`, `map str`, `seed u32`, `spawn pos`, `yaw u16`, `server_time u32` |
| `0x82` | Snapshot | `tick u32`, `server_time u32`, `ack_seq u32`, `hp u8`, `alive u8`, `n u8`, n × Entity (26 B: `id u16`, `flags u8`, `model u8`, `pos`, `yaw u16`, `pitch i16`, `vel`), `m u8`, m × `removed id u16` |
| `0x83` | PlayerJoined | `id u16`, `name str` |
| `0x84` | PlayerLeft | `id u16` |
| `0x85` | Phase | `phase u8` (0 Lobby · 1 Countdown · 2 Running · 3 Ended · 4 FreeRoam), `ends_in_ms u32` (0 = no timer) |
| `0x86` | Zone | `x i32`, `z i32`, `radius u32` (cm, current circle) · `target_x`, `target_z`, `target_radius` · `shrink_start_ms u32`, `shrink_end_ms u32` (match time) · `dps u8` |
| `0x87` | Eliminated | `victim u16`, `killer u16` (0xffff = none), `cause u8` (1 Zone · 2 Roadkill · 3 Disconnect), `placement u8` |
| `0x88` | MatchEnd | `winner u16` (0xffff = none), `placement u8` |
| `0x89` | Correction | `seq u32`, `epoch u8`, `pos`, `yaw u16` — snap to this pose, send `epoch` from now on |
| `0x8a` | Pong | `client_time u32` (echo), `server_time u32` |
| `0x8b` | Kick | `reason u8` (1 BadTicket · 2 VersionMismatch · 3 MatchFull · 4 MatchOver · 5 Cheating · 6 Flooding · 7 Malformed · 8 Timeout · 9 ServerShutdown · 10 Duplicate · 11 Kicked by the room owner), `message str` — the socket closes with code 4000 + reason |
| `0x8c` | Room | `code str`, `name str`, `flags u8` (bit 0 PRIVATE · 1 ROADKILL · 2 FLYING), `max_players u16`, `owner u16` (0xffff = none), `bots u8` (server-run players) — on joining a room and whenever its settings or owner change |

## Flow

**Rooms** (free roam, what the game uses): `POST /v1/rooms` (create; you own it) or `POST /v1/rooms/{code}/join`
returns the same seat shape as matchmaking plus `room`, then steps 3–5 below. A room is `Phase FreeRoam` from the
start: join any time, no zone. `Welcome.spawn` is near the owner, or `x = NO_SPAWN` (`i32::MIN`) for the first
player (keep your own spawn). `FLYING` lets the `FLYING` state flag through; `ROADKILL` turns car hits on (knocked
down, `Eliminated` with `placement 0`, back up at once).

**Battle royale:**


1. `POST /v1/auth/guest {name}` → `token` (session).
2. `POST /v1/matchmake` (Bearer token) `{map?}` → `{match_id, player_id, ticket, ws_url, map, region, expires_in}`.
3. Open `ws_url`, send `Hello {protocol: 3, ticket}` → `Welcome` (+ `PlayerJoined` per player, `Phase`).
4. Stream `State` at your tick rate from the `Welcome.spawn`; render remote entities from `Snapshot`s ~100 ms in the
   past (interpolate on `server_time`); drop entities listed in `removed`.
5. On `Correction`: move there, adopt its `epoch`. The drop at the start of a match is a `Correction` too.
6. `Phase Running` + `Zone`: draw the circle (it closes from the current to the target circle between
   `shrink_start_ms` and `shrink_end_ms`); `hp` in snapshots; `Eliminated` → spectate (`Action Spectate`).
7. `MatchEnd`, then `Kick MatchOver` when the match closes.

## Limits the server enforces

- ≤ 90 packets/s per client (burst 180); 2 s over the limit → `Kick Flooding`. 8 malformed packets → `Kick Malformed`.
- 20 s without a packet → `Kick Timeout` (WebSocket pings every 10 s).
- Movement: ≤ 10 m/s on foot (vehicle speed for 3 s after bailing out), ≤ 75 m/s in a vehicle, ≤ 40 m/s climbing,
  not under the terrain (2.5 m tolerance), inside the map + 250 m, not flying (unless the room allows it: then no
  climb limit either). Endless-world rooms have no heightfield on the server: speed and teleport checks only. A rejected `State` → `Correction`;
  a decaying violation score past 25 → `Kick Cheating`.
