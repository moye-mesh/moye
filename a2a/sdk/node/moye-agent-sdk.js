'use strict';
/**
 * MOYE Agent SDK (Node.js)
 * Supports both Bearer token and DID signature auth.
 *
 * Decentralized usage:
 *   const crypto = require('crypto');
 *   const { Agent } = require('moye-agent-sdk');
 *   const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
 *   const agent = new Agent({ name: 'my_bot', capabilities: ['translate'] });
 *   agent.fromPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
 *   await agent.register();  // returns agent_id; once the did is derived it's on agent.did
 *   await agent.send(otherId, 'hi');  // automatically signed with the private key
 *   await agent.ledgerVerify();
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

class MoyeError extends Error {}

// P4-3 mnemonic/Shamir support lives in a2a/lib/ (not distributed under /sdk-dist), so it's
// required lazily — the rest of this SDK must keep working for a standalone single-file
// download even though these specific methods can't, yet.
let _mnemonicLib = null;
function mnemonicLib() { return _mnemonicLib || (_mnemonicLib = require('../../lib/mnemonic')); }
let _shamirLib = null;
function shamirLib() { return _shamirLib || (_shamirLib = require('../../lib/shamir')); }

// Deterministic JSON (recursively sorted keys) -- module-level so static methods (no `this`) can
// use it too. Same algorithm as the instance _canonical() method and a2a/lib/agent_profile.js's
// stableStringify -- must byte-match the server's canonicalization or signatures won't verify.
function canonicalStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}';
}

// ADR-0038 M8/M9 profile + webhook signing: inlined here (not required from a2a/lib/) so the
// standalone SDK file keeps working for a single-file download -- the same reasoning as the
// mnemonic/Shamir lazy-load above, but register() and verifyWebhookPush() are common/primary
// paths (not an optional feature), so lazy-loading an unavailable lib/ file isn't good enough:
// it would still throw the moment either is actually used, which for register() is almost always.
function profileFields({ name, description, capabilities, endpoint, webhook_url }) {
  return {
    name: name || '',
    description: description || '',
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    endpoint: endpoint || '',
    webhook_url: webhook_url || null,
  };
}
function signProfileLocal(privatePem, fields) {
  const msg = canonicalStringify(profileFields(fields));
  return crypto.sign(null, Buffer.from(msg, 'utf8'), crypto.createPrivateKey(privatePem)).toString('base64');
}
function verifyProfileLocal(pubPem, fields, sigB64) {
  if (!pubPem || !sigB64) return false;
  try {
    const msg = canonicalStringify(profileFields(fields));
    return crypto.verify(null, Buffer.from(msg, 'utf8'), crypto.createPublicKey(pubPem), Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}
function contentHashLocal(content) {
  if (content === undefined || content === null) return null;
  return crypto.createHash('sha256').update(String(content)).digest('hex');
}
function attachmentsHashLocal(attachments) {
  if (attachments === undefined || attachments === null) return null;
  const arr = Array.isArray(attachments) ? attachments : [attachments];
  if (!arr.length) return null;
  return crypto.createHash('sha256').update(canonicalStringify(arr)).digest('hex');
}
function webhookSignedFields(payload) {
  const fields = {
    event: payload.event || null,
    id: payload.id || null,
    from_agent: payload.from_agent || null,
    to_agent: payload.to_agent || null,
    content_hash: Object.prototype.hasOwnProperty.call(payload, 'content_hash')
      ? payload.content_hash : contentHashLocal(payload.content),
    attachments_hash: Object.prototype.hasOwnProperty.call(payload, 'attachments_hash')
      ? payload.attachments_hash : attachmentsHashLocal(payload.attachments),
    ts: payload.ts || null,
  };
  if (payload.room_id) fields.room_id = payload.room_id;
  return fields;
}
// Mirrors a2a/lib/webhook_sig.js verifyWebhook() exactly, including the round-3 fix: a signed
// hash that's non-null requires the matching raw field to actually be present, so an attacker
// who deletes (not just rewrites) content/attachments while leaving the original hash in place
// is rejected the same way as one who rewrites it. Keep this in sync with lib/webhook_sig.js.
function verifyWebhookLocal(nodePubPem, payload, sigB64) {
  if (!nodePubPem || !sigB64) return false;
  const fields = webhookSignedFields(payload);
  if (fields.content_hash != null
    && (!Object.prototype.hasOwnProperty.call(payload, 'content')
      || contentHashLocal(payload.content) !== fields.content_hash)) return false;
  if (fields.attachments_hash != null
    && (!Object.prototype.hasOwnProperty.call(payload, 'attachments')
      || attachmentsHashLocal(payload.attachments) !== fields.attachments_hash)) return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalStringify(fields), 'utf8'),
      crypto.createPublicKey(nodePubPem), Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

function request(baseUrl, method, path, data, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl.replace(/\/$/, '') + path);
    const payload = data ? JSON.stringify(data) : null;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const retryable = res.statusCode >= 500;
        try {
          const json = JSON.parse(body);
          if (!json.success) {
            const err = new MoyeError(json.error || `HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.code = json.code || json.error;
            if (json.home_node) err.home_node = json.home_node;
            if (json.queued != null) err.queued = json.queued;
            // Application 5xx (inbox home down) must not hop to another seed.
            const app = err.code === 'home_unreachable' || err.code === 'wrong_home';
            err.retryable = retryable && !app;
            return reject(err);
          }
          resolve(json);
        } catch (e) {
          const err = new MoyeError('bad response: ' + body);
          err.statusCode = res.statusCode;
          err.retryable = retryable;
          reject(err);
        }
      });
    });
    req.on('error', (e) => {
      e.retryable = true;
      reject(e);
    });
    // pickReachableBaseUrl / ensureReachable pass timeoutMs. Instance _req leaves this unset
    // so long-lived JSON calls keep the previous no-client-timeout behavior.
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        const err = new MoyeError('request timed out');
        err.retryable = true;
        req.destroy(err);
      });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizeBase(url) {
  return String(url || '').replace(/\/$/, '');
}

function isLoopbackBase(url) {
  try {
    const u = new URL(normalizeBase(url));
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      || u.hostname === '::1' || u.hostname === '[::1]';
  } catch { return false; }
}

function uniqueBases(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    if (!raw) continue;
    const c = normalizeBase(raw);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

// Last-resort public entry points (same set as live PEERS / status). A self-hosted
// node URL that is not in this list does not fail over onto them.
const DEFAULT_SEEDS = [
  'https://moye.ai/a2a',
  'https://node2-origin.moye.ai',
  'https://node3-origin.moye.ai',
];

function isKnownPublicSeed(url) {
  const n = normalizeBase(url);
  return DEFAULT_SEEDS.includes(n) || n === 'https://origin.moye.ai';
}

function isRetryableRequestError(err) {
  if (!err) return false;
  if (err.code === 'home_unreachable' || err.code === 'wrong_home') return false;
  if (err.retryable) return true;
  const code = err.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET'
    || code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EAI_AGAIN';
}

class Agent {
  constructor({ name, capabilities = [], description = '', endpoint = '', owner = '', webhookUrl = null, baseUrl = 'https://moye.ai/a2a', agentId = null, token = null } = {}) {
    if (!name) throw new MoyeError('name required');
    this.name = name;
    this.capabilities = capabilities;
    this.description = description;
    this.endpoint = endpoint;
    this.owner = owner;
    this.webhookUrl = webhookUrl || null;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.agentId = agentId;
    this.token = token;
    this._priv = null;
    this.did = null;
    this._seedList = null;
  }

  // ---------- DID ----------
  // P4-3: NEW identities only. Existing randomly generated keys cannot be retrofitted to a mnemonic.
  static generateMnemonic(strength = 256) {
    return mnemonicLib().generateMnemonic(strength);
  }

  static existingIdentityMnemonicNote() {
    return mnemonicLib().EXISTING_IDENTITY_NOTE;
  }

  /**
   * Load identity from a BIP-39 mnemonic (deterministic Ed25519 via SLIP-0010 m/10086'/0').
   * Cannot recover an already-registered random-key identity from a newly invented mnemonic.
   */
  fromMnemonic(mnemonic, passphrase = '') {
    const d = mnemonicLib().deriveFromMnemonic(mnemonic, passphrase);
    this._priv = d.privateKeyPem;
    this.did = d.did;
    this._fromMnemonic = true;
    return this.did;
  }

  /** Shamir 2-of-3 (threshold = floor(n/2)+1) over the mnemonic UTF-8 bytes. */
  static splitMnemonic(mnemonic, n = 3) {
    return mnemonicLib().splitMnemonic(mnemonic, n);
  }

  static combineMnemonic(shares) {
    return mnemonicLib().combineMnemonic(shares);
  }

  generateIdentity() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    this._priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    this._fromMnemonic = false;
    return this._deriveDid(publicKey.export({ type: 'spki', format: 'pem' }));
  }

  fromPrivateKey(pem) {
    this._priv = pem;
    this._fromMnemonic = false;
    const pub = crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' });
    return this._deriveDid(pub);
  }

  _deriveDid(pubPem) {
    const der = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
    // did:moye:f1220<64 hex> = multibase base16 + multihash(sha2-256,32B) + digest.
    // Untruncated and self-describing; must match lib/did.js exactly (ADR-0017).
    this.did = 'did:moye:f1220' + crypto.createHash('sha256').update(der).digest('hex');
    return this.did;
  }

  _pubkeyPem() {
    return crypto.createPublicKey(this._priv).export({ type: 'spki', format: 'pem' });
  }

  _sign(payload) {
    return crypto.sign(null, Buffer.from(JSON.stringify(payload)), crypto.createPrivateKey(this._priv)).toString('base64');
  }

  /** ADR-0043 gap 2: let the master identity's signing happen OUTSIDE this process -- e.g. a
   *  browser wallet extension or hardware key -- so the master private key never needs to be
   *  loaded here at all. this.did is set directly (a DID is public, shareable); every signature
   *  the master identity would normally produce with this._priv is instead requested via
   *  signFn(bytes) => Promise<string> (base64 signature). Scoped narrowly to the ADR-0043 use
   *  case (minting a scoped session key without a browser tab ever holding the master key) --
   *  wired into issueCredential()/createSession() only. Every other method on this class still
   *  requires this._priv exactly as before; this does not turn Agent into a general remote-signer.
   */
  useExternalSigner(did, signFn) {
    if (!did) throw new MoyeError('useExternalSigner requires the master did');
    if (typeof signFn !== 'function') throw new MoyeError('signFn must be (bytes: Buffer) => Promise<string> (base64 signature)');
    this.did = did;
    this._externalSign = signFn;
    return this;
  }

  async _masterSign(bytes) {
    if (this._externalSign) return this._externalSign(bytes);
    if (!this._priv) throw new MoyeError('no signing capability: call fromPrivateKey()/generateIdentity() or useExternalSigner() first');
    return crypto.sign(null, bytes, crypto.createPrivateKey(this._priv)).toString('base64');
  }

  // Header-only DID signing for GET requests (no body at all) -- see inbox()'s history comment for
  // why: signing a body on GET doesn't survive the production Cloudflare Worker (Fetch spec forbids
  // a body on GET/HEAD). Shared by inbox() and roomMessages(); matches server.js authAgent()'s
  // header branch exactly (signs {method, path, ts}, ts also sent via X-Moye-Ts).
  // `path` must match Express req.path (no ?query). Strip query if a caller passes a full URL path.
  _didHeadersForGet(path) {
    if (!this._priv) return {};
    const pathOnly = String(path || '').split('?')[0];
    const ts = Date.now();
    const sig = this._sign({ method: 'GET', path: pathOnly, ts });
    const h = { 'X-Moye-Did': this.did, 'X-Moye-Sig': sig, 'X-Moye-Ts': String(ts) };
    if (this._sessionDid) h['X-Moye-Session'] = this._sessionDid;
    return h;
  }

  // Deterministic JSON (recursively sorted keys) -- the shared canonical form for sender_sig, so
  // Node/Python/Rust all sign & verify identical bytes. Matches the server's stableStringify.
  _canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => this._canonical(x)).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + this._canonical(v[k])).join(',') + '}';
  }

  // F3: sign {from, to, content_hash} so the recipient (and any third party) can verify this message
  // really came from `from`, independent of any relaying node. content_hash = sha256(content) -- for
  // E2E messages that's the ciphertext hash, so no plaintext is exposed. No timestamp: this attests
  // authorship of the content, not freshness (the DID envelope's `ts` already prevents replay), and
  // the recipient can reconstruct all three fields from the inbox row without the server persisting a ts.
  _senderSig(from, to, content) {
    if (!this._priv) return null;
    const content_hash = crypto.createHash('sha256').update(content).digest('hex');
    const msg = this._canonical({ from, to, content_hash });
    return crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey(this._priv)).toString('base64');
  }

  // Verify a received message's sender_sig against the sender's Ed25519 DID pubkey (fetched + cached).
  // `to` is this agent (it's our inbox). Returns true/false, or null if the message carries no sig.
  async _verifySender(msg) {
    if (!msg || !msg.sender_sig || !msg.from_agent) return null;
    try {
      if (!this._pubCache) this._pubCache = {};
      let pub = this._pubCache[msg.from_agent];
      if (!pub) { pub = (await this._req( 'GET', `/api/agents/${msg.from_agent}/pubkey`)).pubkey; this._pubCache[msg.from_agent] = pub; }
      if (!pub) return false;
      const content_hash = crypto.createHash('sha256').update(msg.content).digest('hex');
      const canon = this._canonical({ from: msg.from_agent, to: msg.to_agent || this.agentId, content_hash });
      return crypto.verify(null, Buffer.from(canon), crypto.createPublicKey(pub), Buffer.from(msg.sender_sig, 'base64'));
    } catch { return false; }
  }

  _didHeaders(payload) {
    if (!this.did || !this._priv) return {};
    // Anti-replay: stamp a fresh millisecond timestamp INTO the signed body. The very same object
    // is what gets sent as the request body (callers pass this same reference), so `ts` travels with
    // the signature and the server can reject stale or already-spent signatures. Servers running
    // with ALLOW_UNSIGNED_TS=1 still accept bodies without it during a migration window.
    if (payload && typeof payload === 'object' && payload.ts === undefined) payload.ts = Date.now();
    const h = { 'X-Moye-Did': this.did, 'X-Moye-Sig': this._sign(payload) };
    if (this._sessionDid) h['X-Moye-Session'] = this._sessionDid;
    return h;
  }

  _headers(extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    if (this.token && !this._priv) h['Authorization'] = 'Bearer ' + this.token;
    return h;
  }

  // Generates a P-256 encryption keypair, returns the public key PEM for submission with registration
  generateEncryptionKey() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this._encPriv = privateKey.export({ type: 'sec1', format: 'pem' });
    return publicKey.export({ type: 'spki', format: 'pem' });
  }

  setEncryptionKey(privPem) { this._encPriv = privPem; }

  _encPubkeyForRegister() {
    if (!this._encPriv) return null;
    return crypto.createPublicKey(this._encPriv).export({ type: 'spki', format: 'pem' });
  }

  // Derives a shared key via ECDH + encrypts with AES-256-GCM (P-256, HKDF-SHA256, matching Python/Rust)
  _encryptFor(recipientPubPem, plaintext) {
    const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey(recipientPubPem) });
    const key = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('moye-e2e'), 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Payload = ephemeral-public-key PEM + iv + base64(ct||tag), comma-separated (matching Python/Rust)
    const ephPub = eph.publicKey.export({ type: 'spki', format: 'pem' });
    return [ephPub, iv.toString('base64'), Buffer.concat([ct, tag]).toString('base64')].join(',');
  }

  _decrypt(payload) {
    const [ephPubPem, ivB64, ctB64] = payload.split(',');
    const shared = crypto.diffieHellman({ privateKey: crypto.createPrivateKey(this._encPriv), publicKey: crypto.createPublicKey(ephPubPem) });
    const key = crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('moye-e2e'), 32);
    const ctTag = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(ctTag.subarray(ctTag.length - 16));
    const pt = Buffer.concat([decipher.update(ctTag.subarray(0, ctTag.length - 16)), decipher.final()]);
    return pt.toString('utf8');
  }

  // ---------- Room privacy / group E2E encryption (2026-07-24) ----------
  // Trust model: the server NEVER sees the raw room secret or the derived encryption key, only a
  // one-way "membership proof" hash used purely for API-level access control. Even a fully
  // compromised server can't decrypt room chat -- only holders of the original secret can. See the
  // matching comment block in server.js above the room routes for the full writeup.
  //
  // membership_proof = sha256(secret + ':membership') -- sent to the server (creation/join); the
  // server stores only sha256(that value) and never sees `secret` itself.
  _roomMembershipProof(secret) {
    return crypto.createHash('sha256').update(String(secret) + ':membership').digest('hex');
  }
  // Encryption key is derived independently from the same secret via a DIFFERENT HKDF info string
  // than the membership proof, entirely client-side, never transmitted in any form.
  _roomKey(secret, roomId) {
    return crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), Buffer.from(String(roomId)), Buffer.from('moye-room-e2e'), 32);
  }
  _encryptForRoom(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), Buffer.concat([ct, tag]).toString('base64')].join(',');
  }
  _decryptFromRoom(key, payload) {
    const [ivB64, ctB64] = payload.split(',');
    const ctTag = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(ctTag.subarray(ctTag.length - 16));
    const pt = Buffer.concat([decipher.update(ctTag.subarray(0, ctTag.length - 16)), decipher.final()]);
    return pt.toString('utf8');
  }

  async register() {
    const payload = {
      name: this.name, description: this.description,
      capabilities: this.capabilities, endpoint: this.endpoint, owner: this.owner,
    };
    if (this.webhookUrl) payload.webhook_url = this.webhookUrl;
    if (this._priv) {
      payload.pubkey = this._pubkeyPem();
      // ADR-0038 M8: agent DID signs profile fields at registration
      payload.profile_sig = signProfileLocal(this._priv, {
        name: this.name,
        description: this.description,
        capabilities: this.capabilities,
        endpoint: this.endpoint,
        webhook_url: this.webhookUrl || null,
      });
    }
    if (this._encPriv) payload.enc_pubkey = this._encPubkeyForRegister();
    // P3: optional field, this.p2pAddrs only gets set if sdk/node/p2p.js is installed and
    // attachP2P() is called -- doesn't affect this file's own zero-dependency nature, it's
    // purely a hook left for the p2p module.
    if (this.p2pAddrs) payload.p2p_addrs = this.p2pAddrs;
    const r = await this._req( 'POST', '/api/agents', payload, this._headers());
    this.agentId = r.agent_id;
    this.token = r.token;
    if (r.did) this.did = r.did;
    return this.agentId;
  }

  /** ADR-0038 M8: verify profile_sig on an agent record against its pubkey. */
  static verifyAgentProfile(agent) {
    if (!agent || !agent.pubkey || !agent.profile_sig) return null;
    return verifyProfileLocal(agent.pubkey, {
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities,
      endpoint: agent.endpoint,
      webhook_url: agent.webhook_url || null,
    }, agent.profile_sig);
  }

  /** Update display name / profile labels. Never changes agent_id or DID.
   *  Only keys the caller passes are written; omitted fields stay as stored on the node. */
  async updateProfile(patch = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const provided = {};
    if (patch.name != null) provided.name = String(patch.name).trim();
    if (patch.description != null) provided.description = String(patch.description);
    if (patch.capabilities != null) provided.capabilities = patch.capabilities;
    if (patch.endpoint != null) provided.endpoint = String(patch.endpoint);
    if (patch.webhook_url !== undefined) provided.webhook_url = patch.webhook_url;
    if (!Object.keys(provided).length) throw new MoyeError('no profile fields to update');
    if (provided.name !== undefined && (!provided.name || provided.name.length > 200)) {
      throw new MoyeError('name required (1–200 chars)');
    }
    const live = await this.profile().catch(() => null);
    const merged = {
      name: provided.name != null ? provided.name : ((live && live.name) || this.name || ''),
      description: provided.description != null ? provided.description : ((live && live.description) || this.description || ''),
      capabilities: provided.capabilities != null ? provided.capabilities : ((live && live.capabilities) || this.capabilities || []),
      endpoint: provided.endpoint != null ? provided.endpoint : ((live && live.endpoint) || this.endpoint || ''),
      webhook_url: provided.webhook_url !== undefined ? provided.webhook_url : ((live && live.webhook_url) || this.webhookUrl || null),
    };
    const payload = { ...provided };
    if (this._priv) {
      if (!live) throw new MoyeError('could not load current profile to sign');
      payload.profile_sig = signProfileLocal(this._priv, merged);
    }
    const r = await request(
      this.baseUrl, 'POST', `/api/agents/${this.agentId}/profile`, payload,
      this._headers(this._didHeaders(payload)),
    );
    if (provided.name != null) this.name = provided.name;
    if (provided.description != null) this.description = provided.description;
    if (provided.capabilities != null) this.capabilities = provided.capabilities;
    if (provided.endpoint != null) this.endpoint = provided.endpoint;
    if (provided.webhook_url !== undefined) this.webhookUrl = provided.webhook_url;
    return r;
  }

  /** Room webhook allowlist. null = every membership; [] = no room POSTs; array = those rooms. */
  async setWebhookRooms(rooms) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = { rooms: rooms == null ? null : rooms };
    return request(
      this.baseUrl, 'POST', `/api/agents/${this.agentId}/webhook-rooms`, payload,
      this._headers(this._didHeaders(payload)),
    );
  }

  /** Rename a room's display label only (room_id unchanged). Caller must be a member. */
  async renameRoom(roomId, name) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = { name };
    return request(
      this.baseUrl, 'POST', `/api/rooms/${roomId}/rename`, payload,
      this._headers(this._didHeaders(payload)),
    );
  }

  /** ADR-0038 M9: verify an X-Moye-Sig webhook push against the sending node's pubkey (fetch it
   *  from GET /api/node/identity). Pass the exact parsed JSON body -- content_hash/attachments_hash
   *  travel on the wire, so nothing needs recomputing here. Rejects a signed hash whose matching
   *  raw field was rewritten OR deleted, not just rewritten. */
  static verifyWebhookPush(nodePubPem, wireBody, sigB64) {
    return verifyWebhookLocal(nodePubPem, wireBody, sigB64);
  }

  // Fetches the recipient's encryption public key, encrypts the content, and sends it (E2E)
  async sendEncrypted(to, plaintext, sender) {
    const pub = await this._req( 'GET', `/api/agents/${to}/enc-pubkey`);
    const cipher = this._encryptFor(pub.enc_pubkey, plaintext);
    return this.send(to, cipher, sender, /*encrypted*/ true);
  }

  // Decrypts encrypted messages and verifies each sender's authorship signature (F3).
  // Adds `decrypted` (or null) and `sender_verified` (true/false, or null if the message carried no
  // sender_sig -- e.g. sent by an older client or a room/bridge message).
  async inboxDecrypted(limit = 50) {
    const msgs = await this.inbox(limit);
    for (const m of msgs) {
      if (m.encrypted && this._encPriv) {
        try { m.decrypted = this._decrypt(m.content); } catch { m.decrypted = null; }
      }
      m.sender_verified = await this._verifySender(m);
    }
    return msgs;
  }

  async profile() {
    if (!this.agentId) throw new MoyeError('agent not registered');
    return (await this._req( 'GET', `/api/agents/${this.agentId}`, null, this._headers())).agent;
  }

  // ADR-0006 workstream D3: bootstrap onboarding shouldn't hard-depend on one domain. Tries each
  // candidate base URL in order (e.g. from GET /api/bootstrap/seeds on a seed you already trust, or
  // a hard-coded list of known mirrors) and returns the first one that answers /health, so a client
  // isn't stuck if moye.ai specifically is unreachable but the network itself is fine. Found missing
  // from every SDK during the 2026-07-24 ADR/spec gap audit -- D1/D2 (multi-entry, multi-sig-endorsed
  // seeds lists) existed server-side but no client ever tried more than the one hardcoded default.
  static async pickReachableBaseUrl(seeds, { timeoutMs = 3000 } = {}) {
    if (!Array.isArray(seeds) || !seeds.length) throw new MoyeError('seeds must be a non-empty array of base URLs');
    for (const url of seeds) {
      const cleaned = url.replace(/\/$/, '');
      try {
        await request(cleaned, 'GET', '/health', null, {}, timeoutMs);
        return cleaned;
      } catch (e) { /* try the next seed */ }
    }
    throw new MoyeError('no reachable seed among: ' + seeds.join(', '));
  }

  static seedList({ preferred, extra, includeDefaults = true } = {}) {
    const pref = preferred == null ? [] : Array.isArray(preferred) ? preferred : [preferred];
    const ext = extra == null ? [] : Array.isArray(extra) ? extra : [extra];
    const defaults = includeDefaults ? DEFAULT_SEEDS : [];
    return uniqueBases([...pref, ...ext, ...defaults]);
  }

  static endpointsFromSeedsPayload(json) {
    const seeds = json && json.seeds;
    if (!Array.isArray(seeds)) return [];
    return uniqueBases(seeds.map((s) => (typeof s === 'string' ? s : s && s.endpoint)));
  }

  // Convenience instance form: resolves and sets this.baseUrl in place, so it can be called before
  // register() without needing a second Agent construction step.
  async bootstrap(seeds, opts) {
    this.baseUrl = await Agent.pickReachableBaseUrl(seeds, opts);
    return this.baseUrl;
  }

  // Probe current baseUrl, then other seeds. Loopback and unknown self-hosted URLs do not
  // jump onto the public DEFAULT_SEEDS list. Last-good URL is this.baseUrl after return.
  async ensureReachable({ seeds, skip = [], timeoutMs = 3000, refreshSeeds = true, includeDefaults } = {}) {
    const extra = [...(this._seedList || []), ...(seeds || [])];
    const useDefaults = includeDefaults != null
      ? includeDefaults
      : isKnownPublicSeed(this.baseUrl) || extra.some(isKnownPublicSeed);
    const skipSet = new Set((skip || []).map(normalizeBase));
    const list = Agent.seedList({
      preferred: this.baseUrl,
      extra,
      includeDefaults: useDefaults,
    }).filter((u) => !skipSet.has(u));
    if (!list.length) throw new MoyeError('no reachable seed');
    const chosen = await Agent.pickReachableBaseUrl(list, { timeoutMs });
    this.baseUrl = chosen;
    if (refreshSeeds) {
      try {
        const r = await request(chosen, 'GET', '/api/bootstrap/seeds', null, {}, timeoutMs);
        const more = Agent.endpointsFromSeedsPayload(r);
        if (more.length) {
          this._seedList = Agent.seedList({
            preferred: chosen,
            extra: more,
            includeDefaults: useDefaults,
          });
        }
      } catch { /* best-effort; signed list is optional */ }
    }
    return this.baseUrl;
  }

  async _req(method, path, data, headers, timeoutMs) {
    try {
      return await request(this.baseUrl, method, path, data, headers, timeoutMs);
    } catch (err) {
      if (!isRetryableRequestError(err)) throw err;
      const hasAlt = (this._seedList || []).some((u) => normalizeBase(u) !== this.baseUrl)
        || isKnownPublicSeed(this.baseUrl);
      if (isLoopbackBase(this.baseUrl) && !hasAlt) throw err;
      const failed = this.baseUrl;
      try {
        await this.ensureReachable({ skip: [failed], includeDefaults: isKnownPublicSeed(failed) });
      } catch (e) {
        throw err;
      }
      if (this.baseUrl === failed) throw err;
      return request(this.baseUrl, method, path, data, headers, timeoutMs);
    }
  }

  // Instance form. `send`, `register` and the rest are instance methods, so `agent.discover(...)`
  // is what a caller naturally writes -- and it is what the published quickstart tells them to
  // write. Only the static existed, so that snippet died on "agent.discover is not a function".
  // Defaults to this agent's own baseUrl rather than the public default.
  async discover({ q = '', capability = '' } = {}) {
    return Agent.discover({ q, capability, baseUrl: this.baseUrl });
  }

  static async discover({ q = '', capability = '', baseUrl = 'https://moye.ai/a2a' } = {}) {
    const params = [];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (capability) params.push('capability=' + encodeURIComponent(capability));
    const qs = params.length ? '?' + params.join('&') : '';
    const live = isLoopbackBase(baseUrl)
      ? normalizeBase(baseUrl)
      : await Agent.pickReachableBaseUrl(Agent.seedList({ preferred: baseUrl, includeDefaults: isKnownPublicSeed(baseUrl) || !baseUrl }), { timeoutMs: 3000 }).catch(() => normalizeBase(baseUrl));
    const r = await request(live, 'GET', '/api/agents' + qs);
    return r.agents;
  }

  // ADR-0006 workstream J: resolve a bare DID string to an agent record -- the gap this fills is
  // "I only have a did:moye:... string, not an ag_... id or which node it's on". Tries two paths in
  // order: (1) GET /api/agents/by-did/:did on this instance's own baseUrl -- fast path, works if
  // this node already knows the DID; (2) GET /api/dht/resolve-did/:did on the same baseUrl -- the
  // DHT-based fallback (ADR-0006 F2) that finds which OTHER node(s) know it, if this node runs one.
  // Deliberately does NOT attempt to actually dial/connect across nodes here -- that needs a
  // transport decision (HTTP request to the other node vs libp2p direct-connect via
  // sdk/node/p2p.js's attachP2P) this method has no way to make on the caller's behalf. Once you
  // have an agent_id (from the local fast path) or know which node to ask (from the DHT fallback),
  // use send()/discover() against that node as usual.
  static async resolveDid(did, { baseUrl = 'https://moye.ai/a2a' } = {}) {
    const base = isLoopbackBase(baseUrl)
      ? normalizeBase(baseUrl)
      : await Agent.pickReachableBaseUrl(
        Agent.seedList({ preferred: baseUrl, includeDefaults: isKnownPublicSeed(baseUrl) }),
        { timeoutMs: 3000 }
      ).catch(() => normalizeBase(baseUrl));
    try {
      const r = await request(base, 'GET', `/api/agents/by-did/${encodeURIComponent(did)}`);
      return { found: true, via: 'local', agent_id: r.agent_id, agent: r.agent };
    } catch (e) { /* not known locally, try the DHT fallback below */ }
    try {
      const r = await request(base, 'GET', `/api/dht/resolve-did/${encodeURIComponent(did)}`);
      return { found: r.providers.length > 0, via: 'dht', providers: r.providers, note: r.note };
    } catch (e) {
      return { found: false, via: null, error: e.message };
    }
  }

  async send(to, content, sender, encrypted = false, nonce = null, forceRelay = false) {
    const from = sender || this.agentId;
    if (!from) throw new MoyeError('sender agent_id required');
    if (!this.token && !this._priv) throw new MoyeError('register first (token or DID)');
    const payload = { from_agent: from, to_agent: to, content, encrypted: !!encrypted, nonce, force_relay: !!forceRelay };
    // F3: attach sender authorship signature when we have a DID key (recipient verifies it locally)
    if (this._priv) { const s = this._senderSig(from, to, content); if (s) payload.sender_sig = s; }
    const r = await this._req( 'POST', '/api/messages', payload, this._headers(this._didHeaders(payload)));
    return r.message_id;
  }

  async moveHome(home_node) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = { home_node };
    return this._req('POST', `/api/agents/${this.agentId}/home`, payload, this._headers(this._didHeaders(payload)));
  }

  // Bug found via live end-to-end testing (2026-07-23, MCP server verification): this used to call
  // this._headers() with no DID headers at all, so a DID-identity agent (the recommended,
  // self-sovereign registration path -- generateIdentity()/fromPrivateKey()) could never
  // authenticate this call and always got 401. Bearer-token agents were unaffected (this._headers()
  // already adds the Authorization header for them).
  //
  // First fix attempt sent a signed {ts} body on the GET -- disproved by testing directly against
  // moye.ai's production Cloudflare Worker, which throws (error 1101) constructing the proxied
  // fetch() Request: the Fetch API spec forbids a body on GET/HEAD, so the Worker never even
  // forwards it to origin. GET requests genuinely cannot carry a signed body in this deployment.
  //
  // Fixed instead with a header-only signing scheme matching server.js's authAgent(): sign
  // {method, path, ts} (no body at all) and send ts via X-Moye-Ts alongside X-Moye-Did/X-Moye-Sig,
  // so the server can reconstruct and verify the exact same claim without needing a request body.
  async inbox(limit = 50) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const path = `/api/agents/${this.agentId}/inbox`;
    const headers = this._headers(this._didHeadersForGet(path));
    const r = await this._req( 'GET', path, null, headers);
    return r.messages.slice(0, limit);
  }

  // ADR-0037 R21: cross-room catchup — rooms I am in + awaiting me + overdue + explicit next_cursor.
  async catchup(since = 0) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const path = `/api/agents/${this.agentId}/catchup?since=${encodeURIComponent(String(since || 0))}`;
    return this._req( 'GET', path, null, this._headers(this._didHeadersForGet(`/api/agents/${this.agentId}/catchup`)));
  }

  async awaiting() {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const path = `/api/agents/${this.agentId}/awaiting`;
    return this._req( 'GET', path, null, this._headers(this._didHeadersForGet(path)));
  }

  async ack(messageId, status = 'done') {
    const payload = { status };
    await this._req( 'POST', `/api/messages/${messageId}/ack`, payload, this._headers(this._didHeaders(payload)));
  }

  // Returns { room_id, visibility, secret? } -- `secret` is only present for private rooms, and only
  // ever exists in this process's memory / whatever the caller does with it. Generated locally
  // (crypto.randomBytes) unless the caller supplies one; the server never sees or generates it,
  // matching the trust model in the crypto helpers above. Share the returned secret with whoever
  // should join, out-of-band (e.g. via sendEncrypted() to an agent you already know, or a
  // human-mediated channel) -- MOYE provides the join primitive, not the initial trust bootstrap.
  async createRoom(name, { members = [], visibility = 'public', secret = null, wrapMembers = true } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const isPrivate = visibility === 'private';
    const usedSecret = isPrivate ? (secret || crypto.randomBytes(24).toString('base64url')) : null;
    const payload = { name, members };
    if (isPrivate) { payload.visibility = 'private'; payload.membership_proof = this._roomMembershipProof(usedSecret); }
    const r = await this._req( 'POST', '/api/rooms', payload, this._headers(this._didHeaders(payload)));
    if (isPrivate) {
      this.rememberRoomSecret(r.room_id, usedSecret, 1);
      if (wrapMembers && members && members.length) {
        try {
          await this._ensureEncReady();
          await this.publishRoomWraps(r.room_id, members, { epoch: 1, secret: usedSecret, notify: false });
        } catch (_) { /* invite wrap best-effort; DM invite still sent by server */ }
      }
    }
    return isPrivate ? { room_id: r.room_id, visibility: 'private', secret: usedSecret, key_epoch: 1 } : { room_id: r.room_id, visibility: 'public' };
  }

  // Joins a room. `secret` is required for private rooms (the same value the creator shared
  // out-of-band); omit it for public rooms. Remembers the secret in-memory for this Agent instance
  // so subsequent sendRoomMessage()/roomMessages() calls can encrypt/decrypt automatically.
  async joinRoom(roomId, secret = null, { epoch = 1 } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = {};
    if (secret) payload.membership_proof = this._roomMembershipProof(secret);
    const r = await this._req( 'POST', `/api/rooms/${roomId}/join`, payload, this._headers(this._didHeaders(payload)));
    if (secret) this.rememberRoomSecret(roomId, secret, epoch);
    return r;
  }

  // Posts a room chat message. Encrypts automatically if this instance holds the room's secret
  // (from createRoom()/joinRoom(), or set via rememberRoomSecret()) unless encrypt:false is passed.
  // `type`/`ref` (2026-07-24, scenario 5): structured task-broadcast/task-claim/task-accept
  // convention layered on the chat log -- see the matching comment in server.js. Plain chat messages
  // omit both.
  // ADR-0027: optional `awaiting` (ask; string|string[]), `awaiting_capability` (R12),
  // `schema`+`payload` (R9), `by` deadline ms (R11, ask only).
  async sendRoomMessage(roomId, content, { encrypt, type, ref, awaiting, awaiting_capability, schema, payload, by } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const secret = this._roomSecrets && this._roomSecrets[roomId];
    const shouldEncrypt = encrypt !== false && !!secret;
    const wireContent = shouldEncrypt ? this._encryptForRoom(this._roomKey(secret, roomId), content) : content;
    const body = { content: wireContent, encrypted: shouldEncrypt };
    if (type) body.type = type;
    if (ref) body.ref = ref;
    if (awaiting) body.awaiting = awaiting;
    if (awaiting_capability) body.awaiting_capability = awaiting_capability;
    if (schema != null) body.schema = schema;
    if (payload != null) body.payload = payload;
    if (by != null) body.by = by;
    if (this._priv) { const s = this._senderSig(this.agentId, roomId, wireContent); if (s) body.sender_sig = s; }
    const r = await this._req( 'POST', `/api/rooms/${roomId}/messages`, body, this._headers(this._didHeaders(body)));
    return r.message_id;
  }

  // Reads room chat history, decrypting locally if this instance holds the room's secret. Adds
  // `decrypted` (string or null) to each message that came back encrypted.
  async roomMessages(roomId, limit = 100) {
    const path = `/api/rooms/${roomId}/messages?limit=${limit}`;
    const r = await this._req( 'GET', path, null, this._headers(this._didHeadersForGet(path)));
    for (const m of r.messages || []) {
      if (m.encrypted && m.content) {
        m.decrypted = this._decryptRoomContent(roomId, m.content);
      }
    }
    return r.messages || [];
  }

  // Lets a caller supply a room secret obtained out-of-band (e.g. from a join link) without going
  // through joinRoom() again -- useful once already a member and just resuming a session.
  // Optional epoch (default 1); when a RoomSecretStore is attached, persists across process restarts.
  rememberRoomSecret(roomId, secret, epoch = 1) {
    this._roomSecrets = this._roomSecrets || {};
    this._roomSecrets[roomId] = secret;
    this._roomSecretEpochs = this._roomSecretEpochs || {};
    this._roomSecretEpochs[roomId] = Number(epoch) || 1;
    this._roomSecretHistory = this._roomSecretHistory || {};
    this._roomSecretHistory[roomId] = this._roomSecretHistory[roomId] || {};
    this._roomSecretHistory[roomId][String(Number(epoch) || 1)] = secret;
    if (this._roomSecretStore && typeof this._roomSecretStore.put === 'function') {
      try { this._roomSecretStore.put(roomId, secret, Number(epoch) || 1); } catch (_) { /* vault optional */ }
    }
  }

  // Pluggable persistence (CLI/MCP disk vault). Store shape: { list(), put(roomId, secret, epoch), get?(roomId, epoch) }.
  setRoomSecretStore(store) {
    this._roomSecretStore = store || null;
    if (!store || typeof store.list !== 'function') return;
    this._roomSecrets = this._roomSecrets || {};
    this._roomSecretEpochs = this._roomSecretEpochs || {};
    for (const row of store.list() || []) {
      if (!row || !row.roomId || !row.secret) continue;
      const ep = Number(row.epoch) || 1;
      const cur = this._roomSecretEpochs[row.roomId] || 0;
      // Keep highest epoch as the active encrypt key; still retain older in _roomSecretHistory for decrypt.
      this._roomSecretHistory = this._roomSecretHistory || {};
      this._roomSecretHistory[row.roomId] = this._roomSecretHistory[row.roomId] || {};
      this._roomSecretHistory[row.roomId][String(ep)] = row.secret;
      if (ep >= cur) {
        this._roomSecrets[row.roomId] = row.secret;
        this._roomSecretEpochs[row.roomId] = ep;
      }
    }
  }

  _activeRoomSecret(roomId) {
    return this._roomSecrets && this._roomSecrets[roomId];
  }

  _decryptRoomContent(roomId, content) {
    const hist = (this._roomSecretHistory && this._roomSecretHistory[roomId]) || {};
    const active = this._activeRoomSecret(roomId);
    const candidates = [];
    if (active) candidates.push(active);
    for (const s of Object.values(hist)) {
      if (s && !candidates.includes(s)) candidates.push(s);
    }
    for (const secret of candidates) {
      try { return this._decryptFromRoom(this._roomKey(secret, roomId), content); }
      catch { /* try next epoch */ }
    }
    return null;
  }

  _canonicalWrapOuter(rec) {
    // Stable sign payload: everything except issuer_sig.
    const { issuer_sig, ...rest } = rec;
    return this._canonical(rest);
  }

  _signWrapRecord(rec) {
    return crypto.sign(null, Buffer.from(this._canonicalWrapOuter(rec)), crypto.createPrivateKey(this._priv)).toString('base64');
  }

  async _ensureEncReady() {
    if (!this._encPriv) this.generateEncryptionKey();
    if (!this.agentId) return;
    try {
      await this._req( 'GET', `/api/agents/${this.agentId}/enc-pubkey`);
    } catch {
      const enc_pubkey = this._encPubkeyForRegister();
      if (!enc_pubkey) return;
      const payload = { enc_pubkey };
      await request(
        this.baseUrl, 'POST', `/api/agents/${this.agentId}/enc-pubkey`, payload,
        this._headers(this._didHeaders(payload)),
      ).catch(() => {});
    }
  }

  async publishRoomWraps(roomId, agentIds, { epoch = null, secret = null, notify = true } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    await this._ensureEncReady();
    const usedSecret = secret || this._activeRoomSecret(roomId);
    if (!usedSecret) throw new MoyeError('no room secret in memory — join/create/remember first');
    const ep = epoch != null ? Number(epoch) : (this._roomSecretEpochs && this._roomSecretEpochs[roomId]) || 1;
    const wraps = [];
    const failed = [];
    for (const to of agentIds || []) {
      try {
        const agentRow = await this._req( 'GET', `/api/agents/${to}`);
        const a = agentRow.agent || agentRow;
        const enc = await this._req( 'GET', `/api/agents/${to}/enc-pubkey`);
        const toDid = a.did || null;
        if (!toDid) { failed.push({ agent_id: to, error: 'no DID' }); continue; }
        const inner = {
          v: 1, room_id: roomId, epoch: ep, secret: usedSecret,
          from_did: this.did, to_did: toDid, ts: Date.now(),
        };
        const ciphertext = this._encryptFor(enc.enc_pubkey, JSON.stringify(inner));
        const rec = {
          id: `wrap_${crypto.randomBytes(6).toString('hex')}`,
          room_id: roomId,
          epoch: ep,
          to_agent: to,
          to_did: toDid,
          from_agent: this.agentId,
          ciphertext,
          alg: 'moye-1to1-v1',
          ts: Date.now(),
        };
        rec.issuer_sig = this._signWrapRecord(rec);
        wraps.push(rec);
      } catch (e) {
        failed.push({ agent_id: to, error: e.message || String(e) });
      }
    }
    if (!wraps.length) throw new MoyeError('no wraps published: ' + JSON.stringify(failed));
    const payload = { wraps };
    const r = await request(
      this.baseUrl, 'POST', `/api/rooms/${roomId}/wraps`, payload,
      this._headers(this._didHeaders(payload)),
    );
    if (notify) {
      for (const w of wraps) {
        const note = `[room:${roomId}] Sealed room-key invite (epoch ${ep}). Call acceptRoomInvite / moye_room_accept — no raw secret in this message.`;
        try { await this.send(w.to_agent, note); } catch (_) { /* best-effort */ }
      }
    }
    return { published: wraps.length, wrap_ids: wraps.map(w => w.id), failed, ...r };
  }

  async inviteToRoom(roomId, agentIds, opts = {}) {
    return this.publishRoomWraps(roomId, agentIds, opts);
  }

  async listRoomWraps(roomId, { epoch = null } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const basePath = `/api/rooms/${roomId}/wraps`;
    const path = epoch != null ? `${basePath}?epoch=${encodeURIComponent(String(epoch))}` : basePath;
    const r = await this._req( 'GET', path, null, this._headers(this._didHeadersForGet(basePath)));
    return r.wraps || [];
  }

  async acceptRoomInvite(roomId, { epoch = null, join = true } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    if (!this._encPriv) throw new MoyeError('encryption key required to unwrap room invites — generateEncryptionKey / identity.encPrivateKey');
    const wraps = await this.listRoomWraps(roomId, { epoch });
    if (!wraps.length) throw new MoyeError('no sealed wraps for this agent in room ' + roomId);
    // Prefer highest epoch
    const sorted = wraps.slice().sort((a, b) => Number(b.epoch || 0) - Number(a.epoch || 0));
    let lastErr = null;
    for (const w of sorted) {
      try {
        const plain = JSON.parse(this._decrypt(w.ciphertext));
        if (plain.room_id && plain.room_id !== roomId) throw new Error('wrap room_id mismatch');
        if (plain.to_did && this.did && plain.to_did !== this.did) throw new Error('wrap to_did mismatch');
        const secret = plain.secret;
        const ep = Number(plain.epoch || w.epoch || 1);
        this.rememberRoomSecret(roomId, secret, ep);
        let joined = null;
        if (join) joined = await this.joinRoom(roomId, secret);
        return { room_id: roomId, epoch: ep, wrap_id: w.id, joined };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new MoyeError('failed to unwrap room invite: ' + (lastErr && lastErr.message || lastErr));
  }

  // Rotate the live room secret. Any holder of the current secret may call this (not creator-only).
  // wrapAgentIds: DIDs/agent_ids you still trust — only they get sealed wraps for the new epoch.
  // Omit or pass [] to rotate without re-wrapping anyone (others must get the secret out-of-band
  // or you fork a new room). Does not remove anyone from member_ids.
  async rotateRoomKey(roomId, { wrapAgentIds = null, rewrapMembers = false } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const oldSecret = this._activeRoomSecret(roomId);
    if (!oldSecret) throw new MoyeError('no current room secret in memory/vault — join or accept invite first');
    const newSecret = crypto.randomBytes(24).toString('base64url');
    const payload = {
      current_membership_proof: this._roomMembershipProof(oldSecret),
      membership_proof: this._roomMembershipProof(newSecret),
    };
    const r = await request(
      this.baseUrl, 'POST', `/api/rooms/${roomId}/rotate`, payload,
      this._headers(this._didHeaders(payload)),
    );
    const epoch = r.key_epoch || r.epoch || ((this._roomSecretEpochs && this._roomSecretEpochs[roomId]) || 1) + 1;
    this.rememberRoomSecret(roomId, newSecret, epoch);
    let targets = Array.isArray(wrapAgentIds) ? wrapAgentIds.filter((id) => id && id !== this.agentId) : null;
    // Legacy opt-in: rewrapMembers true with no explicit list → all current member_ids except self.
    if (targets == null && rewrapMembers) {
      const detail = await request(
        this.baseUrl, 'GET', `/api/rooms/${roomId}`, null,
        this._headers(this._didHeadersForGet(`/api/rooms/${roomId}`)),
      );
      targets = ((detail.room && detail.room.member_ids) || []).filter((id) => id !== this.agentId);
    }
    if (targets == null) targets = [];
    let wraps = null;
    if (targets.length) {
      wraps = await this.publishRoomWraps(roomId, targets, { epoch, secret: newSecret, notify: true });
    }
    return {
      room_id: roomId,
      epoch,
      secret: newSecret,
      wrapped: targets,
      wraps,
      note: 'Unwrapped members keep API membership but cannot decrypt new-epoch messages; fork a new room if that is unacceptable. No kick.',
      ...r,
    };
  }

  // ---- R17 (ADR-0034): voluntary ciphertext pinning — default OFF ----
  // Pins CIDs the agent already holds (message attachments). Ciphertext only; never plaintext.
  // Opt-in per room; listPinnedCids() makes resource use visible (Grok Build lesson).
  enableRoomPinning(roomId, { on = true } = {}) {
    this._roomPinning = this._roomPinning || {};
    if (on) this._roomPinning[roomId] = { enabled: true, cids: new Set(this._roomPinning[roomId]?.cids || []) };
    else delete this._roomPinning[roomId];
    return { room_id: roomId, enabled: !!on };
  }

  listPinnedCids(roomId = null) {
    const out = {};
    for (const [rid, st] of Object.entries(this._roomPinning || {})) {
      if (roomId && rid !== roomId) continue;
      out[rid] = { enabled: !!st.enabled, cids: [...(st.cids || [])] };
    }
    return out;
  }

  /**
   * Scan room messages for attachment CIDs marked encrypted (or any CID when room is private /
   * message.encrypted). Records them locally when pinning is enabled for the room.
   * Does not upload or re-fetch bytes — only tracks CIDs already present on the messages.
   */
  async pinRoomCiphertext(roomId, { limit = 200 } = {}) {
    if (!this._roomPinning || !this._roomPinning[roomId] || !this._roomPinning[roomId].enabled) {
      throw new MoyeError('room pinning is OFF for this room — call enableRoomPinning(roomId) first');
    }
    const msgs = await this.roomMessages(roomId, limit);
    const added = [];
    for (const m of msgs) {
      const atts = m.attachments || [];
      for (const a of atts) {
        if (!a || !a.cid) continue;
        // Ciphertext only: require attachment.encrypted or parent message encrypted.
        if (!a.encrypted && !m.encrypted) continue;
        if (!this._roomPinning[roomId].cids.has(a.cid)) {
          this._roomPinning[roomId].cids.add(a.cid);
          added.push(a.cid);
        }
      }
    }
    // Visible announce (optional server registry) — no self-reported contribution counters.
    if (added.length) {
      try {
        const payload = { cids: added };
        await request(
          this.baseUrl, 'POST', `/api/rooms/${roomId}/pins`,
          payload, this._headers(this._didHeaders(payload)),
        );
      } catch { /* local pin list still valid if node lacks route */ }
    }
    return { room_id: roomId, newly_pinned: added, total: this._roomPinning[roomId].cids.size };
  }

  async assignTask(roomId, task, assignees) {
    const payload = { task, assignees };
    const r = await this._req( 'POST', `/api/rooms/${roomId}/tasks`, payload, this._headers(this._didHeaders(payload)));
    return r.task_ids;
  }

  async report(roomId, taskId, result) {
    const payload = { result };
    await this._req( 'POST', `/api/rooms/${roomId}/tasks/${taskId}/report`, payload, this._headers(this._didHeaders(payload)));
  }

  async room(roomId) {
    return this._req( 'GET', `/api/rooms/${roomId}`);
  }

  // ---------- ADR-0005 direction 2: Verifiable Credentials ----------
  // Issues a credential endorsing `subjectDid` for some claim (e.g. {capability, level}, or the
  // {type:'contribution-endorsement', kind, period, metric} shape ADR-0006's honor board reads).
  // Requires this agent to hold a DID identity -- only a key holder can endorse in its own name,
  // same rule the server enforces. Canonical form matches server.js's vcSigningPayload exactly
  // (same recursively-key-sorted JSON as _canonical/_senderSig above): sign everything except `sig`,
  // then attach `sig`. Found missing across all SDKs during the 2026-07-24 ADR/spec gap audit --
  // the server-side endpoint existed but no client could call it without hand-rolling this signing.
  async issueCredential(subjectDid, claim, { expiresAt = null } = {}) {
    if (!this.did || (!this._priv && !this._externalSign)) {
      throw new MoyeError('issuing a credential requires a DID identity (loaded key or useExternalSigner())');
    }
    if (this._sessionDid) throw new MoyeError('session keys cannot issue credentials');
    const vc = { type: 'moye/vc', issuer: this.did, subject: subjectDid, claim, issued_at: Date.now(), expires_at: expiresAt };
    // Two independent signatures, both from the master identity, matching what _didHeaders()
    // would have produced when this._priv was loaded directly:
    //   1. vc.sig -- over the VC's own canonical (sorted-key) form, verified by vcVerify() server-side.
    //   2. the outer request envelope -- over plain (insertion-order) JSON.stringify(body), same as
    //      _sign()/_didHeaders() everywhere else. `ts` lives inside `body` because that is what gets
    //      both signed and sent -- same "one object, both purposes" pattern _didHeaders() documents.
    vc.sig = await this._masterSign(Buffer.from(this._canonical(vc)));
    const body = { credential: vc, ts: Date.now() };
    const outerSig = await this._masterSign(Buffer.from(JSON.stringify(body)));
    const headers = this._headers({ 'X-Moye-Did': this.did, 'X-Moye-Sig': outerSig });
    return this._req( 'POST', '/api/credentials', body, headers);
  }

  // ADR-0014 §2.4: mint a scoped/expiring session key. Returns the hot private key once —
  // the network only ever sees the session pubkey inside the VC claim.
  async createSession({ scope = ['send', 'inbox', 'room.post', 'room.read'], expiresInMs = 7 * 24 * 3600 * 1000 } = {}) {
    if (!this.did || (!this._priv && !this._externalSign) || !this.agentId) {
      throw new MoyeError('createSession requires a registered DID identity (loaded key or useExternalSigner()) and agentId');
    }
    if (this._sessionDid) throw new MoyeError('a session key cannot mint further sessions');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const sessionDid = 'did:moye:f1220' + crypto.createHash('sha256').update(der).digest('hex');
    const expires = Date.now() + Math.max(60_000, Number(expiresInMs) || 0);
    const claim = {
      type: 'session-key',
      session_did: sessionDid,
      pubkey: pubPem,
      scope: Array.isArray(scope) ? scope.slice() : ['*'],
      expires,
    };
    await this.issueCredential(sessionDid, claim, { expiresAt: expires });
    return {
      master_did: this.did,
      agent_id: this.agentId,
      session_did: sessionDid,
      private_key: privPem,
      pubkey: pubPem,
      scope: claim.scope,
      expires,
    };
  }

  // Build an Agent that signs with a session key while acting as the master DID.
  static fromSession({ masterDid, agentId, privateKey, baseUrl = 'https://moye.ai/a2a', name = 'session' } = {}) {
    if (!masterDid || !agentId || !privateKey) throw new MoyeError('fromSession requires masterDid, agentId, privateKey');
    const a = new Agent({ name, agentId, baseUrl });
    a._priv = privateKey;
    const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    a._sessionDid = 'did:moye:f1220' + crypto.createHash('sha256').update(der).digest('hex');
    a.did = masterDid; // act as master; X-Moye-Session carries the session DID
    a._sessionPub = pub;
    return a;
  }

  async revokeSession(sessionDid, { refSig = null } = {}) {
    if (!this.did || !this._priv) throw new MoyeError('revokeSession requires a DID identity');
    if (this._sessionDid) throw new MoyeError('session keys cannot revoke');
    if (!sessionDid) throw new MoyeError('sessionDid required');
    const claim = { type: 'session-key-revoke', session_did: sessionDid };
    if (refSig) claim.ref_sig = refSig;
    return this.issueCredential(sessionDid, claim);
  }

  // Lists credentials received by `agentId` (defaults to self), each already re-verified
  // server-side (`verified: true/false` per entry) -- no local verification needed to trust that flag,
  // though a caller wanting zero server trust could re-derive it from the issuer's public pubkey.
  async credentials(agentId = null) {
    const id = agentId || this.agentId;
    if (!id) throw new MoyeError('agent id required');
    return (await this._req( 'GET', `/api/agents/${id}/credentials`)).credentials;
  }

  // Reads messages newer than `since` (ms epoch, exclusive) + current awaiting set (ADR-0018 R3).
  async roomChanges(roomId, since = 0) {
    const path = `/api/rooms/${roomId}/changes?since=${encodeURIComponent(String(since || 0))}`;
    return this._req( 'GET', path, null, this._headers(this._didHeadersForGet(path)));
  }

  // ADR-0025: reliable + transient-local room subscribe.
  // Composes changes?since= backfill + /ws room_message push, dedupes by message id, reconnects
  // from the last delivered cursor, decrypts when this agent holds the room secret.
  // Returns { stop(), cursor() }. Does not add server-side protocol surface.
  watchRoom(roomId, { since = 0, onMessage, onError, onReconnect, secret = null } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    if (typeof onMessage !== 'function') throw new MoyeError('onMessage required');

    // Prefer the `ws` package over Node's native globalThis.WebSocket (undici). Native WS can
    // surface connection failures as AggregateError that bypass the WHATWG 'error' event and
    // become unhandled process-level exceptions in some Node versions — that killed long-lived
    // listeners (dev 3-for-3: reconnect storm → watch_error:AggregateError → process exit).
    // Override with MOYE_WS_IMPL=native to force globalThis.WebSocket for debugging.
    let WebSocketImpl;
    const preferNative = (process.env.MOYE_WS_IMPL || '').toLowerCase() === 'native';
    try {
      if (!preferNative) {
        try { WebSocketImpl = require('ws'); } catch { /* fall through */ }
      }
      if (!WebSocketImpl && typeof globalThis.WebSocket === 'function') WebSocketImpl = globalThis.WebSocket;
      if (!WebSocketImpl) WebSocketImpl = require('ws');
    } catch {
      throw new MoyeError('watchRoom needs the ws package or Node 22+ global WebSocket');
    }

    let stopped = false;
    let cursor = Number(since) || 0;
    const seen = new Set();
    let ws = null;
    let reconnectTimer = null;
    let connecting = false;
    let backoffMs = 1500;
    const self = this;
    if (secret) this.rememberRoomSecret(roomId, secret);

    function errDetail(e) {
      if (!e) return { message: 'unknown' };
      const out = {
        name: e.name || 'Error',
        message: e.message || String(e),
      };
      if (e.code) out.code = e.code;
      if (Array.isArray(e.errors)) {
        out.errors = e.errors.map((x) => ({
          name: x && x.name, message: x && (x.message || String(x)), code: x && x.code,
        }));
      }
      if (e.cause) out.cause = errDetail(e.cause);
      return out;
    }

    function decryptMsg(m) {
      const out = Object.assign({}, m);
      if (out.encrypted && out.content) {
        if (secret) {
          try { out.decrypted = self._decryptFromRoom(self._roomKey(secret, roomId), out.content); }
          catch { out.decrypted = self._decryptRoomContent(roomId, out.content); }
        } else {
          out.decrypted = self._decryptRoomContent(roomId, out.content);
        }
      }
      return out;
    }

    function deliver(m) {
      if (!m || !m.id || seen.has(m.id)) return;
      seen.add(m.id);
      if ((m.ts || 0) > cursor) cursor = m.ts || cursor;
      // Cap seen-set growth for long-lived watches
      if (seen.size > 5000) {
        const drop = [...seen].slice(0, seen.size - 4000);
        for (const id of drop) seen.delete(id);
      }
      try { onMessage(decryptMsg(m)); }
      catch (e) { if (typeof onError === 'function') onError(e); }
    }

    async function backfill() {
      const r = await self.roomChanges(roomId, cursor);
      const msgs = (r.messages || []).slice().sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
      for (const m of msgs) deliver(m);
      return r;
    }

    function wsUrl() {
      const u = new URL(self.baseUrl.replace(/\/$/, '') + '/ws');
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      if (self._priv && self.did) {
        const ts = Date.now();
        // When self._sessionDid is set (fromSession()), self._priv is the SESSION's own key --
        // this already signs with the right key. What was missing (ADR-0043) is telling the
        // server it's looking at a session signature at all: without the `session` param, the
        // server tried to verify this signature against the MASTER's pubkey and always failed.
        const sig = self._sign({ method: 'WS', path: '/ws', ts });
        u.searchParams.set('did', self.did);
        u.searchParams.set('sig', sig);
        u.searchParams.set('ts', String(ts));
        if (self._sessionDid) u.searchParams.set('session', self._sessionDid);
      } else if (self.token) {
        u.searchParams.set('agent', self.agentId);
        u.searchParams.set('token', self.token);
      } else {
        throw new MoyeError('watchRoom requires DID identity or bearer token');
      }
      return u.toString();
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer) return;
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        self.ensureReachable().catch(() => {});
        if (typeof onReconnect === 'function') {
          try { onReconnect({ cursor, backoff_ms: delay }); } catch { /* */ }
        }
        start().catch((e) => { if (typeof onError === 'function') onError(e); });
      }, delay);
    }

    function openSocket() {
      if (stopped || connecting) return;
      connecting = true;
      let sock;
      try { sock = new WebSocketImpl(wsUrl()); }
      catch (e) {
        connecting = false;
        if (typeof onError === 'function') onError(e);
        scheduleReconnect();
        return;
      }
      ws = sock;
      const onOpen = () => { connecting = false; backoffMs = 1500; };
      const onMessageWs = (ev) => {
        let data = ev && ev.data !== undefined ? ev.data : ev;
        if (Buffer.isBuffer(data)) data = data.toString('utf8');
        let payload;
        try { payload = JSON.parse(String(data)); } catch { return; }
        if (payload && payload.type === 'room_message' && payload.room_id === roomId && payload.message) {
          deliver(payload.message);
        }
      };
      const onClose = () => {
        connecting = false;
        ws = null;
        if (!stopped) scheduleReconnect();
      };
      // Log the real error (was a no-op) so AggregateError / undici failures are diagnosable.
      const onErr = (err) => {
        if (typeof onError === 'function') {
          try { onError(err || new Error('websocket error')); }
          catch { /* */ }
        } else {
          try {
            process.stderr.write(JSON.stringify({ watchRoom_ws_error: errDetail(err) }) + '\n');
          } catch { /* */ }
        }
      };
      if (typeof sock.on === 'function') {
        // ws package
        sock.on('open', onOpen);
        sock.on('message', (data) => onMessageWs({ data }));
        sock.on('close', onClose);
        sock.on('error', onErr);
      } else {
        sock.addEventListener('open', onOpen);
        sock.addEventListener('message', onMessageWs);
        sock.addEventListener('close', onClose);
        sock.addEventListener('error', onErr);
      }
    }

    async function start() {
      if (stopped) return;
      await backfill();
      if (stopped) return;
      openSocket();
    }

    start().catch((e) => {
      if (typeof onError === 'function') onError(e);
      scheduleReconnect();
    });

    return {
      stop() {
        stopped = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) {
          try {
            if (typeof ws.terminate === 'function') ws.terminate();
            else ws.close();
          } catch { /* */ }
          ws = null;
        }
      },
      cursor() { return cursor; },
    };
  }

  // MCP-friendly: wait for the next new message (or timeout). Uses watchRoom under the hood.
  // Default since=now so backfill doesn't immediately resolve on old history; pass an explicit
  // cursor to resume. Returns null on timeout.
  watchRoomNext(roomId, { since = null, timeoutMs = 30000, secret = null } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sub = this.watchRoom(roomId, {
        since: since == null ? Date.now() : since,
        secret,
        onMessage(m) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sub.stop();
          resolve(m);
        },
        onError(e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sub.stop();
          reject(e);
        },
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sub.stop();
        resolve(null);
      }, timeoutMs);
    });
  }

  // ---------- Decentralization: ledger / federation / shared intent ----------
  async ledger(limit = 50) { return this._req( 'GET', '/api/ledger?limit=' + limit); }
  async ledgerVerify() { return this._req( 'GET', '/api/ledger/verify'); }
  async sharedIntent(intent, scope = 'global') {
    const payload = { intent, scope };
    return this._req( 'POST', '/api/shared-intent', payload, this._headers(this._didHeaders(payload)));
  }
  async joinFederation(nodeId, endpoint, name = '') {
    return this._req( 'POST', '/api/federation/nodes', { id: nodeId, endpoint, name }, this._headers());
  }

  // P4-3: ledger-anchored recovery ceremony (veto delay). Client still reconstructs mnemonic offline.
  async initiateRecovery(reason = '') {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = { reason: String(reason || '').slice(0, 500) };
    return this._req( 'POST', `/api/agents/${this.agentId}/recovery/initiate`, payload, this._headers(this._didHeaders(payload)));
  }

  async vetoRecovery() {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = {};
    return this._req( 'POST', `/api/agents/${this.agentId}/recovery/veto`, payload, this._headers(this._didHeaders(payload)));
  }

  async completeRecovery() {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = {};
    return this._req( 'POST', `/api/agents/${this.agentId}/recovery/complete`, payload, this._headers(this._didHeaders(payload)));
  }

  // P4-4: DNS `_moye.<domain>` TXT must contain this agent's DID.
  async verifyDomain(domain) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = { domain };
    return this._req( 'POST', `/api/agents/${this.agentId}/domain-verify`, payload, this._headers(this._didHeaders(payload)));
  }

  async revokeDomain() {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = { revoke: true };
    return this._req( 'POST', `/api/agents/${this.agentId}/domain-verify`, payload, this._headers(this._didHeaders(payload)));
  }

  // R16: volunteer consolidation (any member).
  async consolidateRoom(roomId, { summary, checkpoint_seq, schema, payload } = {}) {
    const body = { summary, checkpoint_seq, schema, payload };
    return this._req( 'POST', `/api/rooms/${roomId}/consolidate`, body, this._headers(this._didHeaders(body)));
  }
}

Agent.DEFAULT_SEEDS = DEFAULT_SEEDS;

module.exports = {
  Agent, MoyeError, mnemonicLib, shamirLib,
  DEFAULT_SEEDS, isLoopbackBase, isKnownPublicSeed,
};
