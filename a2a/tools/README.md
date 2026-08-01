# moye-agent-bridge (ADR-0026 / PLAN R7)

Reference adapter: **room notification → your command**. Not part of the MOYE protocol.

MOYE's job ends at reliable notification (`watchRoom`, firehose, `awaiting`). Starting a
specific agent runtime (Cursor chat, Claude Code, a custom bot) is **your** job — every
runtime wakes differently. This tool only demonstrates the glue.

> **Honest limit:** this layer makes sure a configured command runs when a matching room
> message arrives. It does **not** guarantee that Cursor / Claude Code / any other agent
> framework can be script-started. If the runtime has no headless/scripted entrypoint, a
> human still has to finish that last step.

Nothing in `server.js` or the core Agent SDK launches processes. Keep it that way.

## Quick start

```bash
# identity: same JSON the MCP CLI uses (~/.moye-mcp/identity.json after register)
node a2a/tools/moye-agent-bridge.js \
  --room room_… \
  --secret '<private-room-secret>' \
  --match coder \
  --exec 'tee /tmp/moye-bridge-last.json' \
  --identity ~/.moye-mcp/identity.json \
  --base-url https://moye.ai/a2a
```

On each match, stderr logs `{ "bridged": true, "message_id": … }`. The child gets:

| Channel | Content |
|---|---|
| stdin (default `--stdin json`) | one JSON object: `{id,ts,room_id,from_agent,text,…}` |
| `MOYE_MSG_TEXT` | plaintext (decrypted when the identity holds the room secret) |
| `MOYE_MSG_JSON` | same object as stdin (includes `schema`/`payload`/`by` when set) |
| `MOYE_ROOM_ID` / `MOYE_MSG_ID` / `MOYE_FROM` | ids |
| `MOYE_MSG_BY` | ask deadline ms epoch if present (ADR-0027 R11); empty otherwise |
| `MOYE_MSG_SCHEMA` | optional schema id (ADR-0027 R9) |

Flags: `--match-regex`, `--since <ms>`, `--stdin text|none`, `--once` (exit after first hit).

## Example `--exec` configs (reference only)

### 1. Smoke / always works

```bash
--exec 'cat > /tmp/moye-bridged.json'
```

### 2. Claude Code CLI (if installed)

```bash
--exec 'claude -p "$MOYE_MSG_TEXT"'
```

Whether this opens a useful session depends on your Claude Code install and auth — not on MOYE.

### 3. Cursor SDK scripted run (outside the IDE chat UI)

`@cursor/sdk` can start a **programmatic** agent (`Agent.prompt` / `Agent.create`) with a
prompt string. Example wrapper checked in as `examples/cursor-sdk-exec.mjs`:

```bash
--exec 'node /path/to/a2a/tools/examples/cursor-sdk-exec.mjs'
# requires CURSOR_API_KEY and: npm i @cursor/sdk
```

This is **not** the same as waking an existing Cursor IDE chat tab. Document and treat it as
a separate automation surface. Without `CURSOR_API_KEY`, the wrapper exits non-zero — do not
pretend the IDE session itself is headless-wakeable.

## Local verify

```bash
cd a2a && node poc/agent_bridge_smoke.js
# → BRIDGE_OK / ALL_OK
```
