'use strict';
// Smoke: R1 awaiting + N1 attachment metadata (no IPFS required for attach-on-message).
const { spawn } = require('child_process');
const http = require('http');
const { generateKeyPairSync } = require('crypto');
const path = require('path');

const PORT = 3122;
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
        resolve({ status: res.statusCode, headers: res.headers, body: b, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function register(name) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const r = await req('POST', '/api/agents', {
    name, capabilities: ['test'], pubkey: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  if (!r.json || !r.json.agent_id) throw new Error('register failed: ' + r.body);
  return r.json;
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'local-r1-' + Date.now(),
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'smoke-phase2-' + Date.now() + '.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  child.stdout.on('data', (d) => { if (d.toString().includes(`on :${PORT}`)) ready = true; });
  for (let i = 0; i < 80 && !ready; i++) await sleep(50);
  if (!ready) { console.error('no start'); child.kill(); process.exit(1); }

  const a = await register('await-a-' + Date.now());
  const b = await register('await-b-' + Date.now());
  const room = await req('POST', '/api/rooms', { name: 'await-room', visibility: 'public', members: [b.agent_id] }, {
    Authorization: 'Bearer ' + a.token,
  });
  console.log('ROOM', room.status, room.json && room.json.room_id);
  const roomId = room.json.room_id;

  const ask = await req('POST', `/api/rooms/${roomId}/messages`, {
    content: 'please implement parser.js',
    type: 'ask',
    awaiting: b.agent_id,
    ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  console.log('ASK', ask.status, ask.json);

  const open1 = await req('GET', `/api/rooms/${roomId}/awaiting/${b.agent_id}`);
  console.log('OPEN', open1.json && open1.json.awaiting && open1.json.awaiting.length);

  const cross = await req('GET', `/api/agents/${b.agent_id}/awaiting`);
  console.log('CROSS', cross.json && cross.json.awaiting && cross.json.awaiting.length);

  const fakeCid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const withAtt = await req('POST', `/api/rooms/${roomId}/messages`, {
    content: 'see attachment',
    attachments: [{ cid: fakeCid, name: 'weights.bin', size: 12, sha256: 'a'.repeat(64), media_type: 'application/octet-stream' }],
    ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  console.log('ATT_MSG', withAtt.status, withAtt.json);

  const msgs = await req('GET', `/api/rooms/${roomId}/messages?limit=50`);
  const withAttMsg = (msgs.json.messages || []).find((m) => m.id === withAtt.json.message_id);
  console.log('ATT_STORED', !!(withAttMsg && withAttMsg.attachments && withAttMsg.attachments[0] && withAttMsg.attachments[0].cid === fakeCid));

  const resolve = await req('POST', `/api/rooms/${roomId}/messages`, {
    content: 'done',
    type: 'resolve',
    ref: ask.json.message_id,
    ts: Date.now(),
  }, { Authorization: 'Bearer ' + b.token });
  console.log('RESOLVE', resolve.status);

  const open2 = await req('GET', `/api/rooms/${roomId}/awaiting/${b.agent_id}`);
  const stillOpen = (open2.json.awaiting || []).some((m) => m.id === ask.json.message_id);
  console.log('CLEARED', !stillOpen);

  const md = await req('GET', `/api/agents/${a.agent_id}`, null, { Accept: 'text/markdown' });
  console.log('MD', md.status, (md.headers['content-type'] || '').includes('markdown'), md.body.slice(0, 40));

  const search = await req('POST', '/api/search', { q: 'await', limit: 10 });
  console.log('SEARCH', search.status, search.json && search.json.total);

  const verbs = await req('GET', '/api/verbs');
  console.log('VERBS', verbs.status, verbs.json && verbs.json.verbs && verbs.json.verbs.length);

  const cp = await req('POST', `/api/rooms/${roomId}/checkpoint`, { label: 'v1', ts: Date.now() }, {
    Authorization: 'Bearer ' + a.token,
  });
  console.log('CHECKPOINT', cp.status, !!(cp.json && cp.json.checkpoint && cp.json.checkpoint.ledger_hash));

  const st = await req('POST', `/api/rooms/${roomId}/state`, {
    summary: 'parser work', decisions: [{ text: 'use JSON Schema' }], ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  console.log('STATE', st.status, st.json && st.json.state && st.json.state.summary);

  const pass =
    ask.status === 200 &&
    open1.json.awaiting.length === 1 &&
    cross.json.awaiting.length >= 1 &&
    withAtt.status === 200 &&
    withAttMsg && withAttMsg.attachments && withAttMsg.attachments[0].cid === fakeCid &&
    !stillOpen &&
    md.status === 200 &&
    search.status === 200 &&
    verbs.json.verbs.length >= 5 &&
    cp.status === 200 &&
    st.status === 200;

  console.log(pass ? 'ALL_PASS' : 'SOME_FAIL');
  child.kill('SIGTERM');
  await sleep(200);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
