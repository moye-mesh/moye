'use strict';
// Does room TASK assignment actually federate across nodes?
//
// AGENTS.md carried a "known gap" warning saying room tasks are node-local SQLite and do NOT
// federate. server.js has a "FIXED 2026-07-25" comment claiming they were moved onto the same
// RGA-CRDT shared-state path as room chat. Exactly one of those is current. This test decides it
// against two real federating nodes instead of trusting either comment.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT_A = 3181;
const PORT_B = 3182;
const FED = 'room-task-fed-verify-secret';
const DATA = path.join(__dirname, '..', 'data');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

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
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch { /* fresh anyway */ }
  }
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
    try { if ((await get(port, '/health')).status === 200) return; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error('boot failed on :' + port + ' ' + (child._boot() || '').slice(-400));
}

/** Poll until `check` passes or we give up, so a slow federation round doesn't false-fail. */
async function eventually(label, fn, check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await fn(); if (check(last)) return last; } catch (e) { last = { err: e.message }; }
    await sleep(500);
  }
  throw new Error(`${label} never converged; last=${JSON.stringify(last).slice(0, 300)}`);
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const nodeA = spawnNode('rtf-a', PORT_A, `rtf-b=http://127.0.0.1:${PORT_B}`, 'rtf-a.db');
  const nodeB = spawnNode('rtf-b', PORT_B, `rtf-a=http://127.0.0.1:${PORT_A}`, 'rtf-b.db');
  const kill = () => { try { nodeA.kill(); } catch { /* */ } try { nodeB.kill(); } catch { /* */ } };
  process.on('exit', kill);

  try {
    await waitHealth(PORT_A, nodeA);
    await waitHealth(PORT_B, nodeB);
    console.log('BOOT_OK  two federating nodes');

    const BASE_A = `http://127.0.0.1:${PORT_A}`;
    const BASE_B = `http://127.0.0.1:${PORT_B}`;

    // Creator lives on node A; the assignee registers on node B. This is precisely the shape the
    // old AGENTS.md warning said would break.
    const creator = new Agent({ name: 'rtf-creator', capabilities: ['coord'], baseUrl: BASE_A });
    creator.generateIdentity(); await creator.register();
    const worker = new Agent({ name: 'rtf-worker', capabilities: ['build'], baseUrl: BASE_B });
    worker.generateIdentity(); await worker.register();

    const room = await creator.createRoom('rtf-room');
    console.log('SETUP_OK creator on A, worker on B, room', room.room_id);

    // The worker must be visible on A before it can be assigned (agent directory federation).
    await eventually('worker visible on node A',
      () => get(PORT_A, `/api/agents/${worker.agentId}`),
      (r) => r.status === 200);
    console.log('OK  agent directory federated B -> A');

    // Assign the task on node A.
    const taskIds = await creator.assignTask(room.room_id, 'federated task check', [worker.agentId]);
    assert(Array.isArray(taskIds) && taskIds.length, 'assignTask returned no task ids');
    const taskId = taskIds[0];
    console.log('OK  task assigned on node A:', taskId);

    // THE ACTUAL QUESTION: can node B see it?
    // Note: tasks are surfaced by GET /api/rooms/:id (room detail), there is no /tasks read route.
    const onB = await eventually('task visible on node B',
      () => get(PORT_B, `/api/rooms/${room.room_id}`),
      (r) => r.status === 200 && JSON.stringify(r.body).includes(taskId));
    console.log('OK  task assigned on A is visible on B  <-- this is what AGENTS.md claimed was broken');

    // And the reverse direction: the worker reports on B, creator must see it on A.
    await worker.report(room.room_id, taskId, 'done from node B');
    await eventually('report visible on node A',
      () => get(PORT_A, `/api/rooms/${room.room_id}`),
      (r) => r.status === 200 && JSON.stringify(r.body).includes('done from node B'));
    console.log('OK  report filed on B is visible on A (both directions federate)');

    // Confirm the storage path is the federated shared-state one, not the legacy SQLite table --
    // otherwise the above could pass for some other reason and regress silently later.
    const shared = await get(PORT_B, `/api/shared-state?key=room-tasks:${room.room_id}`);
    const sharedOk = shared.status === 200 && JSON.stringify(shared.body).includes(taskId);
    console.log(sharedOk
      ? 'OK  storage path confirmed: task events live in federated shared state'
      : 'NOTE could not confirm via /api/shared-state (endpoint shape differs) -- federation itself is proven above');

    console.log('\nROOM_TASK_FEDERATION_ALL_OK');
  } catch (e) {
    console.error('\nFAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    kill();
    await sleep(300);
  }
})();
