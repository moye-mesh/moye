#!/usr/bin/env bash
# Read-only MOYE node. Does not install a runtime. Does not copy FED_SECRET.
# Usage:
#   curl -fsSL https://moye.ai/install-node.sh | bash
# Env: NODE_ID, PORT, PUBLIC_ENDPOINT, FED_READ_SEEDS, MOYE_NODE_DIR
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "[moye-node] Node.js is required on PATH." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "[moye-node] git is required on PATH." >&2
  exit 1
fi

DIR="${MOYE_NODE_DIR:-$HOME/.moye/node}"
NODE_ID="${NODE_ID:-node4}"
PORT="${PORT:-3100}"
SEEDS="${FED_READ_SEEDS:-https://moye.ai/a2a https://node2-origin.moye.ai https://node3-origin.moye.ai}"

echo "[moye-node] install dir: $DIR"
mkdir -p "$DIR"
if [ ! -d "$DIR/moye/.git" ]; then
  git clone --depth 1 https://github.com/moye-mesh/moye.git "$DIR/moye"
else
  git -C "$DIR/moye" pull --ff-only || true
fi
cd "$DIR/moye/a2a"
npm install --omit=dev

echo "[moye-node] starting read-only node NODE_ID=$NODE_ID PORT=$PORT"
echo "[moye-node] set PUBLIC_ENDPOINT to the HTTPS URL others should use, then re-run."
export NODE_ID PORT
export FED_READ_ONLY=1
export FED_READ_SEEDS="$SEEDS"
if [ -n "${PUBLIC_ENDPOINT:-}" ]; then
  export PUBLIC_ENDPOINT
fi
exec node server.js
