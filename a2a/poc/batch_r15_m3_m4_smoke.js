'use strict';
/**
 * Batch smoke: R15 staleness, R16 consolidate, R17 pin API (local), M4 dual MCP
 * (legacy initialize + server/discover), M3 room_awaiting → input_required.
 */
const { spawn } = require('child_process');
const http = require('http');
const { generateKeyPairSync } = require('crypto');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = Number(process.env.SMOKE_PORT || 3145);
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* */ }
        resolve({ status: res.statusCode, headers: res.headers, body: b, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function register(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const r = await req('POST', '/api/agents', {
    name, capabilities: ['test'], pubkey: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  if (!r.json || !r.json.agent_id) throw new Error('register failed: ' + r.body);
  return {
    ...r.json,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

(async () => {
  let fails = 0;
  const check = (name, cond) => {
    console.log(cond ? 'OK' : 'FAIL', name);
    if (!cond) fails++;
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'batch-smoke-' + Date.now(),
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'smoke-batch-' + Date.now() + '.db'),
      IPFS_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  child.stdout.on('data', (d) => { if (d.toString().includes(`on :${PORT}`)) ready = true; });
  child.stderr.on('data', () => {});
  for (let i = 0; i < 100 && !ready; i++) await sleep(50);
  if (!ready) { console.error('server failed to start'); child.kill(); process.exit(1); }

  const a = await register('batch-a-' + Date.now());
  const b = await register('batch-b-' + Date.now());
  const room = await req('POST', '/api/rooms', {
    name: 'batch-room', visibility: 'public',
  }, { Authorization: 'Bearer ' + a.token });
  const roomId = room.json.room_id;
  check('room', !!roomId);
  const joinB = await req('POST', `/api/rooms/${roomId}/join`, { ts: Date.now() }, {
    Authorization: 'Bearer ' + b.token,
  });
  check('b joined', joinB.status === 200);

  // R15: write state, post messages, staleness tracks lag
  const st0 = await req('POST', `/api/rooms/${roomId}/state`, {
    summary: 'initial', decisions: [], open_questions: [], ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  check('state write', st0.status === 200 && st0.json.staleness && st0.json.staleness.messages_since_update === 0);

  await req('POST', `/api/rooms/${roomId}/messages`, {
    content: 'msg1', ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  await sleep(20);
  await req('POST', `/api/rooms/${roomId}/messages`, {
    content: 'msg2', ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });

  const st1 = await req('GET', `/api/rooms/${roomId}/state`, null, {
    Authorization: 'Bearer ' + a.token,
  });
  const lag = st1.json && st1.json.staleness && st1.json.staleness.messages_since_update;
  check('R15 lag tracks messages', lag === 2);

  // R16: two consolidations stay visible
  const c1 = await req('POST', `/api/rooms/${roomId}/consolidate`, {
    summary: 'proposal A', checkpoint_seq: 1, ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  const c2 = await req('POST', `/api/rooms/${roomId}/consolidate`, {
    summary: 'proposal B', checkpoint_seq: 2, ts: Date.now(),
  }, { Authorization: 'Bearer ' + b.token });
  if (c1.status !== 200 || c2.status !== 200) {
    console.log('R16 debug', c1.status, c1.body, c2.status, c2.body);
  }
  check('R16 any member', c1.status === 200 && c2.status === 200);
  const st2 = await req('GET', `/api/rooms/${roomId}/state`);
  const props = (st2.json.state && st2.json.state.consolidation_proposals) || [];
  check('R16 proposals visible', props.length >= 2
    && props.some((p) => p.summary === 'proposal A')
    && props.some((p) => p.summary === 'proposal B'));

  // R17: SDK pin default OFF
  const sdk = new Agent({ name: 'pinbot', baseUrl: BASE, agentId: a.agent_id, token: a.token });
  sdk.fromPrivateKey(a.privateKeyPem);
  let pinThrew = false;
  try { await sdk.pinRoomCiphertext(roomId); } catch { pinThrew = true; }
  check('R17 default OFF', pinThrew === true);
  sdk.enableRoomPinning(roomId, { on: true });
  // No encrypted attachments yet — newly_pinned empty but list works
  const pinRes = await sdk.pinRoomCiphertext(roomId);
  check('R17 list visible', Array.isArray(pinRes.newly_pinned) && sdk.listPinnedCids(roomId)[roomId].enabled);
  sdk.enableRoomPinning(roomId, { on: false });
  check('R17 can disable', !sdk.listPinnedCids(roomId)[roomId]);

  // M4 legacy initialize
  const init = await req('POST', `/mcp/rooms/${roomId}`, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy' } },
  }, { Authorization: 'Bearer ' + a.token });
  check('M4 legacy initialize', init.status === 200 && init.json.result
    && (init.json.result.protocolVersion || init.json.result.resultType));

  // M4 server/discover via Mcp-Method header
  const disc = await req('POST', `/mcp/rooms/${roomId}`, {
    jsonrpc: '2.0', id: 2,
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  }, {
    Authorization: 'Bearer ' + a.token,
    'Mcp-Method': 'server/discover',
  });
  const dres = disc.json && disc.json.result;
  check('M4 server/discover', disc.status === 200 && dres
    && (dres.serverInfo || dres.capabilities || dres.resultType === 'complete'));
  const ext = dres && dres.capabilities && dres.capabilities.extensions;
  check('M5 ai.moye/room', !!(ext && (ext['ai.moye/room'] || ext['ai.moye'])));

  // tools/list ttlMs
  const tools = await req('POST', `/mcp/rooms/${roomId}`, {
    jsonrpc: '2.0', id: 3, method: 'tools/list', params: {},
  }, { Authorization: 'Bearer ' + a.token });
  const tres = tools.json && tools.json.result;
  check('M4 ttlMs', tres && typeof tres.ttlMs === 'number' && tres.cacheScope);

  // M3: ask + room_awaiting → input_required
  const ask = await req('POST', `/api/rooms/${roomId}/messages`, {
    content: 'need your input', type: 'ask', awaiting: b.agent_id, ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  check('ask posted', ask.status === 200 && ask.json.message_id);

  const awaitRpc = await req('POST', `/mcp/rooms/${roomId}`, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'room_awaiting', arguments: {} },
  }, { Authorization: 'Bearer ' + b.token });
  const ares = awaitRpc.json && awaitRpc.json.result;
  check('M3 input_required', ares && ares.resultType === 'input_required'
    && Array.isArray(ares.inputRequests) && ares.inputRequests.length === 1);

  const resolveVia = await req('POST', `/mcp/rooms/${roomId}`, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: {
      name: 'room_awaiting',
      arguments: {
        inputResponses: {
          [ask.json.message_id]: { content: 'done via MRTR' },
        },
      },
    },
  }, { Authorization: 'Bearer ' + b.token });
  check('M3 inputResponses resolve', resolveVia.status === 200
    && resolveVia.json.result && resolveVia.json.result.resultType === 'complete');

  const open = await req('GET', `/api/rooms/${roomId}/awaiting/${b.agent_id}`);
  const still = (open.json.awaiting || []).some((m) => m.id === ask.json.message_id);
  check('M3 ask cleared', !still);

  child.kill('SIGTERM');
  try { child.kill('SIGKILL'); } catch { /* */ }
  console.log(fails ? 'SOME_FAIL ' + fails : 'ALL_PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
