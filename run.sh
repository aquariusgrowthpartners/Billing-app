#!/usr/bin/env bash
#
# Single entry point for the Billing Calendar app.
#
#   ./run.sh            start the app (installs + seeds automatically on first run)
#   ./run.sh --install  (re)install dependencies only
#   ./run.sh --build    build the UI, then serve everything from the API on one port
#   ./run.sh --reset    wipe and reseed the database, then start
#   ./run.sh --smoke    run the end-to-end UI test against a running app
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BUNDLED_NODE_BIN="/Users/james/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin"
PNPM_JS="/Users/james/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
LOCAL_RUNTIME="$ROOT/.runtime"

# --- caches stay inside the project (never ~/.npm or ~/Library) -------------
export npm_config_cache="${npm_config_cache:-$ROOT/.cache/npm}"
export npm_config_devdir="${npm_config_devdir:-$ROOT/.cache/node-gyp}"
mkdir -p "$npm_config_cache" "$npm_config_devdir" "$LOCAL_RUNTIME"

# --- pick a Node ------------------------------------------------------------
pick_node() {
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  elif [ -x "$BUNDLED_NODE_BIN/node" ]; then
    NODE="$BUNDLED_NODE_BIN/node"
  else
    echo "ERROR: no Node.js found. Install Node 20+ and re-run." >&2
    exit 1
  fi
  export PATH="$(dirname "$NODE"):$PATH"
}
pick_node

install_deps() {
  echo "==> Installing dependencies (compiles better-sqlite3 the first time)…"
  if [ -f "$PNPM_JS" ]; then
    "$NODE" "$PNPM_JS" install --reporter=append-only
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm install
  elif command -v npm >/dev/null 2>&1; then
    npm install
  else
    echo "ERROR: no package manager found (looked for pnpm, npm)." >&2
    exit 1
  fi
}

# macOS ships hardened-runtime Node builds (Developer ID signed) that refuse to
# load ad-hoc-signed native addons such as our locally compiled better-sqlite3.
# If that happens, keep an ad-hoc-signed copy of Node inside the project and use
# it instead. Nothing outside this folder is modified.
# Note: better-sqlite3 only dlopen()s its native addon when a Database is
# constructed, so the probe must actually open one — a bare require() always
# succeeds and would fool us.
SQLITE_PROBE="const D=require('better-sqlite3'); new D(':memory:').close();"

ensure_node_can_load_sqlite() {
  if "$NODE" -e "$SQLITE_PROBE" >/dev/null 2>&1; then
    return 0
  fi
  if [ "$(uname -s)" != "Darwin" ] || ! command -v codesign >/dev/null 2>&1; then
    echo "WARNING: node could not load better-sqlite3 — run ./run.sh --install" >&2
    return 0
  fi

  local src="$NODE"
  [ -x "$BUNDLED_NODE_BIN/node" ] && src="$BUNDLED_NODE_BIN/node"
  local target="$LOCAL_RUNTIME/node"

  if [ ! -x "$target" ] || [ "$src" -nt "$target" ]; then
    echo "==> Preparing a local Node runtime (ad-hoc signed) so native addons load…"
    cp "$src" "$target"
    codesign --force --sign - --identifier "billing-calendar-node" "$target" >/dev/null 2>&1 || true
  fi

  if "$target" -e "$SQLITE_PROBE" >/dev/null 2>&1; then
    NODE="$target"
    export PATH="$LOCAL_RUNTIME:$PATH"
  else
    echo "WARNING: better-sqlite3 still will not load. Try: ./run.sh --install" >&2
  fi
}

MODE="dev"
for arg in "$@"; do
  case "$arg" in
    --install) install_deps; exit 0 ;;
    --build)   MODE="build" ;;
    --reset)   MODE="reset" ;;
    --smoke)   MODE="smoke" ;;
    --help|-h) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

[ -d node_modules ] || install_deps
ensure_node_can_load_sqlite

# The smoke test talks to a running API, so skip the port preflight for it.
if [ "$MODE" = "smoke" ]; then
  exec "$NODE" scripts/smoke.mjs
fi

# --- preflight: is something already listening? -----------------------------
# Returns 0 when the port is taken, 1 when it is free.
port_in_use() {
  "$NODE" -e "
    const net = require('net');
    const s = net.createServer();
    s.once('error', (e) => process.exit(e.code === 'EADDRINUSE' ? 0 : 1));
    s.once('listening', () => s.close(() => process.exit(1)));
    s.listen(Number(process.argv[1]), '127.0.0.1');
  " "$1" >/dev/null 2>&1
}

# Port resolution. The API server itself reads PORT; scripts/dev.mjs reads
# API_PORT and passes it down as PORT, and Vite reads API_PORT/WEB_PORT. Accept
# either spelling so `PORT=4100 ./run.sh` and `API_PORT=4100 ./run.sh` both work.
WEB_PORT="${WEB_PORT:-5173}"
if [ "$MODE" = "build" ]; then
  API_PORT="${PORT:-4000}"
else
  API_PORT="${API_PORT:-${PORT:-4000}}"
fi
export API_PORT WEB_PORT

if [ "$MODE" = "build" ]; then
  if port_in_use "$API_PORT"; then
    echo "ERROR: port $API_PORT is already in use." >&2
    echo "       The app is probably already running — try http://127.0.0.1:$API_PORT" >&2
    echo "       Stop the other instance, or start this one on another port:" >&2
    echo "       PORT=4100 ./run.sh --build" >&2
    exit 1
  fi
else
  for pair in "$API_PORT:API" "$WEB_PORT:UI"; do
    p="${pair%%:*}"; label="${pair##*:}"
    if port_in_use "$p"; then
      echo "ERROR: port $p ($label) is already in use — the app may already be running." >&2
      echo "       If it is, just open http://127.0.0.1:$WEB_PORT" >&2
      echo "       Otherwise stop the other instance, or use different ports:" >&2
      echo "       API_PORT=4100 WEB_PORT=5183 ./run.sh" >&2
      exit 1
    fi
  done
fi

if [ "$MODE" = "reset" ]; then
  echo "==> Resetting the database…"
  "$NODE" server/seed.js --reset
else
  # No-ops when clients already exist.
  "$NODE" server/seed.js
fi

if [ "$MODE" = "build" ]; then
  echo "==> Building the UI…"
  "$NODE" node_modules/vite/bin/vite.js build --config client/vite.config.js
  echo "==> Serving the app on http://127.0.0.1:$API_PORT"
  exec "$NODE" server/index.js
fi

exec "$NODE" scripts/dev.mjs
