'use strict';
/**
 * ADR-0038 M8–M11 smoke: profile_sig, webhook X-Moye-Sig, MCP prompts prefill, resources ACL.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');
const agentProfile = require('../lib/agent_profile');
const webhookSig = require('../lib/webhook_sig');

const PORT = 3168;
const BASE = `http://127.0.0.1:${PORT}`;
const WH_PORT = 3169;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function mcp(agent, roomId, method, params, id = 1) {
  const body = { jsonrpc: '2.0', id, method };
  if (params !== undefined) body.params = params;
  const headers = {
    'Content-Type': 'application/json',
    ...agent._headers(agent._didHeaders(body)),
  };
  const res = await fetch(`${BASE}/mcp/rooms/${roomId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

(async () => {
  const received = [];
  const whServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => whServer.listen(WH_PORT, '127.0.0.1', r));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      ALLOW_PRIVATE_WEBHOOKS: '1',
      NODE_ID: 'adr0038-m8-m11',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'adr0038-m8-m11-smoke.db'),
      PUBLIC_ENDPOINT: BASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* */ }
      await sleep(100);
      if (i === 49) throw new Error('boot failed: ' + boot.slice(-400));
    }

    const net = await (await fetch(BASE + '/.well-known/moye-net')).json();
    assert((net.features || []).includes('agent-profile-sig'), 'feature agent-profile-sig');
    assert((net.features || []).includes('webhook-sig'), 'feature webhook-sig');
    assert((net.features || []).includes('room-mcp-prompts'), 'feature room-mcp-prompts');
    assert((net.features || []).includes('room-mcp-resources'), 'feature room-mcp-resources');

    // ---- M8 profile_sig ----
    const a = new Agent({
      name: 'm8-bot',
      capabilities: ['smoke'],
      description: 'profile signing',
      endpoint: 'https://example.invalid/agent',
      webhookUrl: `http://127.0.0.1:${WH_PORT}/hook`,
      baseUrl: BASE,
    });
    a.generateIdentity();
    await a.register();
    const got = await a.profile();
    assert(got.profile_sig, 'profile_sig stored');
    assert(Agent.verifyAgentProfile(got) === true, 'untampered profile verifies');
    const tampered = { ...got, capabilities: ['hijacked'] };
    assert(Agent.verifyAgentProfile(tampered) === false, 'tampered capabilities fail');
    assert(agentProfile.verifyProfile(got.pubkey, {
      name: got.name, description: 'nope', capabilities: got.capabilities,
      endpoint: got.endpoint, webhook_url: got.webhook_url,
    }, got.profile_sig) === false, 'tampered description fails');

    // ---- M9 webhook sig ----
    const peer = new Agent({ name: 'm9-peer', capabilities: ['ping'], baseUrl: BASE });
    peer.generateIdentity();
    await peer.register();
    await peer.send(a.agentId, 'hello-webhook');
    for (let i = 0; i < 40 && !received.length; i++) await sleep(50);
    assert(received.length >= 1, 'webhook delivered');
    const hit = received[0];
    assert(hit.headers['x-moye-sig'], 'X-Moye-Sig present');
    const nodeId = await (await fetch(BASE + '/api/node/identity')).json();
    const nodePub = nodeId.pubkey;
    assert(nodePub, 'node pubkey');
    assert(webhookSig.verifyWebhook(nodePub, hit.body, hit.headers['x-moye-sig']) === true, 'webhook verifies');
    const badBody = { ...hit.body, content: 'forged' };
    // content_hash in body was computed at send time — forging content alone may still verify if
    // verifier uses content_hash field when present. Force mismatch by altering content_hash.
    badBody.content_hash = '0'.repeat(64);
    assert(webhookSig.verifyWebhook(nodePub, badBody, hit.headers['x-moye-sig']) === false, 'tampered webhook fails');

    // ---- M10 / M11 public room ----
    const room = await a.createRoom('adr0038-pub');
    await a.sendRoomMessage(room.room_id, 'hello resource');
    const disc = await mcp(a, room.room_id, 'server/discover');
    assert(disc.json.result.capabilities.prompts, 'prompts capability');
    assert(disc.json.result.capabilities.resources, 'resources capability');

    const pl = await mcp(a, room.room_id, 'prompts/list');
    const names = (pl.json.result.prompts || []).map((p) => p.name).sort();
    assert(names.includes('join') && names.includes('room_listen'), 'prompt names');

    const pg = await mcp(a, room.room_id, 'prompts/get', { name: 'room_listen' });
    const text = pg.json.result.messages[0].content.text;
    assert(text.includes(a.agentId), 'prefilled agent_id');
    assert(!text.includes('{{agent_id}}'), 'no literal placeholder');
    assert(text.includes(room.room_id), 'prefilled room_id');

    const rl = await mcp(a, room.room_id, 'resources/list');
    const uris = (rl.json.result.resources || []).map((r) => r.uri);
    assert(uris.some((u) => u.endsWith('/history')), 'history resource');
    assert(uris.some((u) => u.includes('/message/')), 'message resource');

    const histUri = `moye://room/${room.room_id}/history`;
    const rr = await mcp(a, room.room_id, 'resources/read', { uri: histUri });
    assert(rr.json.result.contents && rr.json.result.contents[0].text.includes('hello resource'), 'history read');

    // ---- M11 private room non-member deny ----
    const priv = await a.createRoom('adr0038-priv', { visibility: 'private' });
    await a.sendRoomMessage(priv.room_id, 'secret-msg');

    const stranger = new Agent({ name: 'stranger', capabilities: ['x'], baseUrl: BASE });
    stranger.generateIdentity();
    await stranger.register();

    const denied = await mcp(stranger, priv.room_id, 'resources/read', {
      uri: `moye://room/${priv.room_id}/history`,
    });
    assert(denied.status === 403 || (denied.json.error && /member|private/i.test(denied.json.error.message || '')),
      'non-member resources/read denied: ' + JSON.stringify(denied.json).slice(0, 200));

    // Member can read (wire ciphertext)
    const okRead = await mcp(a, priv.room_id, 'resources/list');
    assert(okRead.json.result && Array.isArray(okRead.json.result.resources), 'member resources/list');

    console.log('ADR0038_M8_M11_ALL_PASS');
  } finally {
    child.kill('SIGTERM');
    whServer.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
