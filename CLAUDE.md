# DARK — monorepo

| folder | what | read first |
|---|---|---|
| `game/` | the browser game (React + R3F + Three.js + Rapier, TypeScript, Vite) | `game/CLAUDE.md`, `game/ARCHITECTURE.md` |
| `server/` | multiplayer backend (Rust: tokio + axum) | `server/CLAUDE.md`, `server/README.md` |
| `game/src/oth/` + `game/oth.html` | **Over the Hill** — map 3, its own world + renderer (no shared world code) | `game/ARCHITECTURE.md` §10 |

- Run each side's commands from its own folder (`cd game && npm test`, `cd server && cargo test`).
- The wire protocol is shared: `server/crates/protocol` (Rust) ⇄ `game/src/net/protocol.ts` (TypeScript), both tested
  against `server/crates/protocol/golden.json`. Change both together and bump `PROTOCOL_VERSION`.
- The server reads the game's maps (`game/public/maps/<id>/map.json`, `heights.bin`): a map edit changes what the
  server validates against — rerun `cargo test` too.
- Git: `.gitignore` at the root covers both sides (`game/node_modules`, `game/dist`, `server/target`, `.env*`, logs).
  `server/Cargo.lock` and `game/package-lock.json` are committed. CI (`.github/workflows/ci.yml`) runs both.
