'use strict';
// Local smoke for ADR-0025 watchRoom (R5) + R6 private-room plaintext rejection.
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3124;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'local-watch-test',
      PORT: String(PORT),
      ALLOW_UNSIGNED_TS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(BASE + '/health');
        if (r.ok) break;
      } catch { /* */ }
      await sleep(100);
      if (i === 39) throw new Error('server failed to boot: ' + boot.slice(-500));
    }

    const watcher = new Agent({ name: 'watch-smoker', capabilities: ['test'], baseUrl: BASE });
    const sender = new Agent({ name: 'send-smoker', capabilities: ['test'], baseUrl: BASE });
    watcher.generateIdentity();
    sender.generateIdentity();
    await watcher.register();
    await sender.register();

    // --- R6: private room rejects plaintext ---
    const priv = await watcher.createRoom('r6-priv', { visibility: 'private' });
    assert(priv.secret, 'createRoom should return secret for private');
    await sender.joinRoom(priv.room_id, priv.secret);

    let r6Hit = false;
    try {
      await sender.sendRoomMessage(priv.room_id, 'plaintext leak', { encrypt: false });
    } catch (e) {
      r6Hit = true;
      assert(/encrypted:true|400|private room/i.test(String(e.message || e)), 'R6 error should mention encrypt: ' + e);
      console.log('R6_OK', e.message || String(e));
    }
    assert(r6Hit, 'private plaintext should 400');

    // Public room still accepts plaintext
    const pub = await watcher.createRoom('r6-pub', { visibility: 'public' });
    const pubId = await sender.sendRoomMessage(pub.room_id, 'public plaintext ok');
    assert(pubId, 'public plaintext post should succeed');
    console.log('R6_PUBLIC_OK', pubId);

    // Encrypted private post works
    const encId = await sender.sendRoomMessage(priv.room_id, 'secret hello', { encrypt: true });
    assert(encId, 'encrypted private post should succeed');
    console.log('R6_ENC_OK', encId);

    // --- R5: watchRoom live delivery ---
    const liveRoom = await watcher.createRoom('r5-live', { visibility: 'private' });
    await sender.joinRoom(liveRoom.room_id, liveRoom.secret);

    const got = [];
    const sub = watcher.watchRoom(liveRoom.room_id, {
      since: Date.now(),
      secret: liveRoom.secret,
      onMessage(m) { got.push(m); },
      onError(e) { console.error('watch_err', e.message || e); },
    });

    await sleep(400); // let WS connect
    const liveId = await sender.sendRoomMessage(liveRoom.room_id, 'live ping', { encrypt: true });

    for (let i = 0; i < 50 && !got.some((m) => m.id === liveId); i++) await sleep(100);
    sub.stop();

    const hit = got.find((m) => m.id === liveId);
    assert(hit, 'watchRoom should deliver live message id=' + liveId + ' got=' + JSON.stringify(got.map((m) => m.id)));
    assert(hit.decrypted === 'live ping', 'should auto-decrypt, got ' + hit.decrypted);
    console.log('R5_LIVE_OK', { id: hit.id, decrypted: hit.decrypted, n: got.length });

    // watchRoomNext: wait for next
    const nextP = sender.watchRoomNext(liveRoom.room_id, {
      timeoutMs: 5000,
      secret: liveRoom.secret,
    });
    await sleep(200);
    const nextId = await watcher.sendRoomMessage(liveRoom.room_id, 'next ping', { encrypt: true });
    const nextMsg = await nextP;
    assert(nextMsg && nextMsg.id === nextId, 'watchRoomNext should get next ping');
    assert(nextMsg.decrypted === 'next ping', 'watchRoomNext decrypt');
    console.log('R5_NEXT_OK', nextMsg.id);

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
