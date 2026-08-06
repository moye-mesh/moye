'use strict';
// ADR-0027 D1/D3 (R10/R12): multi-target N-of-M ask + awaiting_capability first-wins.
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3157;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function authGet(agent, p) {
  const headers = agent._headers(agent._didHeadersForGet(p));
  const res = await fetch(BASE + p, { headers });
  const json = await res.json();
  return { status: res.status, json };
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'adr0027-r10-r12',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'adr0027-r10-r12-smoke.db'),
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

    const alice = new Agent({ name: 'r10-alice', capabilities: ['coord'], baseUrl: BASE });
    alice.generateIdentity();
    await alice.register();

    const bob = new Agent({ name: 'r10-bob', capabilities: ['deploy'], baseUrl: BASE });
    bob.generateIdentity();
    await bob.register();

    const carol = new Agent({ name: 'r10-carol', capabilities: ['deploy', 'review'], baseUrl: BASE });
    carol.generateIdentity();
    await carol.register();

    const dave = new Agent({ name: 'r10-dave', capabilities: ['docs'], baseUrl: BASE });
    dave.generateIdentity();
    await dave.register();

    const room = await alice.createRoom('r10-r12');
    const roomId = room.room_id;
    await bob.joinRoom(roomId);
    await carol.joinRoom(roomId);
    await dave.joinRoom(roomId);

    // --- Legacy single-string: any resolve still closes ---
    const singleAsk = await alice.sendRoomMessage(roomId, 'single-ask', {
      type: 'ask', awaiting: bob.agentId,
    });
    let openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    assert((openBob.json.awaiting || []).some((a) => a.id === singleAsk), 'single open for bob');
    await carol.sendRoomMessage(roomId, 'carol-resolves-legacy', { type: 'resolve', ref: singleAsk });
    openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    assert(!(openBob.json.awaiting || []).some((a) => a.id === singleAsk), 'legacy any-resolve closes');

    // --- R10 multi-target: partial then full ---
    const multiAsk = await alice.sendRoomMessage(roomId, 'need-both', {
      type: 'ask', awaiting: [bob.agentId, carol.agentId],
    });

    openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    let openCarol = await authGet(carol, `/api/rooms/${roomId}/awaiting/${carol.agentId}`);
    const multiOpenBob = (openBob.json.awaiting || []).find((a) => a.id === multiAsk);
    assert(multiOpenBob, 'multi open for bob');
    assert(multiOpenBob.awaiting_mode === 'n-of-m', 'n-of-m mode');
    assert(multiOpenBob.awaiting_total === 2 && multiOpenBob.awaiting_threshold === 2, 'threshold=all');
    assert(multiOpenBob.resolved_count === 0, 'none resolved yet');
    assert((openCarol.json.awaiting || []).some((a) => a.id === multiAsk), 'multi open for carol');

    await bob.sendRoomMessage(roomId, 'bob-done', { type: 'resolve', ref: multiAsk });

    openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    openCarol = await authGet(carol, `/api/rooms/${roomId}/awaiting/${carol.agentId}`);
    assert(!(openBob.json.awaiting || []).some((a) => a.id === multiAsk), 'bob cleared after own resolve');
    const stillCarol = (openCarol.json.awaiting || []).find((a) => a.id === multiAsk);
    assert(stillCarol, 'ask still open for carol after bob');
    assert(stillCarol.resolved_count === 1, 'partial resolved_count=1');
    assert(stillCarol.awaiting_remaining && stillCarol.awaiting_remaining.includes(carol.agentId), 'carol remaining');

    // Cross-room awaiting for carol still lists it
    const cross = await authGet(carol, `/api/agents/${carol.agentId}/awaiting`);
    assert((cross.json.awaiting || []).some((x) => x.ask && x.ask.id === multiAsk), 'cross-room still open');

    await carol.sendRoomMessage(roomId, 'carol-done', { type: 'resolve', ref: multiAsk });
    openCarol = await authGet(carol, `/api/rooms/${roomId}/awaiting/${carol.agentId}`);
    assert(!(openCarol.json.awaiting || []).some((a) => a.id === multiAsk), 'closed after all targets');

    // Non-target resolve must not close multi-ask
    const multi2 = await alice.sendRoomMessage(roomId, 'need-bob-carol-2', {
      type: 'ask', awaiting: [bob.agentId, carol.agentId],
    });
    await dave.sendRoomMessage(roomId, 'dave-noise', { type: 'resolve', ref: multi2 });
    openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    assert((openBob.json.awaiting || []).some((a) => a.id === multi2), 'non-target resolve ignored for N-of-M');
    await bob.sendRoomMessage(roomId, 'bob2', { type: 'resolve', ref: multi2 });
    await carol.sendRoomMessage(roomId, 'carol2', { type: 'resolve', ref: multi2 });

    // --- R12 capability: first capable wins ---
    const capAsk = await alice.sendRoomMessage(roomId, 'need-deployer', {
      type: 'ask', awaiting_capability: 'deploy',
    });
    openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    openCarol = await authGet(carol, `/api/rooms/${roomId}/awaiting/${carol.agentId}`);
    const openDave = await authGet(dave, `/api/rooms/${roomId}/awaiting/${dave.agentId}`);
    assert((openBob.json.awaiting || []).some((a) => a.id === capAsk), 'bob has deploy');
    assert((openCarol.json.awaiting || []).some((a) => a.id === capAsk), 'carol has deploy');
    assert(!(openDave.json.awaiting || []).some((a) => a.id === capAsk), 'dave lacks deploy');

    // Non-capable resolve does not close
    await dave.sendRoomMessage(roomId, 'dave-cannot', { type: 'resolve', ref: capAsk });
    openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    assert((openBob.json.awaiting || []).some((a) => a.id === capAsk), 'still open after non-capable resolve');

    await bob.sendRoomMessage(roomId, 'bob-claims', { type: 'resolve', ref: capAsk });
    openBob = await authGet(bob, `/api/rooms/${roomId}/awaiting/${bob.agentId}`);
    openCarol = await authGet(carol, `/api/rooms/${roomId}/awaiting/${carol.agentId}`);
    assert(!(openBob.json.awaiting || []).some((a) => a.id === capAsk), 'closed after first capable');
    assert(!(openCarol.json.awaiting || []).some((a) => a.id === capAsk), 'carol also cleared (first-wins)');

    // Capability + explicit id: first eligible wins
    const mixed = await alice.sendRoomMessage(roomId, 'mixed', {
      type: 'ask', awaiting: dave.agentId, awaiting_capability: 'deploy',
    });
    // dave is explicit; bob/carol capable
    const openD = await authGet(dave, `/api/rooms/${roomId}/awaiting/${dave.agentId}`);
    assert((openD.json.awaiting || []).some((a) => a.id === mixed), 'dave explicit target');
    await carol.sendRoomMessage(roomId, 'carol-first', { type: 'resolve', ref: mixed });
    assert(!(
      (await authGet(dave, `/api/rooms/${roomId}/awaiting/${dave.agentId}`)).json.awaiting || []
    ).some((a) => a.id === mixed), 'first-wins closes for explicit+capability');

    console.log('ALL_OK');
  } catch (e) {
    console.error('FAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { child.kill('SIGKILL'); } catch { /* */ }
  }
})();
