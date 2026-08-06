#!/usr/bin/env bash
# Arm (or re-arm) the coder room inbound watcher — Claude→Cursor exit-on-wake pattern.
# - Kills any prior watcher for this role
# - Exec's watch-room-to-coder.js in the foreground so Cursor Shell notify_on_output works
# - Resets inbound baseline so arm = "only wake on NEW inbound after this moment"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INBOX="$ROOT/docs/mission/inbox"
mkdir -p "$INBOX"

# Drop previous baseline so a re-arm after handling does not immediately re-wake
# on the same already-delivered inbound set. Missing baseline ⇒ empty hash ⇒ any
# *outstanding* (not-yet-delivered) inbound still wakes (rmsg_db25d30e5997).
# Do NOT touch the cursor file here — never reset to "now".
rm -f "$INBOX/room-inbound-baseline.sha"

# Avoid duplicate watchers
pkill -f 'watch-room-to-coder\.js' 2>/dev/null || true
sleep 0.2

# Prefer line-buffered stdout when stdbuf exists (Linux); on macOS node + writeSync is enough.
export NODE_OPTIONS="${NODE_OPTIONS:-}"
if command -v stdbuf >/dev/null 2>&1; then
  exec stdbuf -oL -eL node "$ROOT/tools/watch-room-to-coder.js"
else
  exec node "$ROOT/tools/watch-room-to-coder.js"
fi
