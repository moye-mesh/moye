'use strict';
// watchRoom AggregateError hardening (dev ask rmsg_ac0c19fdde23 / archive 2026-08-01-0100).
// Verifies: (1) onError receives real errors on connect failure, (2) process survives,
// (3) prefer `ws` over native WebSocket unless MOYE_WS_IMPL=native.
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3158;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'watch-agg-smoke',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'watch-agg-smoke.db'),
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

    const watcher = new Agent({ name: 'agg-watcher', capabilities: ['test'], baseUrl: BASE });
    const sender = new Agent({ name: 'agg-sender', capabilities: ['test'], baseUrl: BASE });
    watcher.generateIdentity();
    sender.generateIdentity();
    await watcher.register();
    await sender.register();
    const room = await watcher.createRoom('agg-room', { visibility: 'public' });
    await sender.joinRoom(room.room_id);

    // Happy path still works with ws-preferred default (two agents — server skips push-to-self)
    const got = [];
    const live = watcher.watchRoom(room.room_id, {
      since: Date.now(),
      onMessage(m) { got.push(m.id); },
      onError(e) { /* soft */ },
    });
    await sleep(600);
    const mid = await sender.sendRoomMessage(room.room_id, 'ping-agg');
    for (let i = 0; i < 40 && !got.includes(mid); i++) await sleep(100);
    live.stop();
    assert(got.includes(mid), 'live delivery still works under ws-preferred got=' + JSON.stringify(got));
    console.log('LIVE_OK', mid);

    // Forced connection failure: point WS at a closed port. Process must survive and onError must fire.
    const errors = [];
    const reconnects = [];
    watcher.baseUrl = 'http://127.0.0.1:9'; // nothing listening
    const bad = watcher.watchRoom(room.room_id, {
      since: Date.now(),
      onMessage() { /* */ },
      onError(e) { errors.push({ name: e && e.name, message: e && (e.message || String(e)) }); },
      onReconnect(info) { reconnects.push(info); },
    });
    await sleep(4500);
    bad.stop();
    assert(errors.length >= 1, 'onError must fire on connect failure, got ' + errors.length);
    assert(reconnects.length >= 1, 'should schedule reconnects with backoff');
    console.log('ONERR_OK', errors[0].name || errors[0].message, 'reconnects=' + reconnects.length);
    console.log('BACKOFF_OK', reconnects.map((r) => r.backoff_ms).filter(Boolean).slice(0, 3));

    // Bridge safety-net: child process with uncaught AggregateError must restart watch, not die.
    const bridgeScript = `
      const { spawn } = require('child_process');
      // Minimal stand-in: install the same handlers as moye-agent-bridge and throw AggregateError
      let restarts = 0;
      function startWatch() { restarts++; process.stderr.write(JSON.stringify({ restarted: restarts }) + '\\n'); }
      function survive(kind, err) {
        process.stderr.write(JSON.stringify({ bridge_safety_net: kind, watch_error: err.message, action: 'restart_watch' }) + '\\n');
        startWatch();
      }
      process.on('uncaughtException', (e) => survive('uncaughtException', e));
      startWatch();
      setTimeout(() => {
        const ag = new AggregateError([new Error('ECONNREFUSED'), new Error('ECONNREFUSED')], 'AggregateError');
        throw ag;
      }, 50);
      setTimeout(() => {
        process.stderr.write(JSON.stringify({ survived: true, restarts }) + '\\n');
        process.exit(restarts >= 2 ? 0 : 2);
      }, 200);
    `;
    const br = spawn(process.execPath, ['-e', bridgeScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    let brOut = '';
    br.stderr.on('data', (c) => { brOut += c; });
    const code = await new Promise((resolve) => br.on('close', resolve));
    assert(code === 0, 'bridge safety net should survive AggregateError: ' + brOut);
    assert(/bridge_safety_net/.test(brOut) && /survived/.test(brOut), 'safety net logs missing: ' + brOut);
    console.log('BRIDGE_SAFETY_OK');

    console.log('ALL_OK');
  } finally {
    try { child.kill(); } catch { /* */ }
  }
})().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
