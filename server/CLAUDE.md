# DARK server — agent notes

Rust workspace (`cargo` from this folder). Read `README.md` (architecture, config, metrics) and `docs/PROTOCOL.md`.

- **Layers:** `protocol` (wire format) ← `sim` (rules) ← `server` (I/O). `sim` stays pure: no sockets, files after
  load, logging, wall clock or `rand` — time comes in as `now_ms`, randomness from its seeded `Rng`. Rules get unit
  tests there.
- **Protocol changes:** edit `crates/protocol` AND `../game/src/net/protocol.ts`, bump `PROTOCOL_VERSION`,
  regenerate with `UPDATE_GOLDEN=1 cargo test -p dark-protocol --test golden`, then run `cargo test` and
  `cd ../game && npm run test:protocol`.
- **Match task:** never block or await inside a tick. Channels are bounded and use `try_send`; a full lane drops that
  client, never stalls the match.
- **Gate (CI):** `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`.
- **Performance claims:** measure with `dark-bots` against a release build (`DARK_MATCH_CONFIG=deploy/loadtest.toml`)
  and quote `dark_tick_seconds` / bytes per player.
- **Commands:**
  - `cargo run -p dark-server -- --dev`
  - `cargo test`
  - `cargo run --release -p dark-bots -- --bots 100 --secs 60`
  - `docker build -f server/Dockerfile .` (from the repo root)
