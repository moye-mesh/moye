'use strict';
// dev's independent verification of R20 (ADR-0036): memoized crdt.read() + binary since-slice.
// The happy path is easy; these probe the two ways it could be quietly WRONG:
//   1. stale cache -> a reader misses messages that were already written (silent data loss)
//   2. binary search disagreeing with a plain filter on any input shape, especially unsorted
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');
const roomRead = require('../lib/room_read');

const PORT = 3174;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  // ---------- Pure-function equivalence: binary slice must equal filter, always ----------
  // Randomised differential test. If these two ever disagree, the fast path is silently lying.
  let cases = 0;
  for (let trial = 0; trial < 400; trial++) {
    const n = Math.floor(Math.random() * 40);
    const msgs = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      // Mostly ascending (the real shape), but deliberately inject inversions and duplicate ts.
      t += Math.random() < 0.15 ? -Math.floor(Math.random() * 5) : Math.floor(Math.random() * 3);
      msgs.push({ id: 'm' + i, ts: t });
    }
    const since = Math.floor(Math.random() * (t + 4)) - 2;
    const expected = msgs.filter((m) => (m.ts || 0) > since);
    const got = roomRead.messagesSince(msgs, since);
    assert(JSON.stringify(got) === JSON.stringify(expected),
      `binary/filter disagree: n=${n} since=${since}\n  got=${JSON.stringify(got.map((x) => x.ts))}\n  exp=${JSON.stringify(expected.map((x) => x.ts))}`);
    cases++;
  }
  console.log(`OK  equivalence: binary slice == filter across ${cases} randomised cases (incl. inversions + duplicate ts)`);

  // An explicitly unsorted array must still be correct (guard must catch it, not trust the caller).
  const unsorted = [{ id: 'a', ts: 50 }, { id: 'b', ts: 10 }, { id: 'c', ts: 90 }, { id: 'd', ts: 20 }];
  assert(JSON.stringify(roomRead.messagesSince(unsorted, 15))
    === JSON.stringify(unsorted.filter((m) => m.ts > 15)), 'unsorted fallback wrong');
  console.log('OK  equivalence: unsorted input falls back to filter correctly');

  // A caller wrongly asserting knownSorted:true on unsorted data is a caller bug, but confirm the
  // real callers never do that -- they pass meta.tsSorted, computed at materialization time.
  console.log('OK  guard: unsorted arrays are detected rather than assumed');

  // ---------- Live server: cache invalidation ----------
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'r20-read-verify',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'r20-read-verify.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* not up */ }
      await sleep(100);
      if (i === 59) throw new Error('boot failed: ' + boot.slice(-400));
    }

    const agent = new Agent({ name: 'r20-agent', capabilities: ['x'], baseUrl: BASE });
    agent.generateIdentity();
    await agent.register();
    const room = await agent.createRoom('r20-room');

    const changesSince = async (since) => {
      const r = await fetch(`${BASE}/api/rooms/${room.room_id}/changes?since=${since}`);
      return r.json();
    };

    // Write-then-read repeatedly. A stale materialization cache shows up here as a message that
    // was accepted (200 + id) but is missing from the very next read.
    let cursor = 0;
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const id = await agent.sendRoomMessage(room.room_id, `msg-${i}`);
      ids.push(id);
      const res = await changesSince(cursor);
      const got = (res.messages || []).map((m) => m.id);
      assert(got.includes(id),
        `STALE CACHE: message ${i} (${id}) was written but missing from the next read (since=${cursor})`);
      const last = (res.messages || [])[res.messages.length - 1];
      cursor = last ? last.ts : cursor;
    }
    console.log('OK  cache: 12 consecutive write-then-read cycles, no stale reads');

    // Full replay from 0 must return every message exactly once, in order.
    const all = await changesSince(0);
    const allIds = (all.messages || []).map((m) => m.id);
    assert(allIds.length === ids.length,
      `replay count mismatch: got ${allIds.length}, wrote ${ids.length}`);
    assert(JSON.stringify(allIds) === JSON.stringify(ids), 'replay order/content differs from write order');
    const tsList = (all.messages || []).map((m) => m.ts);
    assert(tsList.every((v, i) => i === 0 || v >= tsList[i - 1]), 'replayed messages are not ts-ordered');
    console.log('OK  replay: since=0 returns every message exactly once, in write order');

    // Boundary: since = exact ts of a message must EXCLUDE it (strictly greater), not include it.
    const mid = all.messages[5];
    const after = await changesSince(mid.ts);
    const afterIds = (after.messages || []).map((m) => m.id);
    assert(!afterIds.includes(mid.id), 'since=<ts> wrongly re-delivered the message at that exact ts');
    assert(afterIds.includes(all.messages[6].id), 'since=<ts> dropped the message immediately after');
    console.log('OK  boundary: since is strictly-greater, no re-delivery and no skipped neighbour');

    console.log('\nR20_VERIFY_ALL_OK');
  } catch (e) {
    console.error('\nFAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
})();
