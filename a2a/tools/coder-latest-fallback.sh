#!/usr/bin/env bash
# Fallback when room push is unavailable: poll mission/latest.md for To: coder.
# Emits a one-line sentinel when the file changes and mentions coder.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LATEST="$ROOT/docs/mission/latest.md"
INBOX="$ROOT/docs/mission/inbox"
mkdir -p "$INBOX"
STATE="$INBOX/latest-mtime.txt"
INTERVAL="${CODER_LATEST_POLL_SEC:-60}"

prev=""
[[ -f "$STATE" ]] && prev=$(cat "$STATE" || true)

while true; do
  sleep "$INTERVAL"
  [[ -f "$LATEST" ]] || continue
  cur=$(stat -f '%m' "$LATEST" 2>/dev/null || stat -c '%Y' "$LATEST")
  [[ "$cur" == "$prev" ]] && continue
  prev="$cur"
  echo "$cur" > "$STATE"
  if grep -qiE '^- From:.*To:[[:space:]]*coder|^- From:[[:space:]]*dev[[:space:]]*→[[:space:]]*To:[[:space:]]*coder' "$LATEST"; then
    python3 - <<PY
import json, time
from pathlib import Path
inbox = Path("$INBOX")
text = Path("$LATEST").read_text()
obj = {
  "id": "latest.md@" + str(int(time.time())),
  "ts": int(time.time()*1000),
  "room_id": None,
  "from_agent": "mission/latest.md",
  "type": "file-fallback",
  "text": text[:4000],
  "_source": "latest.md",
  "_received_at": int(time.time()*1000),
}
(inbox / "coder-last.json").write_text(json.dumps(obj, indent=2) + "\n")
with (inbox / "coder.log").open("a") as f:
    f.write(json.dumps({"id": obj["id"], "_source": "latest.md", "ts": obj["ts"]}) + "\n")
print("AGENT_CODER_INBOX_HIT", json.dumps({"source": "latest.md", "id": obj["id"]}))
PY
  else
    echo "AGENT_CODER_LATEST_CHANGED {\"source\":\"latest.md\",\"coder_mention\":false}"
  fi
done
