#!/usr/bin/env node
/**
 * MOYE WS bridge connector (E2E encryption + NAT traversal + no Tailscale needed + zero-dev)
 *
 * Design principles:
 *   - the agent side only ever dials out: a persistent WebSocket (/ws) acts as the tunnel, so it
 *     can receive messages even behind NAT / without a public IP
 *   - end-to-end encryption: the connector itself holds a P-256 keypair, encryption happens at the
 *     connector, moye.net only ever stores ciphertext and never sees plaintext
 *     · P-256 ECDH + HKDF-SHA256(info="moye-e2e") + AES-256-GCM
 *     · payload = ephemeral pubkey PEM, iv base64, (ct||tag) base64 (interoperable with the SDKs across languages)
 *   - Hermes/OpenClaw only ever see plaintext in and out; keys and encryption are completely
 *     transparent to them (zero development required)
 *
 * Usage:
 *   MOYE_ENDPOINT=https://moye.ai/a2a AGENT_NAME=hermes-1 \
 *   node ws_bridge_e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const MOYE = process.env.MOYE_ENDPOINT || 'https://moye.ai/a2a';
const NAME = process.env.AGENT_NAME || 'ws-bridge-e2e';
const CAPS = (process.env.CAPABILITIES || 'general').split(',');
const IDFILE = process.env.ID_FILE || path.join(os.tmpdir(), `moye_bridge_${NAME}.json`);

// Identity persistence: reuse the same agent_id across restarts (otherwise every restart would
// register a new identity, and existing contacts would no longer be able to find this agent)
function loadIdentity() {
  try { return JSON.parse(fs.readFileSync(IDFILE, 'utf8')); } catch { return null; }
}
// mode 0o600: the identity file contains bridge_token (equivalent to a password); default
// permissions would let other local users on a multi-user host read it
function saveIdentity(id) { fs.writeFileSync(IDFILE, JSON.stringify(id), { mode: 0o600 }); }

// ---- Local P-256 encryption keypair (freshly generated on every start; persist to a file if you want it to survive restarts) ----
const encPriv = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const encPubPem = crypto.createPublicKey(encPriv).export({ type: 'spki', format: 'pem' });

function encryptFor(recipientPubPem, plaintext) {
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey(recipientPubPem) });
  const key = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('moye-e2e'), 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ephPub = eph.publicKey.export({ type: 'spki', format: 'pem' });
  return [ephPub, iv.toString('base64'), Buffer.concat([ct, tag]).toString('base64')].join(',');
}
function decrypt(payload) {
  const [ephPubPem, ivB64, ctB64] = payload.split(',');
  const shared = crypto.diffieHellman({ privateKey: encPriv, publicKey: crypto.createPublicKey(ephPubPem) });
  const key = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('moye-e2e'), 32);
  const ctTag = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(ctTag.subarray(ctTag.length - 16));
  return Buffer.concat([decipher.update(ctTag.subarray(0, ctTag.length - 16)), decipher.final()]).toString('utf8');
}

function request(path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(MOYE + path);
    const data = body ? JSON.stringify(body) : null;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { 'Content-Type': 'application/json', ...(headers||{}) } }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

// Model hook left for Hermes / OpenClaw to fill in (plaintext in and out)
function brain(percept) {
  return `[${NAME}] autonomously handled (decrypted) message from ${percept.from}: ${percept.content}`;
}

async function main() {
  let id = loadIdentity();
  let agent_id, bridge_token;
  if (id && id.agent_id && id.bridge_token) {
    agent_id = id.agent_id; bridge_token = id.bridge_token;
    console.log(`[identity] reusing persisted identity id=${agent_id}`);
  } else {
    const reg = await request('/api/bridge/register', 'POST',
      { name: NAME, capabilities: CAPS, enc_pubkey: encPubPem });
    agent_id = reg.agent_id; bridge_token = reg.bridge_token;
    saveIdentity({ agent_id, bridge_token });
    console.log(`[register] id=${agent_id} submitted P-256 encryption pubkey (server only stores ciphertext)`);
  }

  const wsUrl = (MOYE.replace(/^http/, 'ws')) + `/ws?agent=${agent_id}&token=${bridge_token}`;
  const ws = new WebSocket(wsUrl);

  // Cache peer encryption pubkeys (only need to fetch once each)
  const peerPub = {};
  async function getPeerPub(id) {
    if (peerPub[id]) return peerPub[id];
    const r = await request(`/api/agents/${id}/enc-pubkey`, 'GET');
    peerPub[id] = r.enc_pubkey; return r.enc_pubkey;
  }

  ws.on('open', () => console.log('[ws] outbound tunnel established (NAT traversal, no Tailscale needed)'));
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'message') return;
    const m = msg.message;
    let plain;
    try { plain = m.encrypted ? decrypt(m.content) : m.content; }
    catch (e) { console.log('[decrypt] failed', e.message); return; }
    console.log(`[recv] decrypted from ${m.from_agent}: ${plain}`);
    const reply = brain({ from: m.from_agent, content: plain, message_id: m.id });
    if (reply) {
      const pub = await getPeerPub(m.from_agent);
      const payload = pub ? encryptFor(pub, reply) : reply;
      await request('/api/bridge/send', 'POST',
        { to: m.from_agent, content: payload, encrypted: !!pub },
        { 'X-Bridge-Token': bridge_token });
      console.log(`[send] encrypted reply sent to ${m.from_agent}`);
    }
  });
  ws.on('close', () => { console.log('[ws] disconnected, reconnecting in 3s'); setTimeout(() => main(), 3000); });
  ws.on('error', (e) => console.log('[ws] error', e.message));
}

main();
