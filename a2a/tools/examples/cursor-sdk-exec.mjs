#!/usr/bin/env node
/**
 * Example --exec target for moye-agent-bridge (ADR-0026 / R8).
 *
 * Requires: CURSOR_API_KEY, and `npm i @cursor/sdk` in this directory or NODE_PATH.
 * This starts a *new* Cursor SDK agent run — it does NOT wake an existing IDE chat tab.
 *
 *   node a2a/tools/moye-agent-bridge.js \
 *     --room room_… --match coder --secret … --identity … \
 *     --exec 'node a2a/tools/examples/cursor-sdk-exec.mjs'
 */
import { Agent } from '@cursor/sdk';

const text = process.env.MOYE_MSG_TEXT || '';
const room = process.env.MOYE_ROOM_ID || '';
const key = process.env.CURSOR_API_KEY;
if (!key) {
  console.error(JSON.stringify({ error: 'CURSOR_API_KEY not set — cannot start SDK agent' }));
  process.exit(2);
}

const prompt = `MOYE room ${room} addressed you:\n\n${text}\n\nAct on it in the moye repo working tree if it is a coding task; otherwise summarize what you would do.`;

const result = await Agent.prompt(prompt, {
  apiKey: key,
  model: { id: 'composer-2.5' },
  local: { cwd: process.env.MOYE_BRIDGE_CWD || process.cwd() },
});
console.log(JSON.stringify({ status: result.status, result: result.result || null }));
