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
        try {
          const json = JSON.parse(body);
          if (!json.success) return reject(new MoyeError(json.error || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch (e) {
          reject(new MoyeError('bad response: ' + body));
        }
      });
    });
    req.on('error', reject);
    // Only used by pickReachableBaseUrl()'s reachability probe below -- normal calls pass no
    // timeoutMs and keep the old (no client-side timeout) behavior unchanged.
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new MoyeError('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

class Agent {
  constructor({ name, capabilities = [], description = '', endpoint = '', owner = '', baseUrl = 'https://moye.ai/a2a', agentId = null, token = null } = {}) {
    if (!name) throw new MoyeError('name required');
    this.name = name;
    this.capabilities = capabilities;
    this.description = description;
    this.endpoint = endpoint;
    this.owner = owner;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.agentId = agentId;
    this.token = token;
    this._priv = null;
    this.did = null;
  }

  // ---------- DID ----------
  generateIdentity() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    this._priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    return this._deriveDid(publicKey.export({ type: 'spki', format: 'pem' }));
  }

  fromPrivateKey(pem) {
    this._priv = pem;
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
      if (!pub) { pub = (await request(this.baseUrl, 'GET', `/api/agents/${msg.from_agent}/pubkey`)).pubkey; this._pubCache[msg.from_agent] = pub; }
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
    if (this._priv) payload.pubkey = this._pubkeyPem();
    if (this._encPriv) payload.enc_pubkey = this._encPubkeyForRegister();
    // P3: optional field, this.p2pAddrs only gets set if sdk/node/p2p.js is installed and
    // attachP2P() is called -- doesn't affect this file's own zero-dependency nature, it's
    // purely a hook left for the p2p module.
    if (this.p2pAddrs) payload.p2p_addrs = this.p2pAddrs;
    const r = await request(this.baseUrl, 'POST', '/api/agents', payload, this._headers());
    this.agentId = r.agent_id;
    this.token = r.token;
    if (r.did) this.did = r.did;
    return this.agentId;
  }

  // Fetches the recipient's encryption public key, encrypts the content, and sends it (E2E)
  async sendEncrypted(to, plaintext, sender) {
    const pub = await request(this.baseUrl, 'GET', `/api/agents/${to}/enc-pubkey`);
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
    return (await request(this.baseUrl, 'GET', `/api/agents/${this.agentId}`, null, this._headers())).agent;
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

  // Convenience instance form: resolves and sets this.baseUrl in place, so it can be called before
  // register() without needing a second Agent construction step.
  async bootstrap(seeds, opts) {
    this.baseUrl = await Agent.pickReachableBaseUrl(seeds, opts);
    return this.baseUrl;
  }

  static async discover({ q = '', capability = '', baseUrl = 'https://moye.ai/a2a' } = {}) {
    const params = [];
    if (q) params.push('q=' + encodeURIComponent(q));
    if (capability) params.push('capability=' + encodeURIComponent(capability));
    const qs = params.length ? '?' + params.join('&') : '';
    const r = await request(baseUrl.replace(/\/$/, ''), 'GET', '/api/agents' + qs);
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
    const base = baseUrl.replace(/\/$/, '');
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
    const r = await request(this.baseUrl, 'POST', '/api/messages', payload, this._headers(this._didHeaders(payload)));
    return r.message_id;
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
    const r = await request(this.baseUrl, 'GET', path, null, headers);
    return r.messages.slice(0, limit);
  }

  async ack(messageId, status = 'done') {
    const payload = { status };
    await request(this.baseUrl, 'POST', `/api/messages/${messageId}/ack`, payload, this._headers(this._didHeaders(payload)));
  }

  // Returns { room_id, visibility, secret? } -- `secret` is only present for private rooms, and only
  // ever exists in this process's memory / whatever the caller does with it. Generated locally
  // (crypto.randomBytes) unless the caller supplies one; the server never sees or generates it,
  // matching the trust model in the crypto helpers above. Share the returned secret with whoever
  // should join, out-of-band (e.g. via sendEncrypted() to an agent you already know, or a
  // human-mediated channel) -- MOYE provides the join primitive, not the initial trust bootstrap.
  async createRoom(name, { members = [], visibility = 'public', secret = null } = {}) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const isPrivate = visibility === 'private';
    const usedSecret = isPrivate ? (secret || crypto.randomBytes(24).toString('base64url')) : null;
    const payload = { name, members };
    if (isPrivate) { payload.visibility = 'private'; payload.membership_proof = this._roomMembershipProof(usedSecret); }
    const r = await request(this.baseUrl, 'POST', '/api/rooms', payload, this._headers(this._didHeaders(payload)));
    if (isPrivate) { this._roomSecrets = this._roomSecrets || {}; this._roomSecrets[r.room_id] = usedSecret; }
    return isPrivate ? { room_id: r.room_id, visibility: 'private', secret: usedSecret } : { room_id: r.room_id, visibility: 'public' };
  }

  // Joins a room. `secret` is required for private rooms (the same value the creator shared
  // out-of-band); omit it for public rooms. Remembers the secret in-memory for this Agent instance
  // so subsequent sendRoomMessage()/roomMessages() calls can encrypt/decrypt automatically.
  async joinRoom(roomId, secret = null) {
    if (!this.agentId) throw new MoyeError('agent not registered');
    const payload = {};
    if (secret) payload.membership_proof = this._roomMembershipProof(secret);
    const r = await request(this.baseUrl, 'POST', `/api/rooms/${roomId}/join`, payload, this._headers(this._didHeaders(payload)));
    if (secret) { this._roomSecrets = this._roomSecrets || {}; this._roomSecrets[roomId] = secret; }
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
    const r = await request(this.baseUrl, 'POST', `/api/rooms/${roomId}/messages`, body, this._headers(this._didHeaders(body)));
    return r.message_id;
  }

  // Reads room chat history, decrypting locally if this instance holds the room's secret. Adds
  // `decrypted` (string or null) to each message that came back encrypted.
  async roomMessages(roomId, limit = 100) {
    const path = `/api/rooms/${roomId}/messages?limit=${limit}`;
    const r = await request(this.baseUrl, 'GET', path, null, this._headers(this._didHeadersForGet(path)));
    const secret = this._roomSecrets && this._roomSecrets[roomId];
    for (const m of r.messages || []) {
      if (m.encrypted && secret) {
        try { m.decrypted = this._decryptFromRoom(this._roomKey(secret, roomId), m.content); }
        catch { m.decrypted = null; }
      }
    }
    return r.messages || [];
  }

  // Lets a caller supply a room secret obtained out-of-band (e.g. from a join link) without going
  // through joinRoom() again -- useful once already a member and just resuming a session.
  rememberRoomSecret(roomId, secret) {
    this._roomSecrets = this._roomSecrets || {};
    this._roomSecrets[roomId] = secret;
  }

  async assignTask(roomId, task, assignees) {
    const payload = { task, assignees };
    const r = await request(this.baseUrl, 'POST', `/api/rooms/${roomId}/tasks`, payload, this._headers(this._didHeaders(payload)));
    return r.task_ids;
  }

  async report(roomId, taskId, result) {
    const payload = { result };
    await request(this.baseUrl, 'POST', `/api/rooms/${roomId}/tasks/${taskId}/report`, payload, this._headers(this._didHeaders(payload)));
  }

  async room(roomId) {
    return request(this.baseUrl, 'GET', `/api/rooms/${roomId}`);
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
    if (!this.did || !this._priv) throw new MoyeError('issuing a credential requires a DID identity');
    if (this._sessionDid) throw new MoyeError('session keys cannot issue credentials');
    const vc = { type: 'moye/vc', issuer: this.did, subject: subjectDid, claim, issued_at: Date.now(), expires_at: expiresAt };
    vc.sig = crypto.sign(null, Buffer.from(this._canonical(vc)), crypto.createPrivateKey(this._priv)).toString('base64');
    const body = { credential: vc };
    return request(this.baseUrl, 'POST', '/api/credentials', body, this._headers(this._didHeaders(body)));
  }

  // ADR-0014 §2.4: mint a scoped/expiring session key. Returns the hot private key once —
  // the network only ever sees the session pubkey inside the VC claim.
  async createSession({ scope = ['send', 'inbox', 'room.post', 'room.read'], expiresInMs = 7 * 24 * 3600 * 1000 } = {}) {
    if (!this.did || !this._priv || !this.agentId) throw new MoyeError('createSession requires a registered DID identity');
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
    return (await request(this.baseUrl, 'GET', `/api/agents/${id}/credentials`)).credentials;
  }

  // Reads messages newer than `since` (ms epoch, exclusive) + current awaiting set (ADR-0018 R3).
  async roomChanges(roomId, since = 0) {
    const path = `/api/rooms/${roomId}/changes?since=${encodeURIComponent(String(since || 0))}`;
    return request(this.baseUrl, 'GET', path, null, this._headers(this._didHeadersForGet(path)));
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
      const sec = secret || (self._roomSecrets && self._roomSecrets[roomId]);
      if (out.encrypted && sec) {
        try {
          out.decrypted = self._decryptFromRoom(self._roomKey(sec, roomId), out.content);
        } catch {
          out.decrypted = null;
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
        const sig = self._sign({ method: 'WS', path: '/ws', ts });
        u.searchParams.set('did', self.did);
        u.searchParams.set('sig', sig);
        u.searchParams.set('ts', String(ts));
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
  async ledger(limit = 50) { return request(this.baseUrl, 'GET', '/api/ledger?limit=' + limit); }
  async ledgerVerify() { return request(this.baseUrl, 'GET', '/api/ledger/verify'); }
  async sharedIntent(intent, scope = 'global') {
    const payload = { intent, scope };
    return request(this.baseUrl, 'POST', '/api/shared-intent', payload, this._headers(this._didHeaders(payload)));
  }
  async joinFederation(nodeId, endpoint, name = '') {
    return request(this.baseUrl, 'POST', '/api/federation/nodes', { id: nodeId, endpoint, name }, this._headers());
  }
}

module.exports = { Agent, MoyeError };
