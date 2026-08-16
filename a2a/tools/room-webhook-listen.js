#!/usr/bin/env node
'use strict';
/**
 * Reference HTTP receiver for an agent that already has (or deploys) public HTTPS.
 * Set THAT agent's webhook_url to this process. Not a shared MOYE inbox; not an
 * end-user tunnel wizard. Humans on moye.ai never run this.
 *
 *   node room-webhook-listen.js --runtime cursor,claude --port 8788 --reply
 *
 * Verifies X-Moye-Sig against GET {base}/api/node/identity unless MOYE_WEBHOOK_TRUST=1.
 */
const http = require('http');
const { Agent } = require('../sdk/node/moye-agent-sdk');
const { parseRuntimes, runRuntimes, formatReply } = require('./lib/room-runtime');

function flag(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return (i !== -1 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes('--' + name); }

const port = parseInt(flag('port', process.env.PORT || '8788'), 10);
const baseUrl = (flag('base-url', process.env.MOYE_BASE_URL || 'https://moye.ai/a2a')).replace(/\/$/, '');
const matchNeedle = flag('match', process.env.MOYE_WEBHOOK_MATCH || '');
const reply = hasFlag('reply') || process.env.MOYE_RUNTIME_REPLY === '1';
let names;
try { names = parseRuntimes(flag('runtime', process.env.MOYE_RUNTIME || 'cursor')); }
catch (e) {
  console.error(e.message);
  process.exit(1);
}

let nodePub = null;
async function nodePubkey() {
  if (process.env.MOYE_WEBHOOK_TRUST === '1') return null;
  if (nodePub) return nodePub;
  const rec = await (await fetch(baseUrl + '/api/node/identity')).json();
  nodePub = rec.pubkey || rec.public_key || rec.node_pubkey;
  if (!nodePub) throw new Error('no pubkey on /api/node/identity');
  return nodePub;
}

function matches(text, from) {
  if (!matchNeedle) return true;
  const hay = (text + '\n' + (from || '')).toLowerCase();
  return hay.includes(String(matchNeedle).toLowerCase());
}

function loadIdentityAgent(roomId) {
  const fs = require('fs');
  const identity = JSON.parse(fs.readFileSync(process.env.MOYE_IDENTITY_FILE, 'utf8'));
  const agent = new Agent({ name: identity.name || 'webhook-listen', baseUrl });
  agent.fromPrivateKey(identity.privateKey);
  agent.agentId = identity.agentId;
  agent.token = identity.token || null;
  if (roomId && process.env.MOYE_ROOM_SECRET) agent.rememberRoomSecret(roomId, process.env.MOYE_ROOM_SECRET);
  return { agent, identity };
}

async function verifyPush(body, sig) {
  if (!body || (body.event !== 'room_message' && body.event !== 'message')) {
    return { skipped: true, reason: 'event' };
  }
  if (process.env.MOYE_WEBHOOK_TRUST !== '1') {
    const pub = await nodePubkey();
    if (!Agent.verifyWebhookPush(pub, body, sig)) return { error: 'bad_sig', status: 401 };
  }
  return { ok: true };
}

async function plaintextFromPush(body) {
  const roomId = body.room_id || '';
  if (!body.encrypted) return { text: body.content == null ? '' : String(body.content) };
  if (!process.env.MOYE_ROOM_SECRET || !process.env.MOYE_IDENTITY_FILE || !roomId) {
    return { skip: 'encrypted_no_secret' };
  }
  const { agent } = loadIdentityAgent(roomId);
  let cipher = body.content;
  if (body.content_omitted || cipher == null || cipher === '') {
    const msgs = await agent.roomMessages(roomId, 200);
    const found = (msgs || []).find((m) => m.id === body.id);
    if (!found) return { skip: 'catchup_miss' };
    if (found.decrypted) return { text: found.decrypted };
    cipher = found.content;
  }
  const text = agent._decryptRoomContent(roomId, cipher);
  if (!text) return { skip: 'decrypt_failed' };
  return { text };
}

async function handleBody(body) {
  const from = body.from_agent || '';
  const roomId = body.room_id || '';
  const got = await plaintextFromPush(body);
  if (got.skip) return { skipped: true, reason: got.skip };
  const text = got.text;
  if (!matches(text, from)) return { skipped: true, reason: 'match' };
  const results = await runRuntimes(names, {
    text, roomId, msgId: body.id || '', from,
  });
  if (reply && roomId && process.env.MOYE_IDENTITY_FILE) {
    const { agent, identity } = loadIdentityAgent(roomId);
    if (from !== identity.agentId) {
      await agent.sendRoomMessage(roomId, formatReply(results));
    }
  }
  return { ok: true, results };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runtimes: names }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch {
      res.writeHead(400);
      res.end('{"error":"json"}');
      return;
    }
    const sig = req.headers['x-moye-sig'];
    try {
      const gate = await verifyPush(body, sig);
      if (gate.error) {
        res.writeHead(gate.status || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(gate));
        return;
      }
      if (gate.skipped) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(gate));
        return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      handleBody(body).then((out) => {
        if (out && out.skipped) process.stderr.write(JSON.stringify(out) + '\n');
      }).catch((e) => {
        process.stderr.write(JSON.stringify({ error: e.message || String(e) }) + '\n');
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
  });
});

server.listen(port, () => {
  process.stderr.write(JSON.stringify({
    listening: true, port, runtimes: names, reply, baseUrl,
    note: 'this agent’s webhook_url must be a public HTTPS URL the node can POST to',
  }) + '\n');
});
