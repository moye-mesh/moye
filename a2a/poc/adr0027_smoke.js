'use strict';
// ADR-0027 R9 (schema/payload) + R11 (ask.by): round-trip through POST, GET messages,
// changes?since=, and WS push. Also asserts old messages without these fields still work.
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3127;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ALLOW_DEFAULT_FED_SECRET: '1', NODE_ID: 'adr0027-smoke', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* */ }
      await sleep(100);
      if (i === 39) throw new Error('boot failed: ' + boot.slice(-400));
    }

    const a = new Agent({ name: 'adr27-a', capabilities: ['test'], baseUrl: BASE });
    const b = new Agent({ name: 'adr27-b', capabilities: ['test'], baseUrl: BASE });
    a.generateIdentity();
    b.generateIdentity();
    await a.register();
    await b.register();

    const room = await a.createRoom('adr27', { visibility: 'public' });
    await b.joinRoom(room.room_id);

    // Backward-compat: plain message still works, no new required fields
    const plainId = await a.sendRoomMessage(room.room_id, 'plain hello');
    const hist0 = await b.roomMessages(room.room_id, 50);
    const plain = hist0.find((m) => m.id === plainId);
    assert(plain && plain.content === 'plain hello', 'plain round-trip');
    assert(plain.schema == null && plain.payload == null && plain.by == null, 'plain has null optional fields');
    console.log('PLAIN_OK', plainId);

    const due = Date.now() + 3600_000;
    const struct = {
      schema: 'deploy-request-v1',
      payload: { commit_range: 'abc..def', verification_commands: ['curl -s /health'], rollback_plan: 'revert' },
      type: 'ask',
      awaiting: b.agentId,
      by: due,
    };

    // Watch before send so WS path is live
    const got = [];
    const sub = b.watchRoom(room.room_id, {
      since: Date.now(),
      onMessage(m) { got.push(m); },
      onError(e) { console.error('ws_err', e.message || e); },
    });
    await sleep(400);

    const askId = await a.sendRoomMessage(room.room_id, 'please deploy', struct);

    for (let i = 0; i < 50 && !got.some((m) => m.id === askId); i++) await sleep(100);
    sub.stop();

    const viaWs = got.find((m) => m.id === askId);
    assert(viaWs, 'WS should deliver ask');
    assert(viaWs.schema === 'deploy-request-v1', 'WS schema');
    assert(viaWs.payload && viaWs.payload.commit_range === 'abc..def', 'WS payload');
    assert(viaWs.by === due, 'WS by');
    assert(viaWs.awaiting === b.agentId, 'WS awaiting');
    console.log('WS_OK', askId);

    const hist = await b.roomMessages(room.room_id, 50);
    const viaGet = hist.find((m) => m.id === askId);
    assert(viaGet && viaGet.schema === 'deploy-request-v1' && viaGet.payload.commit_range === 'abc..def' && viaGet.by === due, 'GET messages');
    console.log('GET_OK');

    const ch = await b.roomChanges(room.room_id, due - 7200_000);
    const viaCh = (ch.messages || []).find((m) => m.id === askId);
    assert(viaCh && viaCh.schema === 'deploy-request-v1' && viaCh.payload.commit_range === 'abc..def' && viaCh.by === due, 'changes?since=');
    console.log('CHANGES_OK');

    // by without ask rejected
    let rejected = false;
    try {
      await a.sendRoomMessage(room.room_id, 'nope', { by: due });
    } catch (e) {
      rejected = /by is only valid|400/i.test(String(e.message || e));
    }
    assert(rejected, 'by without ask should 400');
    console.log('BY_GUARD_OK');

    console.log('ALL_OK');
    process.exitCode = 0;
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
