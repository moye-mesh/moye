'use strict';
// P3-6: federation agent-record LWW (lamport + home_node), not insert-only.
// Reproduces ops's diagnosis on a 2-node local pair, then verifies the update lands.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT_A = 3151;
const PORT_B = 3152;
const FED = 'p36-fed-secret-test-only';
const DATA = path.join(__dirname, '..', 'data');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(b); } catch { j = { raw: b }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(b); } catch { j = { raw: b }; }
        resolve({ status: res.statusCode, body: j });
      });
    }).on('error', reject);
  });
}

function spawnNode(nodeId, port, peerLine, dbName) {
  const dbFile = path.join(DATA, dbName);
  try { fs.unlinkSync(dbFile); } catch { /* */ }
  try { fs.unlinkSync(dbFile + '-wal'); } catch { /* */ }
  try { fs.unlinkSync(dbFile + '-shm'); } catch { /* */ }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      FED_SECRET: FED,
      NODE_ID: nodeId,
      PORT: String(port),
      PEERS: peerLine,
      PUBLIC_ENDPOINT: `http://127.0.0.1:${port}`,
      DB_FILE: dbFile,
      ENABLE_FIREHOSE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });
  child._boot = () => boot;
  return child;
}

async function waitHealth(port, child) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await get(port, '/health');
      if (r.status === 200) return;
    } catch { /* */ }
    await sleep(100);
  }
  throw new Error('boot failed on :' + port + ' ' + (child._boot() || '').slice(-500));
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const nodeA = spawnNode('p36-a', PORT_A, `p36-b=http://127.0.0.1:${PORT_B}`, 'p36-a.db');
  const nodeB = spawnNode('p36-b', PORT_B, `p36-a=http://127.0.0.1:${PORT_A}`, 'p36-b.db');
  const kill = () => { try { nodeA.kill(); } catch { /* */ } try { nodeB.kill(); } catch { /* */ } };
  process.on('exit', kill);

  try {
    await waitHealth(PORT_A, nodeA);
    await waitHealth(PORT_B, nodeB);
    console.log('BOOT_OK');

    const agentId = 'ag_p36_stale_test';
    const home = 'p36-a';
    // 1) Inject incomplete copy onto B (simulates first sync without pubkey)
    const stale = {
      id: agentId, name: 'stale', home_node: home, created_at: 1000, lamport: 1000,
      pubkey: null, did: null, capabilities: [],
    };
    const r1 = await post(PORT_B, '/api/federation/sync', {
      since_ts: 0, remote_agents: [stale], secret: FED,
    });
    assert(r1.body.success !== false, 'stale push failed: ' + JSON.stringify(r1.body));
    const g1 = await get(PORT_B, '/api/agents/' + agentId);
    assert(g1.status === 200 && g1.body.success !== false, 'stale agent missing on B');
    const a1 = g1.body.agent || g1.body;
    assert(!a1.pubkey, 'expected no pubkey after incomplete sync, got ' + !!a1.pubkey);
    console.log('REPRO_STALE_OK', 'lamport=' + (a1.lamport || a1.created_at));

    // 2) Push updated record with pubkey + higher lamport (home node A would do this)
    const fresh = {
      ...stale,
      pubkey: '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n',
      did: 'did:moye:p36test',
      lamport: 2000,
      capabilities: ['ping'],
    };
    const r2 = await post(PORT_B, '/api/federation/sync', {
      since_ts: 0, remote_agents: [fresh], secret: FED,
    });
    assert(r2.body.merged_remote >= 1 || r2.body.success !== false, 'fresh push: ' + JSON.stringify(r2.body));
    const g2 = await get(PORT_B, '/api/agents/' + agentId);
    const a2 = g2.body.agent || g2.body;
    assert(a2.pubkey, 'P3-6 FAIL: pubkey still missing after LWW update');
    assert(a2.lamport === 2000, 'lamport not updated: ' + a2.lamport);
    assert(a2.did === 'did:moye:p36test', 'did not updated');
    console.log('LWW_UPDATE_OK', 'lamport=' + a2.lamport);

    // 3) Older lamport must NOT clobber
    const older = { ...fresh, pubkey: null, lamport: 1500 };
    await post(PORT_B, '/api/federation/sync', { since_ts: 0, remote_agents: [older], secret: FED });
    const g3 = await get(PORT_B, '/api/agents/' + agentId);
    const a3 = g3.body.agent || g3.body;
    assert(a3.pubkey, 'older lamport overwrote newer record');
    assert(a3.lamport === 2000, 'lamport regressed');
    console.log('LWW_REJECT_OLDER_OK');

    console.log('ALL_OK');
  } finally {
    kill();
  }
})().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
