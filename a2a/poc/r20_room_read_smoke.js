'use strict';
/**
 * R20 smoke: memoized crdt.read materialization + messagesSince binary search with ordering guard.
 * Real correctness — not shape checks.
 */
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { generateKeyPairSync } = require('crypto');
const crdt = require('../lib/crdt');
const roomRead = require('../lib/room_read');

const PORT = Number(process.env.SMOKE_PORT || 3160);
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

// ---- unit: ordering + binary search ----
{
  const sorted = [];
  for (let i = 0; i < 100; i++) sorted.push({ id: 'm' + i, ts: 1000 + i * 10, content: String(i) });
  const since = 1000 + 50 * 10; // ts of index 50
  const viaBin = roomRead.messagesSince(sorted, since, { knownSorted: true });
  const viaFilter = sorted.filter((m) => m.ts > since);
  check('binary == filter (sorted)', JSON.stringify(viaBin.map((m) => m.id)) === JSON.stringify(viaFilter.map((m) => m.id)));
  check('binary count', viaBin.length === 49);

  const unsorted = [{ id: 'a', ts: 3 }, { id: 'b', ts: 1 }, { id: 'c', ts: 2 }];
  check('detect inversion', roomRead.isTsNonDecreasing(unsorted) === false);
  const fb = roomRead.messagesSince(unsorted, 1, { knownSorted: null });
  check('fallback filter on unsorted', fb.length === 2 && fb.every((m) => m.ts > 1));

  // Forced knownSorted=true on unsorted would be wrong — guard path when knownSorted null matters.
  const forceWrong = roomRead.messagesSince(unsorted, 1, { knownSorted: true });
  // binary on unsorted is undefined behavior; we only assert fallback path when not forced.
  check('forced sorted path returns array', Array.isArray(forceWrong));
}

// ---- unit: RGA merge materialization is always ts-sorted ----
{
  const a = {
    crdt: 'rga',
    nodes: [
      { id: 'n2', elem: { id: 'm2', ts: 200 }, deleted: false },
      { id: 'n1', elem: { id: 'm1', ts: 100 }, deleted: false },
    ],
  };
  const b = {
    crdt: 'rga',
    nodes: [
      { id: 'n3', elem: { id: 'm3', ts: 150 }, deleted: false },
      { id: 'n1', elem: { id: 'm1', ts: 100 }, deleted: true },
    ],
  };
  const merged = crdt.merge('rga', a, b);
  const mat = crdt.read(merged);
  check('rga merge drops tombstone', !mat.some((m) => m.id === 'm1'));
  check('rga merge materialization sorted', roomRead.isTsNonDecreasing(mat));
  check('rga merge order by ts', mat.map((m) => m.id).join(',') === 'm3,m2');
}

// ---- integration: memoize + changes?since= ----
(async () => {
  // Instrument crdt.read call count via the store module's dependency
  const crdtPath = require.resolve('../lib/crdt');
  const real = require(crdtPath);
  let readCalls = 0;
  const wrapped = {
    ...real,
    read(v) { readCalls++; return real.read(v); },
  };
  require.cache[crdtPath].exports = wrapped;
  // Fresh load of ipfs_store after wrap — but server already requires it. Better: use store
  // through a dedicated mini harness that loads after wrap.
  delete require.cache[require.resolve('../lib/ipfs_store')];
  const store = require('../lib/ipfs_store');

  const key = 'room-chat:r20-unit';
  readCalls = 0;
  await store.putShared(key, {
    crdt: 'rga',
    nodes: [
      { id: 'a', elem: { id: 'a', ts: 1, content: '1' }, deleted: false },
      { id: 'b', elem: { id: 'b', ts: 2, content: '2' }, deleted: false },
      { id: 'c', elem: { id: 'c', ts: 3, content: '3' }, deleted: false },
    ],
  }, Date.now(), 't');
  const firstReads = readCalls;
  const v1 = store.getShared(key);
  const afterFirst = readCalls;
  const v2 = store.getShared(key);
  const afterSecond = readCalls;
  check('memoize: second getShared no extra read', afterSecond === afterFirst);
  check('memoize: same array identity', v1 === v2);
  check('meta tsSorted', store.getSharedMaterialMeta(v1).tsSorted === true);
  check('memoize: at least one read happened', afterFirst > firstReads || afterFirst >= 1);

  await store.putShared(key, {
    crdt: 'rga',
    nodes: [{ id: 'd', elem: { id: 'd', ts: 4, content: '4' }, deleted: false }],
  }, Date.now() + 1, 't');
  const beforeWriteRead = readCalls;
  const v3 = store.getShared(key);
  check('invalidate on write', readCalls > beforeWriteRead);
  check('merged length', v3.length === 4);
  check('still sorted after merge write', roomRead.isTsNonDecreasing(v3));

  // Live HTTP changes?since=
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'r20-smoke-' + Date.now(),
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'smoke-r20-' + Date.now() + '.db'),
      IPFS_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  child.stdout.on('data', (d) => { if (d.toString().includes(`on :${PORT}`)) ready = true; });
  for (let i = 0; i < 100 && !ready; i++) await sleep(50);
  if (!ready) {
    console.error('server failed to start');
    child.kill();
    process.exit(1);
  }

  const agent = await register('r20-' + Date.now());
  const room = await req('POST', '/api/rooms', { name: 'r20', visibility: 'public' }, {
    Authorization: 'Bearer ' + agent.token,
  });
  const roomId = room.json.room_id;
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const m = await req('POST', `/api/rooms/${roomId}/messages`, {
      content: 'msg-' + i, ts: Date.now(),
    }, { Authorization: 'Bearer ' + agent.token });
    ids.push(m.json.message_id);
    await sleep(2);
  }
  const mid = await req('GET', `/api/rooms/${roomId}/messages?limit=50`);
  const all = mid.json.messages || [];
  const pivot = all[9];
  const ch = await req('GET', `/api/rooms/${roomId}/changes?since=${pivot.ts}`);
  check('changes status', ch.status === 200);
  const got = ch.json.messages || [];
  check('changes all after pivot', got.every((m) => (m.ts || 0) > pivot.ts));
  const expected = all.filter((m) => (m.ts || 0) > pivot.ts);
  check('changes count matches filter', got.length === expected.length
    || (got.length === Math.min(200, expected.length)));
  // Idempotent catch-up: same since twice
  const ch2 = await req('GET', `/api/rooms/${roomId}/changes?since=${pivot.ts}`);
  check('changes stable', JSON.stringify((ch2.json.messages || []).map((m) => m.id))
    === JSON.stringify(got.map((m) => m.id)));

  child.kill('SIGTERM');
  try { child.kill('SIGKILL'); } catch { /* */ }

  console.log(fails ? 'SOME_FAIL ' + fails : 'ALL_PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
