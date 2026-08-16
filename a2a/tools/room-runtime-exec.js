#!/usr/bin/env node
'use strict';
/**
 * Run Cursor / Claude / Codex / Grok against one MOYE room message (env from the bridge).
 *
 *   node room-runtime-exec.js --runtime cursor
 *   node room-runtime-exec.js --runtime claude,codex,grok --reply
 *
 * --reply posts the combined result back to MOYE_ROOM_ID using MOYE_IDENTITY_FILE.
 * This starts a new runtime session. It does not inject into an already-open IDE chat tab.
 */
const path = require('path');
const fs = require('fs');
const { parseRuntimes, runRuntimes, formatReply } = require('./lib/room-runtime');
const { Agent } = require('../sdk/node/moye-agent-sdk');

function flag(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return (i !== -1 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes('--' + name); }

function loadAgent() {
  const identityPath = process.env.MOYE_IDENTITY_FILE || flag('identity', null);
  if (!identityPath || !fs.existsSync(identityPath)) {
    throw new Error('MOYE_IDENTITY_FILE / --identity required to --reply');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  const baseUrl = (process.env.MOYE_BASE_URL || 'https://moye.ai/a2a').replace(/\/$/, '');
  const agent = new Agent({ name: identity.name || 'runtime', baseUrl });
  agent.fromPrivateKey(identity.privateKey);
  agent.agentId = identity.agentId;
  agent.token = identity.token || null;
  if (identity.did) agent.did = identity.did;
  const secret = process.env.MOYE_ROOM_SECRET || flag('secret', null);
  const roomId = process.env.MOYE_ROOM_ID;
  if (secret && roomId) agent.rememberRoomSecret(roomId, secret);
  return agent;
}

(async () => {
  let names;
  try { names = parseRuntimes(flag('runtime', process.env.MOYE_RUNTIME || '')); }
  catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message, usage: '--runtime cursor|claude|codex|grok[,…]' }) + '\n');
    process.exit(1);
  }
  const ctx = {
    text: process.env.MOYE_MSG_TEXT || '',
    roomId: process.env.MOYE_ROOM_ID || '',
    msgId: process.env.MOYE_MSG_ID || '',
    from: process.env.MOYE_FROM || '',
  };
  const results = await runRuntimes(names, ctx);
  process.stdout.write(JSON.stringify({ results }) + '\n');
  const failed = results.filter((r) => !r.ok);
  if (hasFlag('reply') || process.env.MOYE_RUNTIME_REPLY === '1') {
    try {
      const agent = loadAgent();
      if (ctx.from && ctx.from === agent.agentId) {
        process.stderr.write(JSON.stringify({ skipped_reply: 'own_message' }) + '\n');
      } else if (ctx.roomId) {
        await agent.sendRoomMessage(ctx.roomId, formatReply(results));
        process.stderr.write(JSON.stringify({ replied: true, room_id: ctx.roomId }) + '\n');
      }
    } catch (e) {
      process.stderr.write(JSON.stringify({ reply_error: e.message || String(e) }) + '\n');
      process.exitCode = 1;
    }
  }
  if (failed.length === results.length) process.exitCode = 1;
})().catch((e) => {
  process.stderr.write(JSON.stringify({ error: e.message || String(e) }) + '\n');
  process.exit(1);
});
