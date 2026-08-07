'use strict';
// dev's independent verification of R21 (cross-room catchup) + R22 (overdue visibility).
// Probes the three things I made non-negotiable in the ticket, because each is a way this
// could look finished while being useless to the agent it exists for:
//   1. the response must hand back the NEXT CURSOR explicitly (bitten twice already: R14, room_watch)
//   2. it must be genuinely CROSS-room, not per-room with a loop bolted on
//   3. overdue must actually FLIP as `by` passes -- not merely be present as a field
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3186;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'r21-r22-verify',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'r21-r22-verify.db'),
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

    const asker = new Agent({ name: 'r21-asker', capabilities: ['coord'], baseUrl: BASE });
    asker.generateIdentity(); await asker.register();
    const worker = new Agent({ name: 'r21-worker', capabilities: ['build'], baseUrl: BASE });
    worker.generateIdentity(); await worker.register();

    // Two SEPARATE rooms -- this is what makes the cross-room claim testable at all.
    const roomA = await asker.createRoom('r21-room-a');
    const roomB = await asker.createRoom('r21-room-b');
    await worker.joinRoom(roomA.room_id);
    await worker.joinRoom(roomB.room_id);

    const catchup = async (since) => {
      const p = `/api/agents/${worker.agentId}/catchup${since != null ? '?since=' + since : ''}`;
      const r = await fetch(BASE + p, { headers: worker._headers(worker._didHeadersForGet(p)) });
      assert(r.status === 200, 'catchup returned ' + r.status);
      return r.json();
    };

    // Baseline before anything is owed.
    const empty = await catchup(0);
    // The field is `next_cursor` (I first asserted `cursor` -- my error, not the server's).
    assert(empty.next_cursor !== undefined && empty.next_cursor !== null,
      'BLOCKER: catchup did not return a next cursor -- a waking client would have to guess it');
    assert(typeof empty.next_cursor === 'number', 'next_cursor should be numeric, got ' + typeof empty.next_cursor);
    console.log('OK  catchup returns an explicit next cursor');

    // One ask in each room, both addressed to the worker. A per-room implementation would only
    // ever surface one of these.
    await asker.sendRoomMessage(roomA.room_id, 'need you in room A', { type: 'ask', awaiting: worker.agentId });
    await asker.sendRoomMessage(roomB.room_id, 'need you in room B', { type: 'ask', awaiting: worker.agentId });

    const both = await catchup(0);
    const blob = JSON.stringify(both);
    assert(blob.includes('need you in room A'), 'catchup missed the ask in room A');
    assert(blob.includes('need you in room B'), 'catchup missed the ask in room B');
    const roomsSeen = new Set((both.awaiting || []).map((a) => a.room_id).filter(Boolean));
    assert(roomsSeen.size >= 2,
      'CROSS-ROOM FAILED: awaiting covered ' + roomsSeen.size + ' room(s), expected both');
    console.log('OK  catchup is genuinely cross-room (both rooms in one call)');

    // Cursor must actually advance and be usable -- a cursor that never moves is decoration.
    assert(both.next_cursor >= empty.next_cursor, 'cursor went backwards');
    const afterCursor = await catchup(both.next_cursor);
    const newMsgs = afterCursor.rooms_delta || [];
    const redelivered = newMsgs.reduce((n, r) => n + ((r.messages || []).length), 0);
    assert(redelivered === 0,
      'resuming from next_cursor re-delivered ' + redelivered + ' already-seen message(s)');
    console.log('OK  returned cursor is usable and does not re-deliver');

    // ---- R22: overdue must FLIP, not merely exist ----
    const soon = Date.now() + 1200;
    await asker.sendRoomMessage(roomA.room_id, 'deadline test', {
      type: 'ask', awaiting: worker.agentId, by: soon,
    });

    // awaiting entries are { room_id, room_name, ask:{...} } -- the deadline annotation lives
    // on the inner ask, not the wrapper (I read the wrong level first).
    const findDeadlineAsk = (res) => {
      const hit = (res.awaiting || []).find((a) =>
        String((a.ask && a.ask.content) || '').includes('deadline test'));
      return hit ? hit.ask : null;
    };

    const beforeDue = findDeadlineAsk(await catchup(0));
    assert(beforeDue, 'the ask carrying a deadline never appeared in catchup');
    assert(beforeDue.overdue === false,
      'ask was reported overdue BEFORE its deadline passed (overdue=' + beforeDue.overdue + ')');
    assert(typeof beforeDue.due_in_ms === 'number' && beforeDue.due_in_ms > 0,
      'due_in_ms should be a positive number before the deadline, got ' + beforeDue.due_in_ms);
    console.log('OK  R22: not overdue before the deadline, due_in_ms counts down');

    await sleep(1600);

    const afterDue = findDeadlineAsk(await catchup(0));
    assert(afterDue, 'the deadline ask vanished after its deadline');
    assert(afterDue.overdue === true,
      'BLOCKER: overdue did NOT flip to true after the deadline passed -- the field exists but is inert');
    assert(afterDue.due_in_ms <= 0, 'due_in_ms should be <= 0 once overdue, got ' + afterDue.due_in_ms);
    console.log('OK  R22: overdue actually flips once the deadline passes');

    // An ask with no deadline must not be dragged into the overdue set.
    const noDeadlineWrap = (await catchup(0)).awaiting
      .find((a) => String((a.ask && a.ask.content) || '').includes('need you in room A'));
    const noDeadline = noDeadlineWrap && noDeadlineWrap.ask;
    assert(noDeadline && noDeadline.overdue === false && noDeadline.due_in_ms === null,
      'an ask without a `by` was given a bogus deadline state');
    console.log('OK  R22: asks without a deadline are left alone');

    console.log('\nR21_R22_VERIFY_ALL_OK');
  } catch (e) {
    console.error('\nFAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
})();
