'use strict';
// Smoke: ADR-0022 T1–T8 + N1 (no /api/blobs) + T4 reputation isolation
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const slip = require('../lib/slip0010');
const didlib = require('../lib/did');

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* */ }
        resolve({ status: res.statusCode, body: b, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function registerWithKey(name, publicKeyPem) {
  const r = await req('POST', '/api/agents', {
    name, capabilities: ['search', 'code'], pubkey: publicKeyPem,
  });
  assert(r.json && r.json.agent_id, 'register failed: ' + r.body);
  return r.json;
}

function signVc(issuerPrivPem, vc) {
  const { sig, ...rest } = vc;
  const payload = JSON.stringify(rest, Object.keys(rest).sort());
  // Match server stableStringify recursively — for flat objects sorted keys is enough for our test VCs
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  const body = stable(rest);
  return didlib.sign(issuerPrivPem, body);
}

(async () => {
  // T2 unit
  const seed = crypto.randomBytes(32);
  const root = slip.deriveIdentity(seed);
  const inst = slip.deriveInstance(seed, 0);
  assert(root.did !== inst.did, 'T2: root and instance DIDs must differ');
  console.log('T2 ok', root.path, inst.path);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'local-t-' + Date.now(),
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'smoke-adr0022-' + Date.now() + '.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  let errBuf = '';
  child.stdout.on('data', (d) => { if (d.toString().includes(`on :${PORT}`)) ready = true; });
  child.stderr.on('data', (d) => { errBuf += d.toString(); });
  for (let i = 0; i < 100 && !ready; i++) await sleep(50);
  if (!ready) {
    console.error('server failed to start', errBuf);
    child.kill();
    process.exit(1);
  }

  try {
    // N1: blobs gone
    const blobs = await req('POST', '/api/blobs', { data: Buffer.from('x').toString('base64') });
    assert(blobs.status === 404 || (blobs.json && blobs.json.error), 'N1: /api/blobs should be gone, got ' + blobs.status);
    console.log('N1 ok', blobs.status);

    const rootAgent = await registerWithKey('root-' + Date.now(), root.publicKeyPem);
    const instAgent = await registerWithKey('inst-' + Date.now(), inst.publicKeyPem);
    const other = await registerWithKey('other-' + Date.now(),
      crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));

    // T3: issue identity-delegation VC
    const claim = {
      type: 'identity-delegation',
      instance_did: inst.did,
      pubkey: inst.publicKeyPem,
      scope: 'rooms',
    };
    const vc = {
      issuer: root.did,
      subject: inst.did,
      claim,
      ts: Date.now(),
    };
    vc.sig = signVc(root.privateKeyPem, vc);
    const issued = await req('POST', '/api/credentials', { credential: vc }, {
      Authorization: 'Bearer ' + rootAgent.token,
    });
    assert(issued.status === 200, 'T3 issue: ' + issued.body);
    const instances = await req('GET', `/api/agents/${rootAgent.agent_id}/instances`);
    assert(instances.json && instances.json.instances && instances.json.instances.some((x) => x.instance_did === inst.did),
      'T3 instances: ' + instances.body);
    console.log('T3 ok', instances.json.instances.length);

    // T4: block reputation wash root↔instance
    const wash = await req('POST', '/api/reputation', { target: rootAgent.agent_id, delta: 1 }, {
      Authorization: 'Bearer ' + instAgent.token,
    });
    assert(wash.status === 403, 'T4 should block instance→root vote, got ' + wash.status + ' ' + wash.body);
    const okVote = await req('POST', '/api/reputation', { target: other.agent_id, delta: 1 }, {
      Authorization: 'Bearer ' + rootAgent.token,
    });
    assert(okVote.status === 200, 'T4 unrelated vote should work: ' + okVote.body);
    console.log('T4 ok');

    // Room + checkpoint + T7 + T1
    const room = await req('POST', '/api/rooms', {
      name: 'fork-src', visibility: 'public', members: [instAgent.agent_id],
    }, { Authorization: 'Bearer ' + rootAgent.token });
    assert(room.json && room.json.room_id, 'room: ' + room.body);
    const roomId = room.json.room_id;
    await req('POST', `/api/rooms/${roomId}/messages`, {
      content: 'before checkpoint', ts: Date.now(),
    }, { Authorization: 'Bearer ' + rootAgent.token });
    const cp = await req('POST', `/api/rooms/${roomId}/checkpoint`, { label: 'v1' }, {
      Authorization: 'Bearer ' + rootAgent.token,
    });
    assert(cp.json && cp.json.checkpoint, 'checkpoint: ' + cp.body);
    const cpSeq = cp.json.checkpoint.ledger_seq;
    await req('POST', `/api/rooms/${roomId}/messages`, {
      content: 'after checkpoint', ts: Date.now(),
    }, { Authorization: 'Bearer ' + rootAgent.token });

    const at = await req('GET', `/api/rooms/${roomId}/at?checkpoint=${cpSeq}`);
    assert(at.status === 200 && at.json && Array.isArray(at.json.messages), 'T7: ' + at.body);
    assert(at.json.messages.every((m) => m.content !== 'after checkpoint'), 'T7 should exclude post-checkpoint msgs');
    console.log('T7 ok', at.json.messages.length);

    const fork = await req('POST', `/api/rooms/${roomId}/fork`, {
      checkpoint_id: cpSeq, name: 'fork-dst',
    }, { Authorization: 'Bearer ' + rootAgent.token });
    assert(fork.status === 200 && fork.json && fork.json.room_id, 'T1: ' + fork.body);
    assert(fork.json.forked_from && fork.json.forked_from.room_id === roomId, 'T1 forked_from');
    console.log('T1 ok', fork.json.room_id);

    // T5 resolve?at=
    const now = Date.now();
    const resNow = await req('GET', `/api/agents/${rootAgent.agent_id}/resolve`);
    assert(resNow.status === 200, 'resolve: ' + resNow.body);
    const resAt = await req('GET', `/api/agents/${rootAgent.agent_id}/resolve?at=${now}`);
    assert(resAt.status === 200 && resAt.json && resAt.json.at, 'T5: ' + resAt.body);
    console.log('T5 ok');

    // T8 timeline
    const tl = await req('GET', `/api/agents/${rootAgent.agent_id}/timeline?limit=50`);
    assert(tl.status === 200 && tl.json && Array.isArray(tl.json.events), 'T8: ' + tl.body);
    console.log('T8 ok', tl.json.events.length, 'instances', (tl.json.instances || []).length);

    // T6 gravity search
    const search = await req('POST', '/api/search', { q: 'root', limit: 20 });
    assert(search.status === 200 && search.json && Array.isArray(search.json.agents), 'T6: ' + search.body);
    assert(search.json.agents.every((a) => typeof a.gravity === 'number'), 'T6 gravity field');
    console.log('T6 ok', search.json.total);

    console.log('ALL PASS');
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e.message);
    child.kill();
    process.exit(1);
  }
})();
