'use strict';
// ADR-0014 §2.4 / P4-2: scoped, expiring, revocable session keys.
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3142;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'adr0014-session',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'adr0014-session-smoke.db'),
    },
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

    const master = new Agent({ name: 'p42-master', capabilities: ['test'], baseUrl: BASE });
    const peer = new Agent({ name: 'p42-peer', capabilities: ['test'], baseUrl: BASE });
    master.generateIdentity();
    peer.generateIdentity();
    await master.register();
    await peer.register();

    const sess = await master.createSession({
      scope: ['send', 'inbox'],
      expiresInMs: 60 * 60 * 1000,
    });
    assert(sess.session_did && sess.private_key, 'createSession returned material');
    console.log('CREATE_OK', sess.session_did.slice(0, 28));

    const hot = Agent.fromSession({
      masterDid: sess.master_did,
      agentId: sess.agent_id,
      privateKey: sess.private_key,
      baseUrl: BASE,
    });
    assert(hot._sessionDid === sess.session_did, 'fromSession derives session did');
    assert(hot.did === master.did, 'fromSession acts as master did');

    const mid = await hot.send(peer.agentId, 'hello from session');
    assert(mid, 'session-scoped send');
    console.log('SEND_OK', mid);

    const inbox = await peer.inbox();
    assert(inbox.some((m) => m.id === mid || m.content === 'hello from session'), 'peer received session message');
    console.log('INBOX_OK');

    // Privileged path must fail for session keys
    let deregDenied = false;
    try {
      const payload = { ts: Date.now() };
      const headers = hot._headers(hot._didHeaders(payload));
      const res = await fetch(BASE + `/api/agents/${master.agentId}/deregister`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      deregDenied = !res.ok || data.success === false;
    } catch {
      deregDenied = true;
    }
    assert(deregDenied, 'session must not deregister');
    console.log('PRIVILEGE_DENY_OK');

    // Scope miss: room.post not granted
    let roomDenied = false;
    try {
      await hot.createRoom('should-fail');
    } catch {
      roomDenied = true;
    }
    assert(roomDenied, 'session without room.create must fail');
    console.log('SCOPE_DENY_OK');

    await master.revokeSession(sess.session_did);
    let afterRevoke = false;
    try {
      await hot.send(peer.agentId, 'should fail after revoke');
    } catch {
      afterRevoke = true;
    }
    assert(afterRevoke, 'revoked session must fail');
    console.log('REVOKE_OK');

    // Master still works
    await master.send(peer.agentId, 'master still owns the identity');
    console.log('MASTER_OK');
    console.log('ALL_OK');
  } finally {
    child.kill('SIGTERM');
  }
})().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
