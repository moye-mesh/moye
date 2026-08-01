#!/usr/bin/env bash
# Coder room listener (ADR-0026 / R4 addendum). Primary: watch dogfood room.
# Fallback: coder-latest-fallback.sh polls mission/latest.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID="$ROOT/docs/mission/identities/coder-bridge-identity.json"
ROOM_JSON="$ROOT/docs/mission/identities/room.json"
INBOX="$ROOT/docs/mission/inbox"
mkdir -p "$INBOX"

ROOM_ID=$(python3 -c "import json; print(json.load(open('$ROOM_JSON'))['room_id'])")
SECRET=$(python3 -c "import json; print(json.load(open('$ROOM_JSON'))['membership_secret'])")

# stderr stays diagnostics-only (bridged/skipped). Do not 2>&1.
exec node "$ROOT/tools/moye-agent-bridge.js" \
  --room "$ROOM_ID" \
  --secret "$SECRET" \
  --identity "$ID" \
  --base-url https://moye.ai/a2a \
  --match-regex 'coder|@coder|To: coder|ag_a8b63e5a8359' \
  --exec "node $ROOT/tools/coder-inbox-write.js" \
  --stdin json
