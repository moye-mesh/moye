'use strict';
/**
 * R21/R22 smoke: cross-room catchup + overdue flip when ask.by passes.
 */
const { spawn } = require('child_process');
const http = require('http');
const { generateKeyPairSync } = require('crypto');
const path = require('path');
const roomAwaiting = require('../lib/room_awaiting');

const PORT = Number(process.env.SMOKE_PORT || 3162);
let fails = 0;
function check(name, cond) {
  console.log(cond ? 'OK' : 'FAIL', name);
  if (!cond) fails++;
}
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
        resolve({ status: res.statusCode, json: j, body: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function register(name) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const r = await req('POST', '/api/agents', {
    name, capabilities: ['test'], pubkey: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  if (!r.json || !r.json.agent_id) throw new Error('register failed: ' + r.body);
  return r.json;
}

// Unit: annotateDeadline
{
  const now = 1_000_000;
  const future = roomAwaiting.annotateDeadline({ id: 'a', by: now + 5000 }, now);
  check('not overdue before by', future.overdue === false && future.due_in_ms === 5000);
  const past = roomAwaiting.annotateDeadline({ id: 'b', by: now - 1 }, now);
  check('overdue after by', past.overdue === true && past.due_in_ms === -1);
  const none = roomAwaiting.annotateDeadline({ id: 'c' }, now);
  check('no by → not overdue', none.overdue === false && none.due_in_ms === null);
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'r21-smoke-' + Date.now(),
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'smoke-r21-' + Date.now() + '.db'),
      IPFS_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  child.stdout.on('data', (d) => { if (d.toString().includes(`on :${PORT}`)) ready = true; });
  for (let i = 0; i < 100 && !ready; i++) await sleep(50);
  if (!ready) { console.error('server failed'); child.kill(); process.exit(1); }

  const a = await register('r21-a-' + Date.now());
  const b = await register('r21-b-' + Date.now());
  const room1 = await req('POST', '/api/rooms', { name: 'r21-1', visibility: 'public' }, {
    Authorization: 'Bearer ' + a.token,
  });
  const room2 = await req('POST', '/api/rooms', { name: 'r21-2', visibility: 'public' }, {
    Authorization: 'Bearer ' + a.token,
  });
  const r1 = room1.json.room_id;
  const r2 = room2.json.room_id;
  await req('POST', `/api/rooms/${r1}/join`, { ts: Date.now() }, { Authorization: 'Bearer ' + b.token });
  await req('POST', `/api/rooms/${r2}/join`, { ts: Date.now() }, { Authorization: 'Bearer ' + b.token });

  const t0 = Date.now();
  await req('POST', `/api/rooms/${r1}/messages`, {
    content: 'hello-1', ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  await sleep(5);
  await req('POST', `/api/rooms/${r2}/messages`, {
    content: 'hello-2', ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });

  // Ask with by just ahead of now — not overdue yet
  const bySoon = Date.now() + 800;
  const ask = await req('POST', `/api/rooms/${r1}/messages`, {
    content: 'please reply', type: 'ask', awaiting: b.agent_id, by: bySoon, ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  check('ask posted', ask.status === 200 && ask.json.message_id);

  const aw0 = await req('GET', `/api/agents/${b.agent_id}/awaiting`);
  const item0 = (aw0.json.awaiting || []).find((x) => x.ask && x.ask.id === ask.json.message_id);
  check('awaiting has ask', !!item0);
  check('not overdue yet', item0 && item0.ask.overdue === false && typeof item0.ask.due_in_ms === 'number');

  const cu0 = await req('GET', `/api/agents/${b.agent_id}/catchup?since=${t0 - 1}`, null, {
    Authorization: 'Bearer ' + b.token,
  });
  check('catchup auth ok', cu0.status === 200);
  check('catchup next_cursor present', cu0.json.next_cursor != null);
  check('catchup rooms_delta spans rooms', (cu0.json.rooms_delta || []).length >= 1);
  check('catchup awaiting includes ask', (cu0.json.awaiting || []).some((x) => x.ask && x.ask.id === ask.json.message_id));
  check('catchup overdue empty before by', (cu0.json.overdue || []).length === 0
    || !(cu0.json.overdue || []).some((x) => x.ask && x.ask.id === ask.json.message_id));

  // Stranger cannot catchup as b
  const denied = await req('GET', `/api/agents/${b.agent_id}/catchup?since=0`, null, {
    Authorization: 'Bearer ' + a.token,
  });
  check('catchup self-only', denied.status === 403);

  // Wait until by passes — R22 must flip
  const waitMs = Math.max(0, bySoon - Date.now()) + 50;
  await sleep(waitMs);

  const aw1 = await req('GET', `/api/agents/${b.agent_id}/awaiting`);
  const item1 = (aw1.json.awaiting || []).find((x) => x.ask && x.ask.id === ask.json.message_id);
  check('R22 flips to overdue', item1 && item1.ask.overdue === true && item1.ask.due_in_ms < 0);
  check('awaiting.overdue list', (aw1.json.overdue || []).some((x) => x.ask && x.ask.id === ask.json.message_id));

  const cu1 = await req('GET', `/api/agents/${b.agent_id}/catchup?since=${cu0.json.next_cursor}`, null, {
    Authorization: 'Bearer ' + b.token,
  });
  check('catchup overdue after by', (cu1.json.overdue || []).some((x) => x.ask && x.ask.id === ask.json.message_id));
  check('next_cursor monotonic', cu1.json.next_cursor >= cu0.json.next_cursor);

  // MCP room_catchup
  const mcp = await req('POST', `/mcp/rooms/${r1}`, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'room_catchup', arguments: { since: t0 - 1 } },
  }, { Authorization: 'Bearer ' + b.token });
  const text = mcp.json && mcp.json.result && mcp.json.result.content
    && mcp.json.result.content[0] && mcp.json.result.content[0].text;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* */ }
  check('MCP room_catchup', mcp.status === 200 && parsed && parsed.next_cursor != null
    && Array.isArray(parsed.awaiting));

  child.kill('SIGTERM');
  try { child.kill('SIGKILL'); } catch { /* */ }
  console.log(fails ? 'SOME_FAIL ' + fails : 'ALL_PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
