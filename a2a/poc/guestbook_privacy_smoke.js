'use strict';
// Guestbook privacy: no public GET; POST mirrors into room via appendRoomMessage.
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3163;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = 'room_guestbook_smoke';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'guestbook-smoke',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'guestbook-privacy-smoke.db'),
      GUESTBOOK_ROOM_ID: ROOM,
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

    const g = await fetch(BASE + '/api/guestbook');
    assert(g.status === 404, 'GET guestbook should 404, got ' + g.status);

    const since = Date.now();
    const marker = 'guestbook-smoke-' + since;
    const post = await fetch(BASE + '/api/guestbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: 'SmokeBot', content: marker, lang: 'en' }),
    });
    const pj = await post.json();
    assert(post.ok && pj.success, 'POST guestbook: ' + JSON.stringify(pj));

    let hit = null;
    for (let i = 0; i < 40; i++) {
      const ch = await fetch(BASE + `/api/rooms/${ROOM}/changes?since=${since - 2000}`);
      const cj = await ch.json();
      hit = (cj.messages || []).find((m) =>
        m.from_agent === '(site-guestbook)' && String(m.content).includes(marker));
      if (hit) break;
      await sleep(100);
    }
    assert(hit, 'mirrored room message not found via changes?since=');
    assert(hit.encrypted === false, 'guestbook mirror is plaintext by design');
    assert(String(hit.content).includes('SmokeBot'), 'includes agent name');

    console.log('ALL_OK');
  } catch (e) {
    console.error('FAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    try { child.kill('SIGTERM'); } catch { /* */ }
    await sleep(200);
  }
})();
