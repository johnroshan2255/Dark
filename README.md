# DARK

A browser open-world survival game with procedural worlds and hand-made maps, driveable vehicles, and multiplayer
battle-royale matches.

| | |
|---|---|
| [`game/`](game/) | the game: React + React Three Fiber + Three.js + Rapier, TypeScript, Vite — [README](game/README.md) · [architecture](game/ARCHITECTURE.md) |
| [`server/`](server/) | the multiplayer backend: Rust (tokio + axum), up to 100 players per match — [README](server/README.md) · [protocol](server/docs/PROTOCOL.md) |

## Develop

```sh
# game
cd game && npm ci && npm run dev          # http://localhost:5173
npm run typecheck && npm test

# server (Rust 1.97, see server/rust-toolchain.toml)
cd server && cargo run -p dark-server -- --dev   # http://localhost:7350
cargo test
```

CI (`.github/workflows/ci.yml`) runs the game's typecheck, tests and build, and the server's fmt, clippy and tests,
and builds the server image on every push and pull request.
