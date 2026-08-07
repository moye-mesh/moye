'use strict';
// R15 (ADR-0034): the room state doc reports how far it lags the chat log.
// Read-time computation only -- asserts the number actually tracks new messages,
// and that writing the state doc resets it. No scheduler involved anywhere.
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3168;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'r15-staleness-smoke',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'r15-staleness-smoke.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
      if (i === 49) throw new Error('boot failed: ' + boot.slice(-400));
    }

    const agent = new Agent({ name: 'r15-agent', capabilities: ['room'], baseUrl: BASE });
    agent.generateIdentity();
    await agent.register();
    const room = await agent.createRoom('r15-room');

    const readState = async () => {
      const r = await fetch(`${BASE}/api/rooms/${room.room_id}/state`);
      return r.json();
    };

    // 1) Fresh room, state doc never written: every message counts as unconsolidated.
    let s = await readState();
    assert(s.staleness, 'staleness block missing from GET /state');
    assert(s.staleness.messages_since_update === 0,
      'empty room should report 0 messages since update, got ' + s.staleness.messages_since_update);
    assert(s.staleness.state_updated_at === null, 'state_updated_at should be null before any write');
    console.log('EMPTY_ROOM_OK');

    // 2) Post messages -- staleness must track them, with no state write in between.
    await agent.sendRoomMessage(room.room_id, 'first');
    await agent.sendRoomMessage(room.room_id, 'second');
    await agent.sendRoomMessage(room.room_id, 'third');
    s = await readState();
    assert(s.staleness.messages_since_update === 3,
      'expected 3 messages since update, got ' + s.staleness.messages_since_update);
    assert(s.staleness.message_count === 3, 'message_count should be 3, got ' + s.staleness.message_count);
    console.log('TRACKS_NEW_MESSAGES_OK');

    // 3) Writing the state doc consolidates: the lag resets to zero.
    // _didHeaders() stamps `ts` into the payload object it signs, so the exact same
    // object reference must be what gets sent -- re-serializing a fresh literal breaks the signature.
    const body = { summary: 'consolidated' };
    const hdrs = { 'Content-Type': 'application/json', ...agent._headers(agent._didHeaders(body)) };
    const w = await fetch(`${BASE}/api/rooms/${room.room_id}/state`, {
      method: 'POST', headers: hdrs, body: JSON.stringify(body),
    });
    assert(w.ok, 'state write failed: ' + w.status);
    s = await readState();
    assert(s.staleness.messages_since_update === 0,
      'after consolidation lag should be 0, got ' + s.staleness.messages_since_update);
    assert(typeof s.staleness.state_updated_at === 'number', 'state_updated_at should be set after write');
    console.log('RESETS_ON_CONSOLIDATION_OK');

    // 4) New activity after consolidation counts again -- the metric is live, not one-shot.
    await agent.sendRoomMessage(room.room_id, 'after consolidation');
    s = await readState();
    assert(s.staleness.messages_since_update === 1,
      'expected 1 message after consolidation, got ' + s.staleness.messages_since_update);
    assert(s.staleness.message_count === 4, 'message_count should be 4, got ' + s.staleness.message_count);
    console.log('LIVE_AFTER_CONSOLIDATION_OK');

    console.log('ALL_OK');
  } catch (e) {
    console.error('FAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
})();
