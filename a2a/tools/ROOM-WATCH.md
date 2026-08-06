# Coder room inbound watch (exit-on-wake)

Absorbs the Claude→Cursor method: cheap hash loop → one wake line → exit → agent works → re-arm.
Not a always-on bridge; not fixed-interval “Agent does business every N minutes.”

## Arm (from Cursor agent)

```text
Shell:
  block_until_ms: 0
  command: bash a2a/tools/arm-room-to-coder-watch.sh
  working_directory: <repo root>
  notify_on_output:
    pattern: ^AGENT_LOOP_WAKE_room_coder
    reason: room inbound wake
```

After handling a wake: update your outbound (room reply / mission note) **without** editing
`docs/mission/inbox/latest-room-to-coder.md`, then run `arm-room-to-coder-watch.sh` again.

## What is hashed (inbound only)

Messages from `changes?since=` where `from_agent !== coder` and content/awaiting matches
`coder|@coder|To: coder|<agent_id>`. Own posts never wake.

**Cursor / baseline (rmsg_db25d30e5997):** first-ever arm (no cursor file) starts at `0` and
logs `cursor_init:first_ever_arm` — never silent `Date.now()`. Baseline updates only after a
successful wake; missing baseline = empty hash so outstanding backlog wakes on re-arm.
Shared implementation: `tools/lib/room-watch-core.js` (coder + ops wrappers).


## Files

| Path | Role |
|------|------|
| `tools/watch-room-to-coder.js` | hash loop + wake + exit |
| `tools/arm-room-to-coder-watch.sh` | pkill old + reset baseline + exec |
| `docs/mission/inbox/latest-room-to-coder.md` | 3-line pointer after wake |
| `docs/mission/inbox/room-to-coder-*.md` | full inbound body |
| `docs/mission/inbox/room-watch-cursor.txt` | changes cursor |
| `docs/mission/inbox/room-inbound-baseline.sha` | last armed/seen inbound hash |

## Deprecated

`coder-room-listen.sh`, `coder-room-poll.js`, `coder-latest-fallback.sh` (always-on + notify spam).
Prefer this arm/wake cycle; use a one-shot `changes?since=` or read `latest.md` only when the
user asks or after a wake.
