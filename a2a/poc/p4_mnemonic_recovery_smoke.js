'use strict';
/**
 * P4-3 / P4-4 smoke: mnemonic determinism, Shamir 2-of-3, DNS domain verify (injectable resolver),
 * recovery initiate/veto with short veto window.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const domainVerify = require('../lib/domain_verify');
const mnemonicLib = require('../lib/mnemonic');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = Number(process.env.SMOKE_PORT || 3144);
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { json = { raw: b }; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  let fails = 0;
  const check = (name, cond) => {
    console.log(cond ? 'OK' : 'FAIL', name);
    if (!cond) fails++;
  };

  // --- offline crypto ---
  const mn = mnemonicLib.generateMnemonic(256);
  check('24 words', mn.trim().split(/\s+/).length === 24);
  const a = mnemonicLib.deriveFromMnemonic(mn);
  const b = mnemonicLib.deriveFromMnemonic(mn);
  check('deterministic did', a.did === b.did);
  check('deterministic pem', a.privateKeyPem === b.privateKeyPem);

  const agentA = new Agent({ name: 'mne_a', baseUrl: BASE });
  const did1 = agentA.fromMnemonic(mn);
  const agentB = new Agent({ name: 'mne_b', baseUrl: BASE });
  const did2 = agentB.fromMnemonic(mn);
  check('SDK fromMnemonic same did', did1 === did2 && did1 === a.did);

  const split = mnemonicLib.splitMnemonic(mn, 3);
  check('threshold 2', split.threshold === 2 && split.shares.length === 3);
  const rebuilt = mnemonicLib.combineMnemonic([split.shares[0], split.shares[2]]);
  check('shamir roundtrip', rebuilt === mn);
  const again = mnemonicLib.deriveFromMnemonic(rebuilt);
  check('shamir → same key', again.did === a.did);

  // --- server ---
  const child = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ID: 'p4smoke',
      DATA_DIR: path.join(__dirname, '..', '.data-p4-smoke-' + PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'smoke-p4-' + Date.now() + '.db'),
      RECOVERY_VETO_MS: '1500',
      IPFS_DISABLED: '1',
      ALLOW_DEFAULT_FED_SECRET: '1',
      DOMAIN_VERIFY_MOCK_JSON: JSON.stringify({ 'example.com': a.did }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  child.stdout.on('data', (d) => { if (d.toString().includes(`on :${PORT}`)) ready = true; });
  child.stderr.on('data', (d) => { process.stderr.write(d); });
  for (let i = 0; i < 100 && !ready; i++) await sleep(50);
  if (!ready) {
    console.error('server failed to start');
    child.kill();
    process.exit(1);
  }

  const agent = new Agent({ name: 'p4_domain_bot', capabilities: ['test'], baseUrl: BASE });
  agent.fromMnemonic(mn);
  await agent.register();
  check('registered', !!agent.agentId && agent.did === a.did);

  domainVerify.setResolveTxt(async (host) => {
    if (host === '_moye.example.com') return [[agent.did]];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  });
  const offline = await domainVerify.verifyDomainDid('example.com', agent.did);
  check('dns mock hit (in-process)', offline.ok === true);
  domainVerify.resetResolveTxt();

  const dv = await req('POST', `/api/agents/${agent.agentId}/domain-verify`, {
    domain: 'example.com', ts: Date.now(),
  }, { Authorization: 'Bearer ' + agent.token });
  check('domain-verify HTTP', dv.status === 200 && dv.json.verified_domain === 'example.com'
    && typeof dv.json.verified_display === 'string' && dv.json.verified_display.includes('@example.com'));

  const rev = await req('POST', `/api/agents/${agent.agentId}/domain-verify`, {
    revoke: true, ts: Date.now(),
  }, { Authorization: 'Bearer ' + agent.token });
  check('domain revoke', rev.status === 200 && rev.json.verified_domain == null);

  // Server recovery ceremony (Bearer)
  const init = await req('POST', `/api/agents/${agent.agentId}/recovery/initiate`, {
    reason: 'smoke', ts: Date.now(),
  }, { Authorization: 'Bearer ' + agent.token });
  check('recovery initiate', init.status === 200 && init.json.recovery && init.json.recovery.status === 'pending');

  const tooSoon = await req('POST', `/api/agents/${agent.agentId}/recovery/complete`, {
    ts: Date.now(),
  }, { Authorization: 'Bearer ' + agent.token });
  check('complete blocked in window', tooSoon.status === 409);

  const veto = await req('POST', `/api/agents/${agent.agentId}/recovery/veto`, {
    ts: Date.now(),
  }, { Authorization: 'Bearer ' + agent.token });
  check('recovery veto', veto.status === 200 && veto.json.recovery.status === 'vetoed');

  // Second initiate + wait + complete
  await req('POST', `/api/agents/${agent.agentId}/recovery/initiate`, {
    reason: 'smoke2', ts: Date.now(),
  }, { Authorization: 'Bearer ' + agent.token });
  await sleep(1600);
  const done = await req('POST', `/api/agents/${agent.agentId}/recovery/complete`, {
    ts: Date.now(),
  }, { Authorization: 'Bearer ' + agent.token });
  check('recovery complete', done.status === 200 && done.json.recovery.status === 'completed');

  child.kill('SIGTERM');
  try { child.kill('SIGKILL'); } catch { /* */ }

  console.log(fails ? 'SOME_FAIL ' + fails : 'ALL_PASS');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
