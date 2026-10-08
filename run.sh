#!/usr/bin/env bash
# Serves Primordium locally and opens it in the default browser.
# Usage: bash run.sh   (or PORT=8080 bash run.sh)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-9131}"
URL="http://localhost:$PORT/"

# Build fresh bundles so the browser never serves stale output.
npm run build

# A previous run (or a stray server) may still hold the port — stop it
# instead of failing on "Address already in use".
if command -v fuser >/dev/null 2>&1; then
  fuser -k "$PORT"/tcp 2>/dev/null && sleep 0.3 || true
elif command -v lsof >/dev/null 2>&1; then
  holders="$(lsof -ti ":$PORT" 2>/dev/null || true)"
  if [ -n "$holders" ]; then
    kill $holders 2>/dev/null || true
    sleep 0.3
  fi
fi

# Serve the repo root: index.html and dist/ must stay siblings.
python3 -m http.server "$PORT" --bind 127.0.0.1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sleep 0.5
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$URL"
else
  echo "[run] no browser opener found, open $URL manually"
fi

echo "[run] serving on $URL (Ctrl+C to stop)"
wait "$SERVER_PID"
