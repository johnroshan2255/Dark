---
name: multiplayer
description: Read before any networking, replication, or authority decision — 4-player host-authoritative co-op, snapshots, interpolation, prediction, world sync.
---

# Multiplayer (4-player co-op)

## 1. Purpose

Up to 4 players share one world: same seed, same monsters, same time of day. Horror co-op tolerates ~100 ms of
latency for *other* players and monsters, but the local player's movement and flashlight must feel instant.

## 2. Architecture

```
            ┌───────────── HOST (one player's browser, or a small Node relay-host) ─────────────┐
 inputs ──► │ authoritative sim: all players, monsters, doors/items, time of day, world deltas │ ──► snapshots 20 Hz
            └──────────────────────────────────────────────────────────────────────────────────┘
 CLIENT: sends inputs 30–60 Hz, predicts own player, interpolates others 100 ms in the past

src/multiplayer/
  networking/     Transport interface (WebRTC DataChannel | WebSocket), message framing
  state/          snapshot schema, delta log, entity ids
  interpolation/  snapshot buffer, per-entity interpolation, reconciliation for own player
```

### World sync: seed + delta log

The world is **never sent**. The join handshake sends:

```ts
interface JoinAccept {
  seed: number
  timeOfDay: number
  realm: 'normal' | 'nightmare'
  deltas: WorldDelta[]     // everything that diverged from the seed
  youAre: PlayerId
}
type WorldDelta =
  | { t: 'itemTaken'; chunk: string; itemId: number }
  | { t: 'doorState'; id: number; open: boolean }
  | { t: 'propMoved'; id: number; pos: [number, number, number] }
```

Deltas are keyed by chunk; when a client streams a chunk in, it applies the chunk's deltas after generation. This
requires **deterministic generation** (see `skills/procedural-world`) — any `Math.random()` in placement breaks it.

## 3. When to use

- Anything that affects more than one player's experience: monster positions/state, doors, loot, time of day,
  realm transitions, damage.

## 4. When NOT to use (keep local)

- Vegetation sway, particles, fog animation, grading, footstep audio of others (derive from replicated velocity).
- Culling, LOD, streaming decisions (each client streams its own ring).
- Flashlight *cone rendering* — replicate only on/off + aim direction (quantized).

## 5. Performance implications

### Bandwidth estimate (host upload, 20 Hz snapshots)

| Entity | Fields (quantized) | Bytes |
|---|---|---|
| Player | id 1, pos 3×int16 (cm, chunk-relative) + chunk 2×int16, yaw/pitch 2×int8, velocity 3×int8, flags 1 | ~20 |
| Monster | id 2, pos 10, yaw 1, state 1, anim time 1 | ~15 |
| Header | tick 4, ack 2, counts 2 | 8 |

Snapshot with 4 players + 12 active monsters ≈ 8 + 80 + 180 = **~270 B** → ×20 Hz = 5.4 KB/s per client →
×3 clients = **~16 KB/s host upload**. Inputs: ~12 B × 60 Hz ≈ 0.7 KB/s per client. Trivial for any connection.

Delta-compress against the last acked snapshot to cut ~50–70% more when needed.

### CPU

- Host simulates monsters in the **union** of all players' AI rings → monster CPU scales with players' spread.
  Cap active monsters globally (e.g. 24).
- Host streams chunks/physics for the union of all players' physics rings (≤ 4 × 9 chunks worst case).

### Memory

Snapshot buffer: 32 snapshots × ~300 B — negligible.

## 6. WebGL / browser limitations

- No UDP; options:

| Transport | Pros | Cons |
|---|---|---|
| WebRTC DataChannel (`ordered:false, maxRetransmits:0`) | P2P, unreliable/unordered → UDP-like, no server bandwidth | needs signaling server + STUN; TURN for ~10–15% NATs; host migration hard |
| WebSocket to relay | trivial, works everywhere | TCP head-of-line blocking (a lost packet stalls later snapshots 100–300 ms) |
| WebTransport (datagrams) | UDP-like client↔server | needs HTTP/3 server; Safari support limited |

**Decision:** WebRTC DataChannel with a host player, tiny WebSocket signaling server. Two channels: `unreliable`
(snapshots, inputs) and `reliable` (join, deltas, chat, events). Transport behind an interface so a WebSocket
relay can be swapped in for testing / restrictive networks.

- Background tabs throttle timers → the host must keep simulating when its tab is hidden: run sim tick from a
  `MessageChannel`/Worker timer, not only `requestAnimationFrame`.

## 7. R3F implementation

Remote players are pooled visuals driven by the interpolation system; React only mounts the pool:

```tsx
function RemotePlayers() {
  const game = useGame()
  const root = useMemo(() => new THREE.Group(), [])
  useLayoutEffect(() => game.net.remotes.setRoot(root), [game, root])
  return <primitive object={root} dispose={null} />
}
```

Player joins/leaves may update a low-frequency store for the UI roster — never per-snapshot.

## 8. Direct implementation

### Tick & messages

```ts
const SIM_HZ = 60, SNAPSHOT_EVERY = 3            // 60 / 3 = 20 Hz
interface InputMsg { tick: number; seq: number; move: number /* bitmask */; yaw: number; pitch: number; buttons: number }
interface Snapshot { tick: number; lastInputSeq: Record<PlayerId, number>; players: PlayerState[]; monsters: MonsterState[] }
```

Encode with `DataView` into a reused `ArrayBuffer` — no JSON on the unreliable channel.

### Interpolation buffer (remote entities)

```ts
const INTERP_DELAY = 0.1   // seconds
function sampleRemote(buf: Snapshot[], renderTime: number, id: number, out: THREE.Vector3) {
  // find a, b with a.time <= renderTime - INTERP_DELAY < b.time
  const t = renderTime - INTERP_DELAY
  let i = buf.length - 1
  while (i > 0 && buf[i - 1].time > t) i--
  const a = buf[i - 1], b = buf[i]
  if (!a || !b) return false                     // under/overrun: hold last, or extrapolate ≤ 100 ms
  const k = (t - a.time) / (b.time - a.time)
  out.lerpVectors(posOf(a, id), posOf(b, id), k)
  return true
}
```

Yaw: interpolate the shortest arc. Snap (no lerp) when distance > 5 m (teleport/respawn).

### Client prediction + reconciliation (own player)

1. Apply input locally immediately, store `{seq, input, resultingPos}` in a ring buffer.
2. On snapshot: take server position for `lastInputSeq`, drop acknowledged inputs, **re-simulate** remaining
   inputs from the server state using the same controller code (Rapier character controller runs locally too).
3. If correction < 0.3 m, blend over 100 ms; otherwise snap.

Same seed ⇒ same terrain collider locally ⇒ prediction rarely mispredicts.

### Authority table

| State | Authority |
|---|---|
| Own movement | client-predicted, host-validated (speed/teleport clamp) |
| Monsters (AI, position, attacks) | host |
| Damage, death, items, doors | host |
| Time of day, realm switch | host (clients extrapolate time between snapshots) |
| Flashlight on/off, aim | client, replicated |
| Culling/LOD/streaming | each client locally |

### Host streaming

```ts
// host: required physics/AI chunks = union of each player's rings
const needed = new Set<string>()
for (const p of players) forEachChunkInRing(p.chunk, PHYSICS_RADIUS, k => needed.add(k))
```

Render streaming on the host is still only around the host's own camera.

## 9. Common mistakes

1. Sending full world state or chunk contents (seed + deltas is enough).
2. JSON snapshots at 60 Hz (10× the bytes, GC churn).
3. Interpolating with arrival time instead of server tick time → jitter.
4. Reliable ordered channel for snapshots → stalls on loss.
5. Running monster AI on every client "for smoothness" → divergence.
6. Using `Math.random()` in anything the host and client both compute (loot tables, spawn jitter).
7. Host tab in background stops simulating (rAF throttle).
8. Floating-point drift from large world coordinates — quantize positions chunk-relative.

## 10. Profiling / debugging

- Net HUD (planned): RTT, snapshot rate, bytes/s up/down, interpolation buffer depth, prediction error (m).
- Network conditioner in dev: a Transport wrapper that adds latency (e.g. 120 ms ± 30), 2% loss, reordering.
- Record snapshots to a file and replay for deterministic bug repro.
- Desync check: host sends a hash of chunk deltas per chunk occasionally; client compares.
- Chrome `chrome://webrtc-internals` for DataChannel stats (bytes, RTT, packet loss).
