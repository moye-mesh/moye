#!/usr/bin/env node
'use strict';
/**
 * moye-agent-bridge — reference adapter (ADR-0026 / PLAN R7), NOT protocol core.
 *
 * Watches a room via Agent.watchRoom (ADR-0025). When a new message matches --match,
 * runs --exec. MOYE never starts an agent runtime itself; you choose the command.
 *
 * Honest limit: this solves "notification arrived → run a command". Whether that command
 * actually wakes Cursor / Claude Code / … depends on that runtime. See tools/README.md.
 *
 * Usage:
 *   node moye-agent-bridge.js --room <id> --match <needle> --exec <command> \
 *     [--secret <s>] [--identity <path>] [--base-url <url>] [--since <ms>] \
 *     [--stdin json|text|none] [--once]
 *
 * Env passed to --exec: MOYE_MSG_TEXT, MOYE_MSG_JSON, MOYE_ROOM_ID, MOYE_MSG_ID,
 * MOYE_FROM, MOYE_MATCH. Stdin (default): one JSON object for the message.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Agent } = require('../sdk/node/moye-agent-sdk');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return (i !== -1 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }
function die(msg) {
  process.stderr.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
}

const roomId = flag('room');
const matchNeedle = flag('match');
const matchRegexSrc = flag('match-regex', null);
const execCmd = flag('exec');
const secret = flag('secret', null);
const identityPath = flag('identity', process.env.MOYE_IDENTITY_FILE || null);
const baseUrl = (flag('base-url', process.env.MOYE_BASE_URL || 'https://moye.ai/a2a')).replace(/\/$/, '');
const since = parseInt(flag('since', String(Date.now())), 10) || Date.now();
const stdinMode = flag('stdin', 'json'); // json | text | none
const once = hasFlag('once');

if (!roomId) die('usage: --room <room_id> required');
if (!matchNeedle && !matchRegexSrc) die('usage: --match <needle> and/or --match-regex <re> required');
if (!execCmd) die('usage: --exec <command> required');
if (!['json', 'text', 'none'].includes(stdinMode)) die('--stdin must be json|text|none');

function loadAgent() {
  if (!identityPath || !fs.existsSync(identityPath)) {
    die('--identity <path> required (JSON with privateKey + agentId), or set MOYE_IDENTITY_FILE');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  if (!identity.privateKey || !identity.agentId) {
    die('identity file needs privateKey and agentId (register via mcp/cli.js first)');
  }
  const agent = new Agent({ name: identity.name || 'bridge', baseUrl });
  agent.fromPrivateKey(identity.privateKey);
  agent.agentId = identity.agentId;
  agent.token = identity.token || null;
  if (identity.did) agent.did = identity.did;
  return agent;
}

function messageText(m) {
  if (m.decrypted != null && m.decrypted !== '') return String(m.decrypted);
  if (!m.encrypted) return String(m.content || '');
  return '';
}

function matches(m) {
  const text = messageText(m);
  const hay = [text, m.from_agent || '', m.awaiting || '', m.type || '', m.id || ''].join('\n');
  if (matchNeedle && hay.toLowerCase().includes(String(matchNeedle).toLowerCase())) return true;
  if (matchRegexSrc) {
    try {
      if (new RegExp(matchRegexSrc, 'i').test(hay)) return true;
    } catch (e) {
      die('invalid --match-regex: ' + e.message);
    }
  }
  return false;
}

function runExec(m) {
  return new Promise((resolve) => {
    const text = messageText(m);
    const payload = {
      id: m.id,
      ts: m.ts,
      room_id: roomId,
      from_agent: m.from_agent,
      type: m.type || null,
      awaiting: m.awaiting || null,
      by: m.by != null ? m.by : null,
      schema: m.schema || null,
      payload: m.payload != null ? m.payload : null,
      text,
      encrypted: !!m.encrypted,
      ref: m.ref || null,
    };
    const env = {
      ...process.env,
      MOYE_MSG_TEXT: text,
      MOYE_MSG_JSON: JSON.stringify(payload),
      MOYE_ROOM_ID: roomId,
      MOYE_MSG_ID: m.id || '',
      MOYE_FROM: m.from_agent || '',
      MOYE_MATCH: matchNeedle || matchRegexSrc || '',
      MOYE_MSG_BY: m.by != null ? String(m.by) : '',
      MOYE_MSG_SCHEMA: m.schema || '',
    };
    const child = spawn(execCmd, {
      shell: true,
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (stdinMode === 'json') child.stdin.end(JSON.stringify(payload) + '\n');
    else if (stdinMode === 'text') child.stdin.end(text);
    else child.stdin.end();
    child.on('close', (code) => {
      process.stderr.write(JSON.stringify({
        bridged: true, message_id: m.id, exit_code: code, match: matchNeedle || matchRegexSrc,
      }) + '\n');
      resolve(code);
    });
    child.on('error', (e) => {
      process.stderr.write(JSON.stringify({ bridged: false, message_id: m.id, error: e.message }) + '\n');
      resolve(1);
    });
  });
}

(async () => {
  const agent = loadAgent();
  if (secret) agent.rememberRoomSecret(roomId, secret);

  let busy = Promise.resolve();
  let stopped = false;
  let sub = null;
  let watchSince = since;

  function errPayload(e) {
    const out = { watch_error: (e && e.message) || String(e) };
    if (e && e.name) out.name = e.name;
    if (e && Array.isArray(e.errors)) {
      out.causes = e.errors.map((x) => (x && (x.message || String(x))) || String(x));
    }
    return out;
  }

  function startWatch() {
    if (stopped) return;
    if (sub) {
      try { sub.stop(); } catch { /* */ }
      sub = null;
    }
    sub = agent.watchRoom(roomId, {
      since: watchSince,
      secret: secret || undefined,
      onMessage(m) {
        if (stopped) return;
        if (m && m.ts) watchSince = Math.max(watchSince, m.ts);
        if (!matches(m)) {
          process.stderr.write(JSON.stringify({ skipped: true, message_id: m.id }) + '\n');
          return;
        }
        busy = busy.then(async () => {
          if (stopped) return;
          await runExec(m);
          if (once) {
            stopped = true;
            if (sub) sub.stop();
            process.exit(0);
          }
        });
      },
      onError(e) {
        process.stderr.write(JSON.stringify(errPayload(e)) + '\n');
      },
      onReconnect({ cursor, backoff_ms }) {
        if (cursor) watchSince = Math.max(watchSince, cursor);
        process.stderr.write(JSON.stringify({ reconnect: true, cursor, backoff_ms: backoff_ms || null }) + '\n');
      },
    });
  }

  startWatch();

  // Safety net: native/undici WebSocket AggregateError (and similar) can bypass the socket
  // 'error' event and kill the process. Log + restart the watch loop instead of exiting.
  function survive(kind, err) {
    if (stopped) return;
    process.stderr.write(JSON.stringify({
      bridge_safety_net: kind,
      ...errPayload(err),
      action: 'restart_watch',
      cursor: watchSince,
    }) + '\n');
    try { startWatch(); } catch (e) {
      process.stderr.write(JSON.stringify({ bridge_restart_failed: e.message || String(e) }) + '\n');
    }
  }
  process.on('uncaughtException', (err) => survive('uncaughtException', err));
  process.on('unhandledRejection', (err) => survive('unhandledRejection', err));

  process.stderr.write(JSON.stringify({
    listening: true,
    room_id: roomId,
    agent_id: agent.agentId,
    match: matchNeedle || null,
    match_regex: matchRegexSrc || null,
    since,
    ws_impl: (process.env.MOYE_WS_IMPL || 'ws-preferred'),
    caveat: 'notification→exec only; agent runtime wake is outside MOYE',
  }) + '\n');

  const stop = () => { stopped = true; if (sub) sub.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => die(e.message || String(e)));
