#!/usr/bin/env bash
# ThroughNet app launcher (ADR-151 A2 — server-as-shell).
#
# Builds the from-scratch UI (app/dist), builds the single self-contained
# sensing-server with the UI *and* the ESP32 firmware embedded (rust-embed,
# --features bundle), runs it, and opens it app-mode in Chromium. Any extra args
# pass through to the server, e.g.:
#
#   scripts/throughnet-app.sh --source esp32
#
# Env: TN_HTTP_PORT (default 8080), TN_NO_OPEN=1 to skip launching a browser.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${TN_HTTP_PORT:-8080}"

echo "==> building UI (app/dist)"
( cd "$ROOT/app" && npm install --no-audit --no-fund --silent && npm run build )

echo "==> building server (single self-contained binary, --features bundle: UI + firmware)"
( cd "$ROOT/v2" && cargo build --release --features bundle -p wifi-densepose-sensing-server )
BIN="$ROOT/v2/target/release/sensing-server"

echo "==> starting ThroughNet on http://localhost:$PORT/"
"$BIN" --http-port "$PORT" "$@" &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

# wait until it answers, then open the app-mode window
for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://localhost:$PORT/health" 2>/dev/null && break; sleep 1; done
if [ "${TN_NO_OPEN:-0}" != "1" ]; then
  URL="http://localhost:$PORT/"
  for b in chromium chromium-browser google-chrome-stable google-chrome brave-browser; do
    if command -v "$b" >/dev/null 2>&1; then
      echo "==> opening $URL in $b (app mode)"
      "$b" --app="$URL" --class=ThroughNet >/dev/null 2>&1 &
      break
    fi
  done
fi

wait "$SRV"
