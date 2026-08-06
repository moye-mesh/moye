'use strict';
/**
 * Reproduce + verify watcher cursor/baseline fix (dev rmsg_db25d30e5997).
 *
 * 1) OLD bug shape: cursor = Date.now() when file missing → outstanding inbound never appears
 *    in changes?since= → silent swallow.
 * 2) NEW fix: missing cursor file → 0 (logged first_ever_arm) → same outstanding wakes.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3161;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, '..', 'data');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function runWatch(env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'watch-room-to-coder.js')], {
      env: { ...process.env, ...env, ROOM_WATCH_SLEEP_MS: '500' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      resolve({ code: null, out, err, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err, timedOut: false });
    });
  });
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'watch-cursor-smoke',
      PORT: String(PORT),
      DB_FILE: path.join(DATA, 'watch-cursor-smoke.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* */ }
      await sleep(100);
      if (i === 49) throw new Error('boot failed');
    }

    const coder = new Agent({ name: 'cursor-coder', capabilities: ['t'], baseUrl: BASE });
    const peer = new Agent({ name: 'cursor-peer', capabilities: ['t'], baseUrl: BASE });
    coder.generateIdentity();
    peer.generateIdentity();
    await coder.register();
    await peer.register();
    const room = await peer.createRoom('cursor-room', { visibility: 'private' });
    await coder.joinRoom(room.room_id, room.secret);

    // Plant outstanding inbound while "watcher off"
    const mid = await peer.sendRoomMessage(room.room_id, `@coder please wake on this backlog ${Date.now()}`, {
      encrypt: true,
      type: 'ask',
      awaiting: coder.agentId,
    });
    assert(mid, 'plant message');
    console.log('PLANTED', mid);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moye-watch-'));
    const idPath = path.join(tmp, 'id.json');
    const roomPath = path.join(tmp, 'room.json');
    fs.writeFileSync(idPath, JSON.stringify({
      name: 'cursor-coder',
      agentId: coder.agentId,
      privateKey: coder._priv,
      did: coder.did,
    }));
    fs.writeFileSync(roomPath, JSON.stringify({
      room_id: room.room_id,
      membership_secret: room.secret,
    }));

    // --- Reproduce OLD swallow: cursor missing treated as Date.now() ---
    const inboxBug = path.join(tmp, 'inbox-bug');
    fs.mkdirSync(inboxBug);
    // Simulate old loadCursor: write a "now" cursor as if the old code ran
    fs.writeFileSync(path.join(inboxBug, 'room-watch-cursor.txt'), String(Date.now()) + '\n');
    // no baseline → empty; but cursor=now means changes returns nothing
    const swallowed = await runWatch({
      MOYE_BASE_URL: BASE,
      ROOM_WATCH_INBOX: inboxBug,
      ROOM_WATCH_ROOM_JSON: roomPath,
      ROOM_WATCH_ID_JSON: idPath,
      CODER_MATCH_REGEX: 'coder|@coder|' + coder.agentId,
    }, 2500);
    assert(swallowed.timedOut || !/AGENT_LOOP_WAKE_room_coder/.test(swallowed.out),
      'expected OLD cursor=now shape to miss backlog');
    console.log('REPRO_SWALLOW_OK');

    // --- Fixed path: no cursor file → first_ever_arm at 0 → wakes ---
    const inboxFix = path.join(tmp, 'inbox-fix');
    fs.mkdirSync(inboxFix);
    // deliberately no cursor file, no baseline
    const woken = await runWatch({
      MOYE_BASE_URL: BASE,
      ROOM_WATCH_INBOX: inboxFix,
      ROOM_WATCH_ROOM_JSON: roomPath,
      ROOM_WATCH_ID_JSON: idPath,
      CODER_MATCH_REGEX: 'coder|@coder|' + coder.agentId,
    }, 8000);
    assert(/cursor_init":"first_ever_arm"/.test(woken.err) || /first_ever_arm/.test(woken.err),
      'expected first_ever_arm log: ' + woken.err.slice(0, 300));
    assert(/AGENT_LOOP_WAKE_room_coder/.test(woken.out),
      'expected wake on outstanding inbound: out=' + woken.out.slice(0, 400));
    assert(woken.out.includes(mid) || woken.out.includes('message_ids'),
      'wake should reference planted message');
    console.log('FIX_WAKE_OK');

    console.log('ALL_OK');
  } finally {
    try { child.kill(); } catch { /* */ }
  }
})().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
