'use strict';
// Local smoke test for ADR-0013 firehose (P1-1). Spawns a throwaway node on :3110.
const { spawn } = require('child_process');
const http = require('http');
const { generateKeyPairSync } = require('crypto');
const path = require('path');

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on('error', reject);
  });
}

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function collectNdjson(pathAndQuery, { untilType, timeoutMs = 3000, trigger } = {}) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(BASE + pathAndQuery, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { events.push(JSON.parse(line)); } catch { /* skip */ }
        }
        if (untilType && events.some((e) => e.type === untilType)) {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, events });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, headers: {}, events }));
    if (trigger) setTimeout(trigger, 150);
    setTimeout(() => { req.destroy(); resolve({ status: 0, headers: {}, events }); }, timeoutMs);
  });
}

async function registerOnce(name) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  return post('/api/agents', { name, capabilities: ['test'], pubkey: pubPem });
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'local-test',
      PORT: String(PORT),
      ENABLE_FIREHOSE: '1',
      FIREHOSE_HEARTBEAT_MS: '5000',
      FIREHOSE_MAX_CLIENTS: '32',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let ready = false;
  child.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes(`on :${PORT}`)) ready = true;
  });
  child.stderr.on('data', (d) => process.stderr.write(d));

  for (let i = 0; i < 80 && !ready; i++) await sleep(50);
  if (!ready) {
    console.error('FAIL server did not start');
    child.kill();
    process.exit(1);
  }

  const info = await get('/api/stream/info');
  console.log('INFO', info.status, info.body);
  if (info.status !== 200 || !JSON.parse(info.body).enabled) {
    console.error('FAIL info');
    child.kill();
    process.exit(1);
  }

  const net = await get('/.well-known/moye-net');
  const netBody = JSON.parse(net.body);
  console.log('FEATURES_HAS_FIREHOSE', (netBody.features || []).includes('firehose'));
  console.log('JOIN_FIREHOSE', !!netBody.join && !!netBody.join.firehose);

  const sub = await collectNdjson('/api/stream.ndjson', {
    untilType: 'agent.register',
    timeoutMs: 4000,
    trigger: () => registerOnce('firehose-test-' + Date.now()),
  });
  console.log('NDJSON_HELLO', sub.events.some((e) => e.type === 'firehose.hello'));
  const reg = sub.events.find((e) => e.type === 'agent.register');
  console.log('NDJSON_REGISTER', !!reg, reg && reg.data && reg.data.name);

  const sse = await new Promise((resolve) => {
    const req = http.get(BASE + '/api/stream', (res) => {
      let chunks = 0;
      let sample = '';
      res.on('data', (c) => {
        chunks += 1;
        sample += c.toString();
        if (chunks >= 2) {
          req.destroy();
          resolve({ status: res.statusCode, type: res.headers['content-type'], sample: sample.slice(0, 200) });
        }
      });
    });
    setTimeout(() => { req.destroy(); resolve({ status: 0 }); }, 2000);
  });
  console.log('SSE', sse);

  const filtered = await collectNdjson('/api/stream.ndjson?types=agent.register', {
    untilType: 'agent.register',
    timeoutMs: 4000,
    trigger: () => registerOnce('fh-filter-' + Date.now()),
  });
  const ledgerTypes = filtered.events.filter((e) => e.type && !String(e.type).startsWith('firehose')).map((e) => e.type);
  console.log('FILTER_TYPES', [...new Set(ledgerTypes)]);

  const pass =
    info.status === 200 &&
    (netBody.features || []).includes('firehose') &&
    sub.events.some((e) => e.type === 'firehose.hello') &&
    !!reg &&
    sse.status === 200 &&
    String(sse.type || '').includes('text/event-stream') &&
    ledgerTypes.every((t) => t === 'agent.register');

  console.log(pass ? 'ALL_PASS' : 'SOME_FAIL');
  child.kill('SIGTERM');
  await sleep(200);
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
