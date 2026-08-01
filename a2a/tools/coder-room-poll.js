#!/usr/bin/env node
'use strict';
/**
 * Room poll fallback for coder: changes?since= every CODER_ROOM_POLL_SEC (default 45).
 * Complements WS push (server excludes the sender from room_message push — ADR/server.js —
 * and WS can drop). Writes the same inbox files as coder-inbox-write.js.
 * Emits AGENT_CODER_INBOX_HIT on stdout when a match is stored.
 */
const fs = require('fs');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const ROOT = path.join(__dirname, '..');
const room = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/mission/identities/room.json'), 'utf8'));
const identity = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/mission/identities/coder-bridge-identity.json'), 'utf8'));
const inboxDir = path.join(ROOT, 'docs/mission/inbox');
const cursorFile = path.join(inboxDir, 'room-cursor.txt');
const intervalMs = Math.max(10, parseInt(process.env.CODER_ROOM_POLL_SEC || '45', 10)) * 1000;
const matchRe = new RegExp(process.env.CODER_MATCH_REGEX || 'coder|@coder|To: coder|ag_a8b63e5a8359', 'i');

fs.mkdirSync(inboxDir, { recursive: true });

const agent = new Agent({ name: identity.name || 'coder_bridge', baseUrl: 'https://moye.ai/a2a', agentId: identity.agentId });
agent.fromPrivateKey(identity.privateKey);
if (identity.did) agent.did = identity.did;
agent.rememberRoomSecret(room.room_id, room.membership_secret);

function loadCursor() {
  try {
    const n = parseInt(fs.readFileSync(cursorFile, 'utf8').trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* */ }
  return Date.now() - 60_000;
}

function saveCursor(ts) {
  fs.writeFileSync(cursorFile, String(ts) + '\n');
}

function textOf(m) {
  if (m.decrypted != null && m.decrypted !== '') return String(m.decrypted);
  if (m.encrypted && m.content) {
    try {
      return agent._decryptFromRoom(agent._roomKey(room.membership_secret, room.room_id), m.content);
    } catch { return ''; }
  }
  return String(m.content || '');
}

function matches(m, text) {
  const hay = [text, m.from_agent || '', m.awaiting || '', m.type || '', m.id || ''].join('\n');
  return matchRe.test(hay);
}

function writeInbox(m, text) {
  const obj = {
    id: m.id,
    ts: m.ts,
    room_id: room.room_id,
    from_agent: m.from_agent,
    type: m.type || null,
    awaiting: m.awaiting || null,
    by: m.by != null ? m.by : null,
    schema: m.schema || null,
    payload: m.payload != null ? m.payload : null,
    text,
    encrypted: !!m.encrypted,
    _received_at: Date.now(),
    _source: 'room-poll',
  };
  fs.writeFileSync(path.join(inboxDir, 'coder-last.json'), JSON.stringify(obj, null, 2) + '\n');
  fs.appendFileSync(path.join(inboxDir, 'coder.log'), JSON.stringify(obj) + '\n');
  process.stdout.write('AGENT_CODER_INBOX_HIT ' + JSON.stringify({ source: 'room-poll', id: m.id }) + '\n');
}

async function tick() {
  let since = loadCursor();
  const ch = await agent.roomChanges(room.room_id, since);
  const msgs = Array.isArray(ch.messages) ? ch.messages
    : (Array.isArray(ch.new_messages) ? ch.new_messages : []);
  let maxTs = since;
  for (const m of msgs) {
    if (m.ts && m.ts > maxTs) maxTs = m.ts;
    const text = textOf(m);
    if (matches(m, text)) writeInbox(m, text);
  }
  if (maxTs > since) saveCursor(maxTs);
}

(async () => {
  process.stderr.write(JSON.stringify({
    room_poll: true, room_id: room.room_id, interval_ms: intervalMs, agent_id: agent.agentId,
  }) + '\n');
  for (;;) {
    try { await tick(); }
    catch (e) { process.stderr.write(JSON.stringify({ room_poll_error: String(e.message || e) }) + '\n'); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
})();
