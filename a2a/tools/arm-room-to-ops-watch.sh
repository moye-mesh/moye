#!/usr/bin/env bash
# Arm (or re-arm) the ops room inbound watcher — exit-on-wake pattern (see watch-room-to-ops.js).
# - Kills any prior watcher for this role
# - Runs watch-room-to-ops.js in the foreground so a backgrounded-shell notify-on-output can see
#   the wake line
# - Resets inbound baseline so arm = "only wake on NEW inbound after this moment"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INBOX="$ROOT/docs/mission/inbox"
mkdir -p "$INBOX"

# Drop previous baseline after a successful handling cycle so the same delivered
# set does not immediately re-wake. Missing baseline ⇒ empty hash ⇒ outstanding
# (not-yet-delivered) inbound still wakes (rmsg_db25d30e5997). Never reset cursor.
rm -f "$INBOX/room-inbound-baseline-ops.sha"

pkill -f 'watch-room-to-ops\.js' 2>/dev/null || true
sleep 0.2

export NODE_OPTIONS="${NODE_OPTIONS:-}"
if command -v stdbuf >/dev/null 2>&1; then
  exec stdbuf -oL -eL node "$ROOT/tools/watch-room-to-ops.js"
else
  exec node "$ROOT/tools/watch-room-to-ops.js"
fi
