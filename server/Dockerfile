# syntax=docker/dockerfile:1.7
# DARK multiplayer server. Build from the REPOSITORY ROOT (the maps live in game/public/maps):
#     docker build -f server/Dockerfile -t dark-server .
#     docker run --rm -p 7350:7350 -e DARK_SECRET=$(openssl rand -hex 32) dark-server

FROM rust:1.97-slim-bookworm AS build
WORKDIR /src/server
COPY server/ ./
# the image's toolchain (rust-toolchain.toml would also fetch rustfmt / clippy)
RUN rm -f rust-toolchain.toml
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked -p dark-server && cp target/release/dark-server /dark-server

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /dark-server /usr/local/bin/dark-server
# Maps this server can host: map.json + heights.bin per map, biome.bin (where the water is frozen: ice to drive on)
# and statics.bin (the game's trunks, boulders and set pieces for the cars' physics); the rest is client-only.
COPY game/public/maps/island/map.json game/public/maps/island/heights.bin game/public/maps/island/biome.bin game/public/maps/island/statics.bin /maps/island/
ENV DARK_BIND=0.0.0.0:7350 \
    DARK_MAPS_DIR=/maps \
    DARK_MAPS=island \
    DARK_LOG_JSON=true \
    RUST_LOG=info,tower_http=warn
EXPOSE 7350
USER nonroot
# SIGTERM → stop matchmaking, let running matches finish (DARK_DRAIN_SECS), then exit.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/usr/local/bin/dark-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/dark-server"]
