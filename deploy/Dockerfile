# syntax=docker/dockerfile:1
# ThroughNet — single self-contained sensing server (ADR-151 A4).
# Multi-stage: build the `bundle` binary (UI + ESP32 firmware embedded) and ship
# it on a slim runtime. No Python in the image — this runs an already-set-up
# fleet headless/always-on (first-time flash/provision happens on the host where
# the boards are; in-container flashing needs USB --device passthrough).
# Build context = repo root (see deploy/docker-compose.yml: context "..").

FROM rust:1.89-bookworm AS builder
WORKDIR /build
# Targeted copies so v2/target (gigabytes) never enters the context, and the
# `bundle` embed #[folder] paths resolve (crate-relative ../../../app/dist and
# ../../../firmware/.../throughnet-s3-nodisp).
COPY v2/Cargo.toml v2/Cargo.lock v2/rust-toolchain.toml /build/v2/
COPY v2/crates/ /build/v2/crates/
COPY app/dist/ /build/app/dist/
COPY firmware/esp32-csi-node/release_bins/throughnet-s3-nodisp/ \
     /build/firmware/esp32-csi-node/release_bins/throughnet-s3-nodisp/
WORKDIR /build/v2
RUN cargo build --release --features bundle -p wifi-densepose-sensing-server \
 && strip target/release/sensing-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/v2/target/release/sensing-server /usr/local/bin/throughnet-server
# HTTP/WS dashboard + UDP 5005 CSI ingest.
EXPOSE 8080 5005/udp
# Data source via CSI_SOURCE env (the binary reads it; compose overrides it).
ENV CSI_SOURCE=esp32
ENTRYPOINT ["throughnet-server"]
# Bind 0.0.0.0 so the dashboard is reachable from the host/LAN. When exposing
# beyond loopback, also set RUVIEW_API_TOKEN to bearer-gate /api/v1/* (incl. the
# localhost setup endpoints, which become reachable once bound to 0.0.0.0).
CMD ["--bind-addr", "0.0.0.0", "--http-port", "8080"]
