'use strict';
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const { WebSocketServer } = require('ws');
const ledger = require('./lib/ledger');
const didlib = require('./lib/did');
const store = require('./lib/ipfs_store');
const db = require('./lib/db');
const siteRoutes = require('./lib/site_routes');
const nodeIdentity = require('./lib/node_identity');
const p2pRelay = require('./lib/p2p_relay');
const schema = require('./lib/schema');   // F1: minimal capability JSON-Schema validator
const crdt = require('./lib/crdt');       // F4: rich CRDT merge laws (tagged values only)
const shard = require('./lib/shard');     // ADR-0008: consistent-hash directory sharding
const firehose = require('./lib/firehose'); // ADR-0013: SSE/NDJSON live event stream
const a2aTaskStream = require('./lib/a2a_task_stream'); // ADR-0030: per-task SSE for tasks/resubscribe
const roomMcp = require('./lib/room_mcp');           // ADR-0031: room-as-MCP-server (Streamable HTTP)
const roomAwaiting = require('./lib/room_awaiting'); // ADR-0027 D1/D3: multi-target + capability ask
const attachments = require('./lib/attachments'); // N1: CID attachment metadata
const verbs = require('./lib/verbs');             // ADR-0013: unified verb table
const domainVerify = require('./lib/domain_verify'); // P4-4: _moye.<domain> TXT → verified name
const mnemonicLib = require('./lib/mnemonic');       // P4-3: BIP-39 (exported for tests/tools)
const roomRead = require('./lib/room_read');         // R20: memoized catch-up + binary since slice
const path = require('path');

// Fan every ledger append into the firehose (metadata only — ledger never stores plaintext bodies).
ledger.onAppend((entry) => firehose.publish(entry));

// SQLite only holds message delivery (needs strong consistency); agent directory/rooms/shared-intent live in IPFS

const PORT = process.env.PORT || 3100;

// ---- Federation config: declare peer nodes (cross-node directory replication + message relay) ----
// Format: "node2=http://localhost:3101", multiple peers space-separated
const PEERS = (process.env.PEERS || '')
  .split(/\s+/).filter(Boolean)
  .map(s => { const [id, endpoint] = s.split('='); return { id, endpoint }; });

// FED_SECRET gates every server-to-server federation endpoint (/api/federation/*, relayed
// revoke-votes). It used to fall back to a hard-coded default that is public in this repo, which
// meant any node that forgot to set the env var could be driven by anyone on the internet:
// inject forged directory records, spoof cross-node message delivery, or register sybil governance
// nodes. Refuse to start rather than silently run wide open. Local dev / CI that genuinely wants
// the old behavior can set ALLOW_DEFAULT_FED_SECRET=1 explicitly (documented in DEPLOY.md).
const DEFAULT_FED_SECRET = 'moye-fed-shared-secret';
const FED_SECRET = process.env.FED_SECRET || DEFAULT_FED_SECRET;
if ((!process.env.FED_SECRET || FED_SECRET === DEFAULT_FED_SECRET) && process.env.ALLOW_DEFAULT_FED_SECRET !== '1') {
  console.error('[fatal] FED_SECRET is unset or using the public default. Set a strong FED_SECRET ' +
    '(shared across your federation nodes), or set ALLOW_DEFAULT_FED_SECRET=1 for local/testing only.');
  process.exit(1);
}

// Reserved shared-state key prefixes: these namespaces back security-sensitive state (agent
// revocation and reputation) and must only be written by their own governed endpoints
// (revoke-vote tally / reputation vote), never through the generic POST /api/shared-state writer.
// Without this guard any single authenticated agent could set revoke:<did>={revoked:true} to
// disable any other agent, or overwrite reputation:<id> to bypass the +/-1 clamp -- a full
// bypass of the multi-sig governance model. See POST /api/shared-state.
const RESERVED_SHARED_PREFIXES = ['revoke:', 'reputation:'];
// ADR-0009: this node's protocol version + feature set, the same values reported at
// /.well-known/moye-net, also sent to peers via POST /api/federation/nodes so the network can
// observe adoption (GET /api/protocol/adoption) -- see ADR-0009 for why this is closer to Bitcoin's
// soft-fork *signaling* than its activation mechanism (MOYE has no hashpower-equivalent objective
// threshold; adoption data here is informational, not a trigger that flips anything on by itself).
const PROTOCOL_VERSION = '1.6';
const PROTOCOL_FEATURES = ['capability-schema', 'verifiable-credentials', 'message-signing', 'rich-crdt', 'a2a-jsonrpc-bridge', 'portable-address-attestation', 'capability-input-filter', 'seeds-multisig-governance', 'firehose', 'message-attachments', 'room-awaiting', 'node-did-federation-auth', 'room-fork', 'slip0010', 'identity-delegation', 'session-keys', 'resolve-at', 'agent-timeline', 'gravity-search', 'room-mcp', 'shard-route', 'query-directory', 'room-state-staleness', 'room-mcp-mrtr', 'room-pinning', 'room-consolidate', 'mnemonic-identity', 'domain-verify', 'room-read-cache'];

// Broadcast a newly-registered agent to peer nodes immediately (doesn't wait for the 15s reconcile cycle)
function announceToPeers(agent) {
  for (const peer of PEERS) {
    const u = new URL(peer.endpoint + '/api/federation/sync');
    const data = JSON.stringify({ since_ts: 0, remote_agents: [agent], secret: FED_SECRET });
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000 },
      (r) => r.resume());
    req.on('error', () => {}); req.write(data); req.end();
  }
}

// Forward an already-stored local message to a peer node (relay delivery)
function relayToPeer(peer, payload) {
  const u = new URL(peer.endpoint + '/api/federation/deliver');
  const data = JSON.stringify({ ...payload, node: ledger.NODE_ID, secret: FED_SECRET });
  const lib = u.protocol === 'https:' ? require('https') : http;
  const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000 },
    (r) => r.resume());
  req.on('error', () => {}); req.write(data); req.end();
}

// Forward a governance vote to all known peers (each vote is forwarded once; peers don't re-forward it further, to avoid loops)
function relayVoteToAllPeers(target, voterNode, sig) {
  for (const peer of PEERS) {
    const u = new URL(peer.endpoint + '/api/agents/' + target + '/revoke-vote');
    const data = JSON.stringify({ voter_node: voterNode, sig, relayed: true, secret: FED_SECRET });
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000 },
      (r) => r.resume());
    req.on('error', () => {}); req.write(data); req.end();
  }
}

// Federation reconcile: bidirectional -- push local agents/rooms to peers, and pull back their increments
// since_ts is tracked per peer so each round only ships what changed since the last successful
// round, instead of the full local set every 15s forever (that was the previous behavior: the
// client always sent since_ts:0, so both the push and the peer's "increments since since_ts"
// response degenerated into a full resync on every single cycle regardless of node count).
const lastSyncTs = {}; // peer.id -> ms epoch of this node's own clock at the last successful sync

// Raw shared-state entries written since `since` (lamport doubles as the write clock here -- every
// writer passes Date.now()). Returns the STORED shape {value, lamport, owner}, not the materialized
// one, because the receiver has to re-run the CRDT merge law against its own copy.
function sharedSince(since) {
  const out = {};
  for (const [k, v] of Object.entries(store._raw().shared || {})) {
    if ((v.lamport || 0) > since) out[k] = { value: v.value, lamport: v.lamport, owner: v.owner };
  }
  return out;
}
// Merge shared-state entries received from a peer. putShared already applies the right law per value
// (CRDT merge for tagged values, lamport/owner LWW otherwise), so this is just a fan-out -- the
// convergence guarantees are the store's, not this function's.
async function mergeRemoteShared(shared) {
  if (!shared || typeof shared !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(shared)) {
    if (!v || typeof v !== 'object' || !('value' in v)) continue;
    try { await store.putShared(k, v.value, v.lamport || 0, v.owner || ''); n++; } catch { /* skip bad entry */ }
  }
  return n;
}
async function bootstrapFederation() {
  if (!PEERS.length) return;
  for (const peer of PEERS) {
    try {
      await request(peer.endpoint + '/api/federation/nodes',
        'POST', { id: ledger.NODE_ID, name: ledger.NODE_ID, endpoint: process.env.PUBLIC_ENDPOINT || `http://localhost:${PORT}`, pubkey: nodeIdentity.publicKey, secret: FED_SECRET,
          num_shards: shard.NUM_SHARDS, served_shards: shard.servedShardsList(),
          protocol_version: PROTOCOL_VERSION, features: PROTOCOL_FEATURES });
      const since = lastSyncTs[peer.id] || 0;
      const syncStartedAt = Date.now();
      // Push only local increments (owned by this node) created since the last successful round
      // P3-6: filter by lamport (not created_at) so agent *updates* re-push after the first sync window.
      const localAgents = Object.values(store._raw().agents).filter(a => a.home_node === ledger.NODE_ID && store.agentLamport(a) > since);
      const localRooms = Object.values(store._raw().rooms).filter(r => r.home_node === ledger.NODE_ID && (r.created_at || 0) > since);
      // Tombstones are sent in full every round (not since-filtered -- deletions are rare, the
      // set stays small, and this is the only channel nodes with no local IPFS (node3) ever get
      // them through at all, since they can't subscribe to the pubsub manifest sync).
      // Shared state (room chat logs, room task event logs, reputation, VCs) used to reach peers ONLY
      // through the IPFS pubsub manifest -- so a node with no local IPFS (node3) never received any of
      // it, and room chat/tasks silently didn't federate to it at all. Ship the raw stored entries
      // (value+lamport+owner, pre-materialization) so the receiver can run the same putShared merge
      // laws; CRDT merges are idempotent, so re-shipping an unchanged entry is harmless.
      const localShared = sharedSince(since);
      const r = await request(peer.endpoint + '/api/federation/sync', 'POST',
        { since_ts: since, remote_agents: localAgents, remote_rooms: localRooms, remote_shared: localShared, tombstones: store.getTombstones(), secret: FED_SECRET });
      if (r.tombstones) store.mergeTombstones(r.tombstones);
      await mergeRemoteShared(r.shared);
      let got = 0;
      // The tombstone checks here matter: without them, a peer that hasn't yet learned about a
      // local deletion would keep handing back the deleted record forever, and this loop would
      // dutifully re-add it every single reconcile cycle -- same resurrection bug the OR-Set
      // tombstones in ipfs_store.js fix for the IPFS-pubsub path, needed here too since this is
      // a separate merge path (HTTP, not pubsub).
      // ADR-0008: only pull agents this node is responsible for (shard.isResponsibleFor is a no-op
      // true when sharding is disabled, i.e. NUM_SHARDS=1 -- default, unchanged behavior).
      // P3-6: LWW accept (not insert-only) so a peer's updated agent record can replace a stale local copy.
      for (const a of r.agents || []) {
        if (!a || !a.id || !a.home_node || a.home_node === ledger.NODE_ID) continue;
        if (!shard.isResponsibleFor(a.id) || store.isTombstoned('agents', a.id)) continue;
        const cur = store.getAgent(a.id);
        if (!store.agentLwwWins(a, cur)) continue;
        await store.putAgent(a.id, a, { preserveLamport: true }); got++;
      }
      // Rooms need the same pull-back as agents -- previously only agents were read from the
      // response, so a room created on the peer only ever reached us via the peer's own push,
      // never via us pulling it (silently asymmetric with the agent path; harmless in a 2-node
      // full-mesh but a real gap once a 3rd node isn't peered with every other node directly).
      for (const rm of r.rooms || []) if (rm.home_node && rm.home_node !== ledger.NODE_ID && !store.getRoom(rm.id) && !store.isTombstoned('rooms', rm.id)) {
        await store.putRoom(rm.id, rm); got++;
      }
      lastSyncTs[peer.id] = syncStartedAt;
      if (localAgents.length || localRooms.length || got) {
        console.log(`[federation] sync with ${peer.id}: pushed ${localAgents.length} local / pulled ${got} remote`);
      }
    } catch (e) { console.log(`[federation] sync with ${peer.id} failed: ${e.message}`); }
  }
}
// Periodic reconcile (so newly-registered agents/rooms keep propagating)
setInterval(() => bootstrapFederation().catch(() => {}), 15000);

// Internal HTTP request helper used for federation calls
function request(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request(u, { method, headers: { 'Content-Type': 'application/json', ...(headers||{}) } }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

const app = express();
app.set('trust proxy', 1); // behind nginx: use X-Forwarded-For for req.ip (rate limiting correctness)
// Cap request bodies. Without a limit, express.json() defaults to 100kb but there was no explicit
// contract; message content had no ceiling at all, so a single caller could push oversized payloads
// into SQLite and fan them out through relay/webhook. 256kb comfortably covers PEM keys + E2E
// ciphertext while bounding abuse; per-field content is additionally capped in the message handlers.
app.use(express.json({ limit: process.env.MAX_BODY || '256kb' }));
const MAX_CONTENT_LEN = parseInt(process.env.MAX_CONTENT_LEN || '32768', 10); // per-message content ceiling
app.use((err, req, res, next) => { // surface body-too-large as a clean 413 instead of a stack trace
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'payload too large' });
  if (err) return res.status(400).json({ success: false, error: 'invalid request body' });
  next();
});
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.use('/sdk-dist', express.static(path.join(__dirname, 'sdk'))); // SDK source + packaged downloads (used by docs.html)
// ADR-0006: serves the MCP server source directly from this node, so the one-click installer
// (cloudflare-pages/public/install.sh) doesn't have to depend on GitHub being reachable -- it's
// part of the same self-hosted network the installed agent will join.
app.use('/mcp-dist', express.static(path.join(__dirname, 'mcp'), { extensions: [], dotfiles: 'ignore' }));
// Guestbook + visitor counter mounted after room helpers (see below) so POST can mirror into the ops room.
// app.use(siteRoutes(...)) — deferred

// ---- SQLite prepared statements (sync API, no await needed) ----
const stmt = {
  agentByTokenHash: db.prepare('SELECT id, name FROM agents WHERE token_hash=? LIMIT 1'),
  insertAgent: db.prepare('INSERT INTO agents (id, name, token_hash, home_node, created_at) VALUES (?,?,?,?,?)'),
  updateAgentToken: db.prepare('UPDATE agents SET token_hash=? WHERE id=?'),
  deleteAgent: db.prepare('DELETE FROM agents WHERE id=?'),
  insertMessage: db.prepare('INSERT INTO messages (id, from_agent, to_agent, content, status, encrypted, nonce, sender_sig, attachments, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  insertMessageIfNew: db.prepare('INSERT OR IGNORE INTO messages (id, from_agent, to_agent, content, status, encrypted, nonce, sender_sig, attachments, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  inboxByAgent: db.prepare('SELECT id, from_agent, content, status, encrypted, nonce, sender_sig, attachments, created_at FROM messages WHERE to_agent=? ORDER BY created_at DESC LIMIT 50'),
  messageById: db.prepare('SELECT id, from_agent, to_agent FROM messages WHERE id=?'),
  ackMessage: db.prepare('UPDATE messages SET status=? WHERE id=?'),
  // Room tasks moved to the federated CRDT event log (see materializeRoomTasks). The old
  // insert/update/select-by-room statements are gone on purpose -- leaving them around invited
  // writing back into a table that never replicates. This one is read-only: the migration source for
  // rows written before the change (see migrateLegacyRoomTasks). Nothing writes to room_tasks now.
  allRoomTasks: db.prepare('SELECT id, room_id, task, assignee, result, status, created_at, updated_at FROM room_tasks'),
  listAnchors: db.prepare('SELECT chain, tx_hash, merkle_root, ts FROM anchors ORDER BY ts DESC LIMIT ?'),
  upsertFederationNode: db.prepare(`INSERT INTO federation_nodes (id, name, endpoint, pubkey, created_at, num_shards, served_shards, features, protocol_version) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, endpoint=excluded.endpoint, pubkey=excluded.pubkey, num_shards=excluded.num_shards, served_shards=excluded.served_shards, features=excluded.features, protocol_version=excluded.protocol_version`),
  allFederationNodes: db.prepare('SELECT id, endpoint, num_shards, served_shards FROM federation_nodes'),
  allFederationNodeFeatures: db.prepare('SELECT id, features, protocol_version FROM federation_nodes'),
  ledgerCount: db.prepare('SELECT COUNT(*) AS n FROM ledger'),
  federationNodeById: db.prepare('SELECT id, pubkey FROM federation_nodes WHERE id=?'),
  countFederationNodes: db.prepare('SELECT COUNT(*) AS n FROM federation_nodes'),
  upsertVote: db.prepare(`INSERT INTO governance_votes (target, voter_node, sig, ts) VALUES (?,?,?,?)
    ON CONFLICT(target, voter_node) DO UPDATE SET sig=excluded.sig, ts=excluded.ts`),
  countVotes: db.prepare('SELECT COUNT(DISTINCT voter_node) AS n FROM governance_votes WHERE target=?'),
  insertA2aTask: db.prepare('INSERT INTO a2a_tasks (id, agent_id, message_id, input, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'),
  a2aTaskById: db.prepare('SELECT * FROM a2a_tasks WHERE id=?'),
  updateA2aTaskStatus: db.prepare('UPDATE a2a_tasks SET status=?, updated_at=? WHERE id=?'),
  updateA2aTaskResult: db.prepare('UPDATE a2a_tasks SET status=?, result=?, updated_at=? WHERE id=?'),
  updateA2aTaskMessageId: db.prepare('UPDATE a2a_tasks SET message_id=? WHERE id=?'),
  insertSeedProposal: db.prepare('INSERT OR IGNORE INTO seed_proposals (hash, seeds, proposed_by, created_at) VALUES (?,?,?,?)'),
  getSeedProposal: db.prepare('SELECT * FROM seed_proposals WHERE hash=?'),
};

// ---- SSRF guard for agent-supplied webhook URLs ----
// An agent registers an arbitrary webhook_url and the server POSTs message content to it. Without
// filtering, that turns the server into a confused-deputy SSRF proxy: an attacker points the URL at
// a loopback/private/link-local address (e.g. the node's own IPFS API on 127.0.0.1:5001, or a cloud
// metadata endpoint like 169.254.169.254) and gets the server to POST to it from inside the trust
// boundary. We reject those hosts both at registration (fail fast) and again right before delivery
// (defends against DNS rebinding: a name that resolved public at registration but private later).
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;            // private / loopback / unspecified
    if (a === 169 && b === 254) return true;                       // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 192 && b === 168) return true;                       // private
    if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT (100.64.0.0/10, incl. tailscale)
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::' ) return true;                 // loopback / unspecified
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true; // link-local / ULA
  if (low.startsWith('::ffff:')) return isBlockedIp(low.slice(7)); // IPv4-mapped
  return false;
}
// Returns { ok:true } or { ok:false, reason }. Resolves DNS so a public name pointing at a private
// IP is caught too. Allows an escape hatch for local/testing (ALLOW_PRIVATE_WEBHOOKS=1).
async function webhookUrlSafe(url) {
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === '1') return { ok: true };
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: 'invalid url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'must be http(s)' };
  const host = u.hostname;
  if (net.isIP(host)) return isBlockedIp(host) ? { ok: false, reason: 'private/loopback address not allowed' } : { ok: true };
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const { address } of addrs) if (isBlockedIp(address)) return { ok: false, reason: `resolves to blocked address ${address}` };
  } catch { return { ok: false, reason: 'dns resolution failed' }; }
  return { ok: true };
}

// ---- Webhook bridge: async-POST messages to agents that registered a webhook_url (zero-SDK onboarding) ----
function deliverWebhook(url, payload) {
  let u;
  try { u = new URL(url); } catch { return; }
  // Re-validate at delivery time (DNS rebinding defense); skip silently if the target is unsafe.
  webhookUrlSafe(url).then((v) => {
    if (!v.ok) { console.warn('[webhook] blocked delivery to', url, '-', v.reason); return; }
    const data = JSON.stringify(payload);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Moye-Event': 'message' },
      timeout: 5000,
    }, (r) => { r.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  });
}

// ---- Rate limiting: sliding window (in-memory, keyed by token or IP) ----
// 120 requests per token/IP per minute. RATE_MAX exists so a load test can raise it without editing
// source; production leaves it unset and gets the default.
const RATE = { windowMs: 60 * 1000, max: parseInt(process.env.RATE_MAX || '120', 10) };
const buckets = new Map(); // key -> number[] (timestamps)
function ratelimit(req, res, next) {
  // Public read-only discovery/pubkey-lookup endpoints are exempt from rate limiting (autonomous agents call these frequently)
  const publicReadOnly = req.method === 'GET' &&
    (req.path.startsWith('/api/agents') || req.path === '/api/ledger/verify' || req.path === '/api/ledger/root');
  if (publicReadOnly) return next();
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const key = auth || ('ip:' + (req.ip || 'anon'));
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < RATE.windowMs);
  if (arr.length >= RATE.max) {
    const oldest = arr[0];
    const retry = Math.ceil((RATE.windowMs - (now - oldest)) / 1000);
    res.set('Retry-After', String(retry));
    return res.status(429).json({ success: false, error: `rate limited, retry in ${retry}s` });
  }
  arr.push(now);
  buckets.set(key, arr);
  next();
}
app.use(ratelimit);

// ---- WebSocket: real-time inbox push ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
// agent_id -> Set<ws>
const subs = new Map();

function pushTo(agentId, payload) {
  const set = subs.get(agentId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  set.forEach((ws) => { if (ws.readyState === 1) ws.send(msg); });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  let agentId = url.searchParams.get('agent') || url.searchParams.get('agent_id');
  const token = url.searchParams.get('token');
  // DID-signature handshake, alongside the original token one. A key-based client (the web UI since
  // 2026-07-25) never holds a bearer token at all -- it only has its private key -- so token-only auth
  // here meant those clients silently got no real-time push. Signs the same {method,path,ts} claim
  // shape the bodyless HTTP GET scheme uses, with 'WS' as the method.
  const did = url.searchParams.get('did');
  const sig = url.searchParams.get('sig');
  const ts = Number(url.searchParams.get('ts'));
  if (did && sig && ts) {
    const a = store.getAgentByDid(did);
    if (!a || !a.pubkey) { ws.close(1008, 'unknown did'); return; }
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) { ws.close(1008, 'stale ts'); return; }
    const claim = JSON.stringify({ method: 'WS', path: '/ws', ts });
    if (!didlib.verify(a.pubkey, claim, sig)) { ws.close(1008, 'bad signature'); return; }
    if (isRevoked(a)) { ws.close(1008, 'revoked'); return; }
    agentId = a.id;
  } else {
    if (!agentId || !token) { ws.close(1008, 'agent+token or did+sig+ts required'); return; }
    // Verify token against SQLite (the agent record never has a .token field; this used to incorrectly
    // read .token off the IPFS directory object, which is always undefined, so every WS connection was
    // rejected -- WS push never actually worked before this fix)
    const row = stmt.agentByTokenHash.get(hashToken(token));
    if (!row || row.id !== agentId) { ws.close(1008, 'invalid token'); return; }
  }
  if (!subs.has(agentId)) subs.set(agentId, new Set());
  subs.get(agentId).add(ws);
  ws.agentId = agentId;
  ws.send(JSON.stringify({ type: 'connected', agent: agentId }));
  ws.on('close', () => {
    const set = subs.get(ws.agentId);
    if (set) { set.delete(ws); if (!set.size) subs.delete(ws.agentId); }
  });
});

// ================= Shared-intent CRDT (LWW shared state) =================
// A key's final value = whichever write has the highest lamport timestamp (ties broken by writer id lexicographically);
// all nodes converge to the same result
app.get('/api/shared-state', async (req, res) => {
  ok(res, { state: store.allShared() });
});
app.post('/api/shared-state', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const { keyname, value, lamport } = req.body || {};
  if (!keyname) return fail(res, 400, 'keyname required');
  // Reject writes into governance-reserved namespaces. These keys look like ordinary shared state
  // but are read back as security decisions (isRevoked / reputation), so a generic write here would
  // let any authenticated agent revoke or re-score anyone. Only the dedicated governed endpoints
  // (revoke-vote tally, POST /api/reputation) may touch them.
  if (RESERVED_SHARED_PREFIXES.some(p => String(keyname).startsWith(p))) {
    return fail(res, 403, `keyname prefix is reserved for governance and cannot be set directly: ${keyname}`);
  }
  const L = parseInt(lamport) || Date.now();
  // F4: a CRDT-tagged value (gcounter/pncounter/orset/rga) is merged by its own law inside
  // putShared, so it bypasses the LWW lamport pre-check below -- a lower lamport must still merge,
  // not be dropped. The response returns the materialized (read) form.
  if (crdt.isCrdt(value)) {
    const saved = await store.putShared(keyname, value, L, me.id);
    ledger.append('shared.state', { key: keyname, crdt: value.crdt, writer: me.id, lamport: saved.lamport, ts: Date.now() }).catch(() => {});
    return ok(res, { applied: true, keyname, crdt: value.crdt, value: crdt.read(saved.value), lamport: saved.lamport });
  }
  // LWW-Register (untagged): any authenticated writer may write; convergence is deterministic based
  // on (lamport, writer) -- no owner lock, which resolves the old model's deadlock where an offline
  // owner would freeze a key forever
  const curObj = store._raw().shared[keyname];
  const cL = curObj ? curObj.lamport : 0;
  if (L < cL) return ok(res, { applied: false, current: { lamport: cL, value: store.getShared(keyname) } });
  if (L === cL && curObj && curObj.owner && curObj.owner > me.id) {
    return ok(res, { applied: false, current: { lamport: cL, value: store.getShared(keyname) } });
  }
  await store.putShared(keyname, value, L, me.id);
  ledger.append('shared.state', { key: keyname, value, writer: me.id, lamport: L, ts: Date.now() }).catch(() => {});
  ok(res, { applied: true, keyname, value, lamport: L });
});

// ---- health ----
const newId = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const newToken = () => 'tok_' + crypto.randomBytes(24).toString('hex');
// Yggdrasil's address range is 200::/7 -- top 7 bits fixed means the first byte is 0x02 or 0x03,
// which in standard IPv6 compressed notation always renders as a leading hex digit of '2' or '3'.
// Loose sanity check only (self-attested field, not strictly validated / not dialed).
function validOverlayAddr(v) { return typeof v === 'string' && /^[23][0-9a-f]{0,3}:/i.test(v) ? v : null; }
// Hash the token before storing it (SHA-256) -- even if the DB file leaks, there's no usable token in it;
// the plaintext is only ever returned to the caller once, at generation time
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ---- Proof-of-work admission (deters scripted spam registration, doesn't block real humans) ----
// Difficulty N adapts to the registration rate over the last minute: more registrations -> higher N.
// The old scheme was decorative: powValid() accepted ANY prefix the client sent, so a client could
// pick its own prefix and precompute the whole PoW offline, and the difficulty floor was a single
// hex digit (16 attempts). Now the server issues each prefix, remembers it (with the difficulty it
// was issued at), and consumes it on use -- so the work must be done after the challenge is handed
// out, against a value the client can't choose, and can't be replayed.
const POW_WINDOW = []; // array of timestamps
const POW_MIN_DIFFICULTY = 2;   // floor: ~256 expected hashes even at idle (still sub-second for a real client)
const POW_TTL_MS = 2 * 60 * 1000;
const issuedChallenges = new Map(); // prefix -> { difficulty, expires }
function sweepChallenges() {
  const now = Date.now();
  for (const [p, c] of issuedChallenges) if (c.expires < now) issuedChallenges.delete(p);
}
function powDifficulty() {
  const cut = Date.now() - 60000;
  while (POW_WINDOW.length && POW_WINDOW[0] < cut) POW_WINDOW.shift();
  const rate = POW_WINDOW.length;
  if (rate > 60) return 5;   // >60/min -> 5 hex digits (~1M attempts)
  if (rate > 20) return 4;   // >20/min -> 4 digits (~65k)
  if (rate > 5)  return 3;
  return POW_MIN_DIFFICULTY;
}
function powChallenge() {
  sweepChallenges();
  const prefix = crypto.randomBytes(12).toString('hex');
  const difficulty = powDifficulty();
  issuedChallenges.set(prefix, { difficulty, expires: Date.now() + POW_TTL_MS });
  return { prefix, difficulty };
}
// Validates and CONSUMES a challenge: the prefix must be one this server issued and not yet used,
// and the nonce must solve it at the difficulty it was issued at.
function powValid(prefix, nonce) {
  if (!/^[0-9a-f]+$/.test(nonce || '')) return false;
  sweepChallenges();
  const c = issuedChallenges.get(prefix);
  if (!c) return false;                      // unknown/expired/already-used prefix -> reject
  issuedChallenges.delete(prefix);           // one-time use, prevents replay of a solved challenge
  const h = crypto.createHash('sha256').update(prefix + nonce).digest('hex');
  return h.startsWith('0'.repeat(c.difficulty));
}
const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, code, msg) => res.status(code).json({ success: false, error: msg });

// P3-1: federation auth — FED_SECRET (legacy) OR node DID signature (X-Moye-Node-Did + X-Moye-Sig
// over the JSON body, which must include ts). Both accepted so rolling migration is possible.
function federationAuthorized(req) {
  const body = req.body || {};
  if (body.secret === FED_SECRET) return { ok: true, mode: 'secret' };
  const did = (req.headers['x-moye-node-did'] || '').toString();
  const sig = (req.headers['x-moye-sig'] || '').toString();
  if (!did || !sig) return { ok: false, reason: 'missing secret or node-did headers' };
  let pubkey = null;
  let nodeId = null;
  if (did === nodeIdentity.did) {
    pubkey = nodeIdentity.publicKey;
    nodeId = ledger.NODE_ID;
  } else {
    const rows = db.prepare('SELECT id, pubkey FROM federation_nodes WHERE pubkey IS NOT NULL').all();
    for (const r of rows) {
      try {
        if (didlib.deriveDid(r.pubkey) === did) { pubkey = r.pubkey; nodeId = r.id; break; }
      } catch { /* bad pem */ }
    }
  }
  if (!pubkey) return { ok: false, reason: 'unknown node did' };
  try {
    const raw = JSON.stringify(body);
    if (!didlib.verify(pubkey, raw, sig)) return { ok: false, reason: 'bad signature' };
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
  if (!replayOk(sig, body)) return { ok: false, reason: 'stale or replayed signature' };
  return { ok: true, mode: 'node-did', node_id: nodeId };
}

// Auth: supports two modes
//  1) Classic: Authorization: Bearer <token> -> DB lookup
//  2) Decentralized DID: headers X-Moye-Did + X-Moye-Sig (base64 signature over the body)
//     The server never stores private keys -- an agent proves its own identity, so anyone can join
//     freely without being gated by this server
// Governance revoke-vote and self-deregister (see POST /api/agents/:id/deregister) both write
// revoke:<did-or-id> into shared state, but until now nothing ever read it back at auth time --
// the "revoked" flag GET /api/agents shows was purely cosmetic, a revoked agent's token/DID
// signature still worked for every write. This makes it actually enforce something.
function isRevoked(agent) {
  const rev = store.getShared('revoke:' + (agent.did || agent.id));
  return !!(rev && rev.revoked);
}

// ADR-0014 §2.4 — live session-key VC for (masterDid, sessionDid), or null.
function findLiveSessionKey(masterDid, sessionDid) {
  if (!masterDid || !sessionDid) return null;
  const bag = store.getShared(vcKey(sessionDid));
  if (!Array.isArray(bag)) return null;
  let grant = null;
  for (const vc of bag) {
    if (!vc || !vc.claim || vc.claim.type !== 'session-key') continue;
    if (vc.issuer !== masterDid) continue;
    if ((vc.claim.session_did || vc.subject) !== sessionDid) continue;
    if (!vcVerify(vc)) continue;
    const exp = vc.claim.expires != null ? Number(vc.claim.expires) : (vc.expires_at != null ? Number(vc.expires_at) : null);
    if (exp && exp < Date.now()) continue;
    grant = vc;
    break;
  }
  if (!grant) return null;
  const revoked = bag.some((r) => r && r.claim && r.claim.type === 'session-key-revoke'
    && vcVerify(r)
    && r.issuer === masterDid
    && (r.claim.session_did === sessionDid || r.claim.ref_sig === grant.sig));
  if (revoked) return null;
  return grant;
}

// Map an HTTP request onto a session-key scope token. Closed vocabulary; unknown paths deny.
function sessionScopeForRequest(req) {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || '');
  if (method === 'POST' && path === '/api/messages') return 'send';
  if (method === 'POST' && /^\/api\/messages\/[^/]+\/ack$/.test(path)) return 'inbox';
  if (method === 'GET' && /^\/api\/agents\/[^/]+\/inbox$/.test(path)) return 'inbox';
  if (method === 'GET' && /^\/api\/agents\/[^/]+\/awaiting$/.test(path)) return 'inbox';
  if (method === 'POST' && path === '/api/rooms') return 'room.create';
  if (method === 'POST' && /^\/api\/rooms\/[^/]+\/join$/.test(path)) return 'room.join';
  if (method === 'POST' && /^\/api\/rooms\/[^/]+\/messages$/.test(path)) return 'room.post';
  if (method === 'GET' && /^\/api\/rooms\/[^/]+\/messages$/.test(path)) return 'room.read';
  if (method === 'GET' && /^\/api\/rooms\/[^/]+\/changes$/.test(path)) return 'room.read';
  if (method === 'GET' && /^\/api\/rooms\/[^/]+$/.test(path)) return 'room.read';
  if (method === 'POST' && path === '/api/blobs') return 'blob';
  if (method === 'GET' && /^\/api\/agents\/[^/]+$/.test(path)) return 'discover';
  if (method === 'GET' && path === '/api/agents') return 'discover';
  return null;
}
function sessionScopeAllows(scopeList, needed) {
  if (!needed) return false;
  const scopes = Array.isArray(scopeList) ? scopeList.map(String) : [];
  if (scopes.includes('*')) return true;
  if (scopes.includes(needed)) return true;
  // room.* covers room.create/join/post/read
  if (needed.startsWith('room.') && scopes.includes('room.*')) return true;
  return false;
}
// Session keys may never perform these — even with scope '*'.
function sessionForbiddenPath(req) {
  const path = String(req.path || '');
  if (/\/deregister$/.test(path)) return true;
  if (/\/rotate$/.test(path)) return true;
  if (path === '/api/credentials') return true;
  if (/\/revoke-vote$/.test(path)) return true;
  if (path === '/api/shared-state' || path === '/api/reputation') return true;
  if (/\/overlay$/.test(path) || /\/p2p$/.test(path)) return true;
  return false;
}

// ---- DID signature anti-replay ----
// A DID signature is verifiable by anyone who observes it (unlike a Bearer token, which is a
// secret). Signing only the body -- with no timestamp or nonce -- meant a captured signed request
// could be replayed indefinitely (duplicate messages, re-triggered writes). The SDKs now put a
// signed `ts` (ms epoch) inside every DID-authed body, so replay is bounded two ways: the ts must
// be fresh, and the exact signature can only be spent once inside that freshness window.
// ALLOW_UNSIGNED_TS=1 keeps accepting bodies with no ts, for a migration window while older SDKs
// are still deployed -- turn it off (the default) once every agent ships a ts. See DEPLOY.md.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const ALLOW_UNSIGNED_TS = process.env.ALLOW_UNSIGNED_TS === '1';
const seenSigs = new Map(); // sig -> expiry ms
function replayOk(sig, body) {
  const now = Date.now();
  // opportunistic sweep so the map only ever holds ~one freshness window of signatures
  if (seenSigs.size > 5000) for (const [s, exp] of seenSigs) if (exp < now) seenSigs.delete(s);
  const ts = Number(body && body.ts);
  if (!Number.isFinite(ts)) return ALLOW_UNSIGNED_TS;      // no signed ts: only allowed in migration mode
  if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return false; // stale (or too far in the future)
  if (seenSigs.has(sig)) return false;                     // exact signature already spent
  seenSigs.set(sig, ts + REPLAY_WINDOW_MS);
  return true;
}

async function authAgent(req) {
  const did = req.headers['x-moye-did'];
  const sig = req.headers['x-moye-sig'];
  const tsHeader = req.headers['x-moye-ts'];
  const sessionDid = req.headers['x-moye-session'];
  if (did && sig) {
    // ADR-0014 §2.4: optional X-Moye-Session — signature is from a scoped session key,
    // X-Moye-Did is the master identity the session is authorized to act as.
    if (sessionDid) {
      const master = store.getAgentByDid(did);
      if (!master || !master.pubkey) return null;
      if (isRevoked(master)) return null;
      if (sessionForbiddenPath(req)) {
        console.error('[session-auth] privileged path denied for', sessionDid, req.path);
        return null;
      }
      const grant = findLiveSessionKey(did, sessionDid);
      if (!grant || !grant.claim || !grant.claim.pubkey) {
        console.error('[session-auth] no live session-key VC for', did, sessionDid);
        return null;
      }
      const needed = sessionScopeForRequest(req);
      if (!sessionScopeAllows(grant.claim.scope, needed)) {
        console.error('[session-auth] scope miss', grant.claim.scope, 'need', needed, req.method, req.path);
        return null;
      }
      let verified, replayBody;
      try {
        if (tsHeader !== undefined) {
          const claim = { method: req.method, path: req.path, ts: Number(tsHeader) };
          verified = didlib.verify(grant.claim.pubkey, JSON.stringify(claim), sig);
          replayBody = { ts: claim.ts };
        } else {
          const payload = JSON.stringify(req.body || {});
          verified = didlib.verify(grant.claim.pubkey, payload, sig);
          replayBody = req.body;
        }
      } catch { verified = false; }
      if (!verified) {
        console.error('[session-auth] verify failed for', sessionDid);
        return null;
      }
      if (!replayOk(sig, replayBody)) {
        console.error('[session-auth] replay/stale rejected for', sessionDid);
        return null;
      }
      return { id: master.id, name: master.id, did: true, session: true, session_did: sessionDid, scope: grant.claim.scope || [] };
    }

    // O(1) index lookup instead of scanning every agent (see the did -> id index in lib/ipfs_store.js)
    const a = store.getAgentByDid(did);
    if (a && a.pubkey) {
      let verified, replayBody;
      if (tsHeader !== undefined) {
        // Header-based scheme, for GET requests that carry no body. Found via live testing
        // (2026-07-23, MCP server verification) that GET requests genuinely can't carry a signed
        // body in this deployment: the Cloudflare Worker in front of production constructs a
        // fetch() Request to proxy to origin, and the Fetch API spec forbids a body on GET/HEAD
        // (`Request with GET/HEAD method cannot have body`) -- the Worker throws before origin
        // ever sees the request. So a bodyless GET signs {method, path, ts} instead of a body;
        // path is included so a signature for one GET endpoint can't be replayed against another.
        const claim = { method: req.method, path: req.path, ts: Number(tsHeader) };
        verified = didlib.verify(a.pubkey, JSON.stringify(claim), sig);
        replayBody = { ts: claim.ts };
      } else {
        const payload = JSON.stringify(req.body || {});
        verified = didlib.verify(a.pubkey, payload, sig);
        replayBody = req.body;
      }
      if (verified) {
        if (!replayOk(sig, replayBody)) { console.error('[did-auth] replay/stale rejected for', did); return null; }
        if (isRevoked(a)) return null;
        return { id: a.id, name: a.id, did: true };
      }
      console.error('[did-auth] verify failed for', did);
    }
    return null;
  }
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const tok = m[1];
  // Only the hash is stored (never in the public IPFS directory, never as plaintext in SQLite) --
  // Bearer verification hashes the incoming token on the fly and compares
  try {
    const row = stmt.agentByTokenHash.get(hashToken(tok));
    if (row) {
      const a = store.getAgent(row.id);
      if (a && isRevoked(a)) return null;
      return { id: row.id, name: row.name || row.id };
    }
  } catch (e) {}
  return null;
}

// ---- 1. Register an agent (supports both modes) ----
//  Classic: no pubkey -> server issues a token
//  Decentralized: pubkey provided (Ed25519 PEM) -> derives did:moye:<fingerprint>, server only stores the public key
app.post('/api/agents', async (req, res) => {
  const { name, description, capabilities, endpoint, owner, pubkey, enc_pubkey, webhook_url } = req.body || {};
  if (!name) return fail(res, 400, 'name required');
  // SSRF guard: reject webhook targets that resolve to loopback/private/link-local addresses
  if (webhook_url) { const v = await webhookUrlSafe(webhook_url); if (!v.ok) return fail(res, 400, 'invalid webhook_url: ' + v.reason); }
  // ADR-0006 workstream E: relay tier is a distinct self-report from p2p_addrs -- p2p_addrs means
  // "dial me here" (which can be stale or unreachable), not "I can relay for others". Purely
  // self-attested (same trust model as pubkey/capabilities/endpoint elsewhere in this handler: the
  // server never actively probes them). Never rejects a request over this field -- an unset or
  // unrecognized value just falls back to 'unknown', so older/naive clients keep working unchanged.
  const relay_tier = ['public', 'hole-punched', 'leech'].includes(req.body && req.body.relay_tier) ? req.body.relay_tier : 'unknown';
  // ADR-0006 workstream P2 (scaffolding, unverified): an agent may optionally self-report its own
  // Yggdrasil overlay IPv6 address (from `yggdrasilctl getSelf` on its host, see
  // scripts/setup-yggdrasil.sh), giving a DID -> overlay-address mapping surface for future overlay
  // transport use. Purely self-attested and format-checked only (not dialed/verified), same trust
  // model as relay_tier/p2p_addrs above. A malformed value is dropped, never rejects the request.
  // Yggdrasil's address range is 200::/7 -- the top 7 bits fixed means the first byte is 0x02 or
  // 0x03, which in standard IPv6 compressed notation always renders as a leading hex digit of
  // '2' or '3'. Loose sanity check only (this is a self-attested field, not strictly validated).
  const overlay_addr = validOverlayAddr(req.body && req.body.overlay_addr);
  // Admission (discovery stays open, but registration needs a lightweight credential to deter scripted spam):
  //  priority: invite code (x-invite / OPEN_INVITE) > DID self-attestation (pubkey) > proof-of-work
  //  none provided -> return 401 + a PoW challenge; the client computes a nonce and retries, which is then admitted
  const invite = (req.headers['x-invite'] || (req.body && req.body.invite) || '').toString();
  const OPEN_INVITE = process.env.OPEN_INVITE || '';
  if (OPEN_INVITE) {
    if (invite !== OPEN_INVITE) return fail(res, 403, 'invalid invite code');
  } else if (pubkey) {
    // DID self-attestation path: admitted (format is checked below when deriving the DID)
  } else if (req.body && req.body.pow && req.body.pow_prefix) {
    const { pow, pow_prefix } = req.body;
    // powValid checks the prefix was server-issued (and consumes it) + solved at its issued difficulty
    if (!powValid(pow_prefix, pow)) return fail(res, 400, 'invalid or expired PoW challenge');
  } else {
    return res.status(401).json({ success: false, error: 'registration requires invite / pubkey(DID) / PoW', pow: powChallenge() });
  }
  const id = newId('ag');
  const token = newToken();
  let did = null;
  if (pubkey) {
    try { did = didlib.deriveDid(pubkey); } catch { return fail(res, 400, 'invalid pubkey (Ed25519 PEM expected)'); }
  }
  stmt.insertAgent.run(id, name, hashToken(token), ledger.NODE_ID, Date.now());
  // Directory/pubkey/capabilities are written to IPFS shared state (decentralized, visible across nodes)
  const registered = await store.putAgent(id, {
    id, name, description: description || '', capabilities: capabilities || [], endpoint: endpoint || '',
    owner: owner || '', pubkey: pubkey || null, did: did || null, enc_pubkey: enc_pubkey || null,
    webhook_url: webhook_url || null, home_node: ledger.NODE_ID, created_at: Date.now(),
    p2p_addrs: req.body && req.body.p2p_addrs ? req.body.p2p_addrs : null,   // P3: libp2p direct-connect multiaddrs
    relay_tier,  // ADR-0006 workstream E: self-reported relay capability ('public'|'hole-punched'|'leech'|'unknown')
    overlay_addr // ADR-0006 workstream P2 (scaffolding): self-reported Yggdrasil overlay IPv6, or null
  });
  // Announce the full stored record (incl. pubkey + lamport) so peers don't get a stripped copy.
  if (PEERS.length) announceToPeers({ id, ...registered });
  // Anchor to the ledger: identity is tamper-evident
  await ledger.append('agent.register', { id, name, did, pubkey_fingerprint: did ? did.slice(10) : null, ts: Date.now() });
  POW_WINDOW.push(Date.now());   // record registration rate, feeds the adaptive PoW difficulty
  ok(res, { agent_id: id, token, did });
});

// ---- 1b. Rotate token (requires auth: self only) ----
app.post('/api/agents/:id/rotate', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const token = newToken();
  stmt.updateAgentToken.run(hashToken(token), me.id);
  // Token only ever lives in SQLite, never written to the public IPFS directory
  // (otherwise anyone could steal it via GET /api/agents/:id)
  ok(res, { agent_id: me.id, token });
});

// ---- P4-3 (ADR-0014 §6b): ledger-anchored recovery with veto delay ----
// Client reconstructs the mnemonic offline (Shamir 2-of-3). These endpoints only record the
// ceremony so a contested recovery can be vetoed before it completes. Threshold mirrors seeds
// multisig: floor(n/2)+1 (documented on the response; share math is client-side).
// estimated: RECOVERY_VETO_MS default 24h — no production recovery-ceremony data yet (2026-08-07).
const RECOVERY_VETO_MS = Math.max(1000, parseInt(process.env.RECOVERY_VETO_MS || String(24 * 60 * 60 * 1000), 10));
function recoveryKey(agentId) { return 'recovery:' + agentId; }

app.post('/api/agents/:id/recovery/initiate', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const agent = store.getAgent(me.id);
  if (!agent) return fail(res, 404, 'agent not found');
  const now = Date.now();
  const pending = {
    agent_id: me.id,
    did: agent.did || null,
    status: 'pending',
    reason: String((req.body && req.body.reason) || '').slice(0, 500),
    initiated_at: now,
    complete_after: now + RECOVERY_VETO_MS,
    veto_window_ms: RECOVERY_VETO_MS,
    threshold_note: 'Client Shamir uses floor(n/2)+1 (2-of-3). Veto window estimated; env RECOVERY_VETO_MS.',
    attestation: portableAttestation(req),
  };
  await store.putShared(recoveryKey(me.id), pending, now, me.id);
  await ledger.append('agent.recovery_initiate', {
    agent: me.id, did: agent.did || null, complete_after: pending.complete_after, ts: now,
    attestation: pending.attestation,
  }).catch(() => {});
  ok(res, { recovery: pending, note: mnemonicLib.EXISTING_IDENTITY_NOTE });
});

app.post('/api/agents/:id/recovery/veto', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const cur = store.getShared(recoveryKey(me.id));
  if (!cur || cur.status !== 'pending') return fail(res, 404, 'no pending recovery');
  const agent = store.getAgent(me.id);
  const now = Date.now();
  const next = { ...cur, status: 'vetoed', vetoed_at: now, vetoed_by: me.id };
  await store.putShared(recoveryKey(me.id), next, now, me.id);
  await ledger.append('agent.recovery_veto', {
    agent: me.id, did: (agent && agent.did) || null, ts: now, attestation: portableAttestation(req),
  }).catch(() => {});
  ok(res, { recovery: next });
});

app.post('/api/agents/:id/recovery/complete', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const cur = store.getShared(recoveryKey(me.id));
  if (!cur || cur.status !== 'pending') return fail(res, 404, 'no pending recovery');
  const now = Date.now();
  if (now < Number(cur.complete_after || 0)) {
    return fail(res, 409, 'veto window still open; wait until complete_after or call veto');
  }
  const next = { ...cur, status: 'completed', completed_at: now };
  await store.putShared(recoveryKey(me.id), next, now, me.id);
  const agent = store.getAgent(me.id);
  if (agent) {
    await store.putAgent(me.id, { ...agent, last_recovery_at: now });
  }
  await ledger.append('agent.recovery_complete', {
    agent: me.id, did: (agent && agent.did) || null, ts: now, attestation: portableAttestation(req),
  }).catch(() => {});
  ok(res, { recovery: next });
});

app.get('/api/agents/:id/recovery', async (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return fail(res, 404, 'agent not found');
  ok(res, { agent_id: agent.id, recovery: store.getShared(recoveryKey(agent.id)) || null });
});

// ---- P4-4 (ADR-0014 §6c): DNS domain verification (_moye.<domain> TXT) ----
app.post('/api/agents/:id/domain-verify', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const agent = store.getAgent(me.id);
  if (!agent) return fail(res, 404, 'agent not found');
  const body = req.body || {};
  if (body.revoke) {
    const updated = await store.putAgent(me.id, {
      ...agent, verified_domain: null, verified_display: null, domain_verified_at: null,
    });
    await ledger.append('agent.domain_revoke', {
      agent: me.id, did: agent.did || null, ts: Date.now(), attestation: portableAttestation(req),
    }).catch(() => {});
    if (PEERS.length) announceToPeers({ id: me.id, ...updated });
    return ok(res, { agent_id: me.id, verified_domain: null, verified_display: null });
  }
  if (!agent.did) return fail(res, 400, 'agent has no DID — register with pubkey first');
  const check = await domainVerify.verifyDomainDid(body.domain, agent.did);
  if (!check.ok) return fail(res, 400, check.error || 'domain verification failed');
  const verified_display = domainVerify.verifiedDisplayName(agent.name, check.domain);
  const updated = await store.putAgent(me.id, {
    ...agent,
    verified_domain: check.domain,
    verified_display,
    domain_verified_at: Date.now(),
  });
  await ledger.append('agent.domain_verify', {
    agent: me.id, did: agent.did, domain: check.domain, verified_display, ts: Date.now(),
    attestation: portableAttestation(req),
  }).catch(() => {});
  if (PEERS.length) announceToPeers({ id: me.id, ...updated });
  ok(res, {
    agent_id: me.id,
    verified_domain: check.domain,
    verified_display,
    host: check.host,
    note: 'Optional and revocable: delete the TXT record and POST {revoke:true}, or DELETE /domain-verify.',
  });
});

app.delete('/api/agents/:id/domain-verify', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const agent = store.getAgent(me.id);
  if (!agent) return fail(res, 404, 'agent not found');
  const updated = await store.putAgent(me.id, {
    ...agent, verified_domain: null, verified_display: null, domain_verified_at: null,
  });
  await ledger.append('agent.domain_revoke', {
    agent: me.id, did: agent.did || null, ts: Date.now(), attestation: portableAttestation(req),
  }).catch(() => {});
  if (PEERS.length) announceToPeers({ id: me.id, ...updated });
  ok(res, { agent_id: me.id, verified_domain: null, verified_display: null });
});

// ---- ADR-0010: portable, independently-verifiable DID->address attestations ----
// authAgent() already verifies the DID signature over the exact request body before we get here --
// that signature IS a self-contained proof ("this DID holder claims X at time ts") that doesn't
// depend on trusting this particular node's honesty. The only thing missing was persisting it: this
// captures the raw {did, sig, signed} alongside the parsed fields in the ledger event, so ANY third
// party -- not just a MOYE node -- can independently redo `didlib.verify(pubkey, signed, sig)` against
// the agent's already-public pubkey (GET /api/agents/:id/pubkey) without trusting this server's word
// that it checked the signature. Bearer-token auth has no such portable signature (the token proves
// identity to this node only), so `attestation` is null in that case -- documented, not hidden.
function portableAttestation(req) {
  const did = req.headers['x-moye-did'];
  const sig = req.headers['x-moye-sig'];
  if (!did || !sig) return null; // Bearer-authenticated: no portable signature to persist
  return { did, sig, signed: JSON.stringify(req.body || {}) };
}

// ---- 1b-3. Self-service overlay address update (requires auth: self only) ----
// Answers a real question about DNS-pollution-style attacks (2026-07-24): overlay_addr used to be
// registration-only and immutable (no update path existed at all, for anything). That's tamper-proof
// by omission, but also means a real Yggdrasil deployment could never rotate its address. This gives
// a genuine update path with the actual anti-tampering property: only the DID holder can update
// THEIR OWN mapping (auth === self, same as /rotate above), and every update is anchored to the
// ledger -- so "did:moye:X claims overlay address Y" is independently, cryptographically auditable
// history, not a mutable record a third party (or a compromised DNS-equivalent) could silently
// rewrite. This is the concrete mechanism ADR-0006 P2 gestures at: the ledger, not a name server,
// is the source of truth for "what address does this identity currently claim".
app.post('/api/agents/:id/overlay', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const overlay_addr = validOverlayAddr(req.body && req.body.overlay_addr);
  if (!overlay_addr) return fail(res, 400, 'valid overlay_addr required (Yggdrasil 200::/7 range)');
  const agent = store.getAgent(me.id);
  if (!agent) return fail(res, 404, 'agent not found');
  const updatedOverlay = await store.putAgent(me.id, { ...agent, overlay_addr });
  await ledger.append('agent.overlay_update', { agent: me.id, did: agent.did || null, overlay_addr, ts: Date.now(), attestation: portableAttestation(req) }).catch(() => {});
  // ADR-0006 workstream F2 continued: best-effort DHT announce so this DID is findable via
  // GET /api/dht/resolve-did/:did on any DHT-enabled node, not just this one. No-op if DHT is off.
  if (agent.did) p2pRelay.provideDid(agent.did).catch(() => {});
  if (PEERS.length) announceToPeers({ id: me.id, ...updatedOverlay });
  ok(res, { agent_id: me.id, overlay_addr });
});

// ---- ADR-0010: self-service libp2p address update (requires auth: self only) ----
// p2p_addrs used to be registration-only, same gap overlay_addr had before the fix above: a real
// libp2p node's multiaddrs change (relay circuit addresses rotate, direct addresses come and go
// with NAT/network changes), and there was no way to re-announce after registering. Mirrors the
// overlay endpoint exactly: self-only auth, ledger-anchored, portable attestation when DID-signed --
// this is the concrete "agent comes online and (re-)broadcasts its current network location" step
// the new-net-world doc describes, done via the ledger instead of standing up a fresh Kademlia DHT.
app.post('/api/agents/:id/p2p', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const { p2p_addrs, relay_tier } = req.body || {};
  if (!Array.isArray(p2p_addrs) || !p2p_addrs.every(a => typeof a === 'string')) {
    return fail(res, 400, 'p2p_addrs must be an array of multiaddr strings');
  }
  const tier = ['public', 'hole-punched', 'leech'].includes(relay_tier) ? relay_tier : 'unknown';
  const agent = store.getAgent(me.id);
  if (!agent) return fail(res, 404, 'agent not found');
  const updatedP2p = await store.putAgent(me.id, { ...agent, p2p_addrs, relay_tier: tier });
  await ledger.append('agent.p2p_update', { agent: me.id, did: agent.did || null, p2p_addrs, relay_tier: tier, ts: Date.now(), attestation: portableAttestation(req) }).catch(() => {});
  if (agent.did) p2pRelay.provideDid(agent.did).catch(() => {});
  if (PEERS.length) announceToPeers({ id: me.id, ...updatedP2p });
  ok(res, { agent_id: me.id, p2p_addrs, relay_tier: tier });
});

// ---- ADR-0010: unified resolve -- "how do I reach this DID", plus how to verify it yourself ----
// One call replacing what a client would otherwise stitch together from GET .../p2p + .../pubkey +
// GET /api/ledger/agent.overlay_update (filtered client-side). Returns the live directory row's
// address fields (fast path, what most callers want) PLUS the pubkey and the most recent ledger
// anchor for each address type, so a caller who doesn't want to trust this node's live DB at all can
// independently re-verify: fetch the anchor's `attestation` (if present), check
// didlib-equivalent Ed25519 verify(pubkey, attestation.signed, attestation.sig), and confirm the
// anchor's hash/prev is consistent with GET /api/ledger/verify. This is the "ledger as DNS, don't
// trust the resolver" answer -- it does NOT stand up a real Kademlia DHT or Yggdrasil daemon (those
// remain the unexecuted scaffolding tracked in ADR-0006 P2); it makes the identity-to-address
// *binding* itself portably verifiable using infrastructure already running in production today.
// ADR-0006 workstream J (2026-07-25): a real, previously-missing gap -- there was no public way to
// go from "I have a DID string" to an agent's record without already knowing its internal `ag_...`
// id. store.getAgentByDid() existed internally (used for DID-signature auth) but was never exposed
// over HTTP. This is the fast path a DID-based lookup should try first (this node already knows the
// DID); GET /api/dht/resolve-did/:did below is the fallback when it doesn't.
app.get('/api/agents/by-did/:did', async (req, res) => {
  if (!didlib.isValidDid(req.params.did)) return fail(res, 400, 'malformed DID');
  const a = store.getAgentByDid(req.params.did);
  if (!a) return fail(res, 404, 'no agent with this DID known to this node');
  ok(res, { agent_id: a.id, agent: a });
});

app.get('/api/agents/:id/resolve', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  // T5: ?at=<unix_ms> or ?at=seq:<n> reconstructs address state as of that moment.
  const atRaw = req.query.at != null ? String(req.query.at) : null;
  let beforeTs = null;
  let beforeSeq = null;
  if (atRaw) {
    if (atRaw.startsWith('seq:')) beforeSeq = parseInt(atRaw.slice(4), 10);
    else {
      const n = parseInt(atRaw, 10);
      if (Number.isFinite(n)) {
        if (n < 1e12) beforeSeq = n; // treat small ints as ledger seq
        else beforeTs = n;
      }
    }
  }
  const findLatest = async (type) => {
    const rows = await ledger.byType(type, 500);
    for (let i = rows.length - 1; i >= 0; i--) {
      const e = rows[i];
      if (!e.data || e.data.agent !== req.params.id) continue;
      if (beforeSeq != null && e.seq > beforeSeq) continue;
      if (beforeTs != null && e.ts > beforeTs) continue;
      return e;
    }
    return null;
  };
  const [overlayAnchor, p2pAnchor] = await Promise.all([
    findLatest('agent.overlay_update'),
    findLatest('agent.p2p_update'),
  ]);
  const historical = beforeTs != null || beforeSeq != null;
  ok(res, {
    agent_id: req.params.id,
    did: a.did || null,
    pubkey: a.pubkey || null,
    home_node: a.home_node,
    at: historical ? { ts: beforeTs, seq: beforeSeq } : null,
    overlay_addr: historical
      ? ((overlayAnchor && overlayAnchor.data.overlay_addr) || null)
      : (a.overlay_addr || null),
    p2p_addrs: historical
      ? ((p2pAnchor && p2pAnchor.data.p2p_addrs) || null)
      : (a.p2p_addrs || null),
    relay_tier: historical
      ? ((p2pAnchor && p2pAnchor.data.relay_tier) || 'unknown')
      : (a.relay_tier || 'unknown'),
    deliver_via: (historical ? (p2pAnchor && p2pAnchor.data.p2p_addrs) : a.p2p_addrs) ? 'p2p' : 'relay',
    verify: {
      overlay_anchor: overlayAnchor ? { seq: overlayAnchor.seq, hash: overlayAnchor.hash, attestation: overlayAnchor.data.attestation || null } : null,
      p2p_anchor: p2pAnchor ? { seq: p2pAnchor.seq, hash: p2pAnchor.hash, attestation: p2pAnchor.data.attestation || null } : null,
      how_to_verify: 'Ed25519-verify(pubkey above, attestation.signed, attestation.sig) with attestation.did matching `did` above; attestation is null if that update was Bearer-authenticated (no portable signature). Cross-check anchor hash/prev via GET /api/ledger/verify to confirm the chain itself is intact.',
    },
  });
});

// ADR-0006 workstream F2 continued (2026-07-25): DID -> PeerID mapping via the DHT, distinct from
// the ledger-anchored /resolve above. This asks "which MOYE node(s) currently know about this DID"
// purely via kad-dht content-routing (provide/findProviders on a CID derived from the DID string) --
// no prior knowledge of which node hosts the agent is needed, which /resolve above still requires
// (you have to already be asking the right node). Returns [] (not an error) when DHT is disabled or
// nothing is found -- this is a supplementary discovery path, GET /api/agents/:id/resolve remains
// the source of truth once you know which node to ask.
app.get('/api/dht/resolve-did/:did', async (req, res) => {
  if (!didlib.isValidDid(req.params.did)) return fail(res, 400, 'malformed DID');
  const providers = await p2pRelay.findProvidersForDid(req.params.did).catch(() => []);
  ok(res, {
    did: req.params.did,
    providers,
    dht_enabled: !!(p2pRelay.node() && p2pRelay.node().services.dht),
    note: providers.length ? 'each provider is a MOYE node that knows this DID -- ask it for GET /api/agents/:id/resolve to get the actual overlay_addr/p2p_addrs' : 'no providers found via DHT (DHT may be disabled, the DID may not have announced yet, or routing tables have not converged -- can take minutes, see ADR-0006). Fall back to a known node\'s GET /api/agents/:id/resolve.',
  });
});

// ADR-0006 workstream E1/E2 (2026-07-25): a peer-verified reachability check, closing the gap
// endpoint_reachability (above) explicitly could not -- resolving PUBLIC_ENDPOINT to a non-private IP
// only proves the address isn't obviously private, not that a real TCP connection from the outside
// actually succeeds (port not forwarded, upstream firewall, etc. would still show 'public'). This asks
// THIS node to attempt a real TCP connect to a caller-given host:port and report whether it worked --
// any node can ask any other node to check reachability of a THIRD host:port too, which is why this
// reuses webhookUrlSafe (same SSRF concern as the existing webhook_url feature: without this guard, an
// attacker could use a MOYE node as a port scanner against the node's own internal network).
// Honest scope: this proves genuine TCP reachability (useful, real signal) but is NOT a NAT hole-punch
// test -- it can't distinguish "no NAT at all" from "NAT with a port forward" the way dcutr
// success/failure would, and none of this project's current production nodes are behind a real NAT to
// test that harder claim against. See checkSelfReachability() below for how a node uses this on itself.
app.post('/api/reachability-check', async (req, res) => {
  const { host, port } = req.body || {};
  const p = Number(port);
  if (!host || !Number.isInteger(p) || p < 1 || p > 65535) {
    return fail(res, 400, 'host and a valid port (1-65535) required');
  }
  const safe = await webhookUrlSafe(`http://${host}:${p}`);
  if (!safe.ok) return fail(res, 400, `refusing to probe this target: ${safe.reason}`);
  const reachable = await new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(5000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(p, host);
  });
  ok(res, { host, port: p, reachable });
});

// Asks one of our configured PEERS (federation peers, not libp2p relay peers) to verify reachability
// of our own PUBLIC_ENDPOINT at the given port, from that peer's outside vantage point -- our own
// process can't test its own reachability from the inside. Returns null (not false) when this can't be
// determined at all (no peers configured, no PUBLIC_ENDPOINT set, or every peer request failed) so
// callers can tell "confirmed unreachable" apart from "couldn't check".
async function checkSelfReachability(port) {
  if (!PEERS.length || !process.env.PUBLIC_ENDPOINT) return null;
  let myHost;
  try { myHost = new URL(process.env.PUBLIC_ENDPOINT).hostname; } catch { return null; }
  for (const peer of PEERS) {
    if (!peer.endpoint) continue;
    try {
      const r = await fetch(peer.endpoint.replace(/\/$/, '') + '/api/reachability-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: myHost, port }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data && data.success) return { reachable: data.reachable, checked_via: peer.id };
    } catch { /* try next peer */ }
  }
  return null;
}

// ---- 1b-2. Self-service deregistration (requires auth: self only) ----
// Actually removes the agent from the shared directory (store.removeAgent -- OR-Set tombstone,
// so a peer's stale manifest can't silently resurrect it, see lib/ipfs_store.js), unlike
// governance revoke-vote which only flags revoke:<did-or-id> and leaves the record visible for
// transparency ("this agent was banned by the network" is worth keeping around; "this agent
// chose to leave" isn't). Deleting the SQLite token row makes the Bearer path fail immediately
// too; DID auth is blocked simply by the agent no longer existing (authAgent's lookups fail).
app.post('/api/agents/:id/deregister', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const removed = await store.removeAgent(me.id);
  if (!removed) return fail(res, 404, 'agent not found');
  stmt.deleteAgent.run(me.id);
  ledger.append('agent.deregister', { id: me.id, ts: Date.now() }).catch(() => {});
  ok(res, { agent_id: me.id, deregistered: true });
});

// ---- 1c. Fetch an agent's P-256 encryption public key (public, so others can E2E-encrypt to them) ----
app.get('/api/agents/:id/enc-pubkey', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  if (!a.enc_pubkey) return fail(res, 404, 'agent has no enc_pubkey (E2E disabled)');
  ok(res, { agent_id: a.id, enc_pubkey: a.enc_pubkey });
});
app.get('/api/agents/:id/pubkey', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  if (!a.pubkey) return fail(res, 404, 'agent has no pubkey (E2E disabled)');
  ok(res, { agent_id: a.id, pubkey: a.pubkey });
});

// ---- 3b. Reputation trust root ----
// Reputation lives in shared state as reputation:<agentId> = {score, updated_at}, converges via CRDT LWW
// Any authenticated agent can vote +1/-1 on another (anti-abuse: capped per vote, relies on DID self-attestation)
function repKey(id) { return 'reputation:' + id; }
app.get('/api/agents/:id/reputation', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  const r = store.getShared(repKey(req.params.id));
  ok(res, { agent_id: req.params.id, reputation: r ? r.score : 0, updated_at: r ? r.updated_at : null });
});
app.post('/api/reputation', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const { target, delta } = req.body || {};
  if (!target) return fail(res, 400, 'target agent id required');
  if (!store.getAgent(target)) return fail(res, 404, 'target agent not found');
  if (me.id === target) return fail(res, 400, 'cannot rate yourself');
  // T4: root↔instance and sibling instances cannot wash reputation via direct votes —
  // the only cross-instance trust path is an explicit VC endorsement (not identity-delegation).
  if (sameIdentityFamily(me.id, target)) {
    return fail(res, 403, 'reputation votes between a root and its delegated instances (or sibling instances) are blocked; use a VC endorsement instead');
  }
  const d = Math.max(-1, Math.min(1, parseInt(delta) || 0)); // clamp to -1..+1 per vote, anti-abuse
  const cur = store.getShared(repKey(target)) || { score: 0, updated_at: 0 };
  const next = { score: (cur.score || 0) + d, updated_at: Date.now() };
  const L = Date.now();
  await store.putShared(repKey(target), next, L, me.id);
  ledger.append('reputation.vote', { voter: me.id, target, delta: d, ts: Date.now() }).catch(() => {});
  ok(res, { target, reputation: next.score });
});

// ================= F2: Verifiable Credentials (DID-signed endorsements) =================
// A credential is an Ed25519-signed claim by one agent (issuer) about another (subject). Because
// the signature is self-verifying, VCs live in ordinary shared state under vc:<subject-did> (NOT a
// governance-reserved namespace) -- anyone can independently re-check them. The server still refuses
// to store one it can't verify, so the directory's credential_count never counts forgeries.
function vcKey(subjectDid) { return 'vc:' + subjectDid; }
// Deterministic serialization of a VC minus its signature (issuer signs exactly this).
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function vcSigningPayload(vc) { const { sig, ...rest } = vc; return stableStringify(rest); }
function vcVerify(vc) {
  if (!vc || !vc.issuer || !vc.subject || !vc.sig) return false;
  if (vc.expires_at && Date.now() > vc.expires_at) return false;
  const issuer = store.getAgentByDid(vc.issuer);
  if (!issuer || !issuer.pubkey) return false;
  try { return didlib.verify(issuer.pubkey, vcSigningPayload(vc), vc.sig); } catch { return false; }
}
function verifiedCredentialCount(agent) {
  const did = agent && agent.did; if (!did) return 0;
  const list = store.getShared(vcKey(did)); if (!Array.isArray(list)) return 0;
  return list.filter(vcVerify).length;
}

// T4: map agentId/DID → root DID when linked by a live identity-delegation VC.
function identityRootDid(agentOrDid) {
  const a = typeof agentOrDid === 'string'
    ? (store.getAgent(agentOrDid) || store.getAgentByDid(agentOrDid))
    : agentOrDid;
  if (!a) return null;
  const did = a.did || (typeof agentOrDid === 'string' && String(agentOrDid).startsWith('did:') ? agentOrDid : null);
  if (!did) return null;
  const bag = store.getShared(vcKey(did)) || [];
  if (!Array.isArray(bag)) return did;
  for (const vc of bag) {
    if (!vc || !vc.claim || vc.claim.type !== 'identity-delegation') continue;
    if (!vcVerify(vc)) continue;
    if (vc.claim.expires && Number(vc.claim.expires) < Date.now()) continue;
    const revoked = bag.some((r) => r && r.claim && r.claim.type === 'identity-delegation-revoke'
      && (r.claim.instance_did === vc.claim.instance_did || r.claim.ref_sig === vc.sig) && vcVerify(r));
    if (revoked) continue;
    return vc.issuer; // issuer is the root
  }
  return did;
}
function sameIdentityFamily(aId, bId) {
  const ra = identityRootDid(aId);
  const rb = identityRootDid(bId);
  if (!ra || !rb) return false;
  if (ra === rb) return true;
  const aa = store.getAgent(aId) || store.getAgentByDid(aId);
  const bb = store.getAgent(bId) || store.getAgentByDid(bId);
  // also: one is root of the other
  if (aa && aa.did && identityRootDid(bId) === aa.did) return true;
  if (bb && bb.did && identityRootDid(aId) === bb.did) return true;
  return false;
}
function listInstanceDids(rootDid) {
  const out = [];
  if (!rootDid) return out;
  for (const agent of store.listAgents('')) {
    if (!agent.did) continue;
    const bag = store.getShared(vcKey(agent.did)) || [];
    if (!Array.isArray(bag)) continue;
    for (const vc of bag) {
      if (!vc || !vc.claim || vc.claim.type !== 'identity-delegation') continue;
      if (vc.issuer !== rootDid) continue;
      if (!vcVerify(vc)) continue;
      if (vc.claim.expires && Number(vc.claim.expires) < Date.now()) continue;
      out.push(vc.claim.instance_did || vc.subject);
    }
  }
  return out;
}
// Issue a credential (auth: the issuer themselves, DID mode -- only a key holder can endorse in its name)
app.post('/api/credentials', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const issuer = store.getAgent(me.id);
  if (!issuer || !issuer.did || !issuer.pubkey) return fail(res, 403, 'issuer must have a DID identity (pubkey)');
  const vc = req.body && req.body.credential ? req.body.credential : req.body;
  if (!vc || !vc.subject || !vc.claim || !vc.sig) return fail(res, 400, 'credential requires subject, claim, sig');
  if (vc.issuer !== issuer.did) return fail(res, 403, 'credential.issuer must match the authenticated agent DID');
  // T3: identity-delegation claim shape
  if (vc.claim && vc.claim.type === 'identity-delegation') {
    if (!vc.claim.instance_did || !vc.claim.pubkey) {
      return fail(res, 400, 'identity-delegation requires claim.instance_did and claim.pubkey');
    }
    try {
      if (didlib.deriveDid(vc.claim.pubkey) !== vc.claim.instance_did) {
        return fail(res, 400, 'identity-delegation instance_did must derive from claim.pubkey');
      }
    } catch {
      return fail(res, 400, 'identity-delegation claim.pubkey invalid');
    }
    // subject of the VC is the instance DID (the delegate identity)
    if (vc.subject !== vc.claim.instance_did) {
      return fail(res, 400, 'identity-delegation subject must equal claim.instance_did');
    }
  }
  // ADR-0014 §2.4: session-key claim — scoped/expiring/revocable hot key for the issuer.
  if (vc.claim && vc.claim.type === 'session-key') {
    if (!vc.claim.session_did || !vc.claim.pubkey) {
      return fail(res, 400, 'session-key requires claim.session_did and claim.pubkey');
    }
    if (!Array.isArray(vc.claim.scope) || vc.claim.scope.length === 0) {
      return fail(res, 400, 'session-key requires non-empty claim.scope array');
    }
    try {
      if (didlib.deriveDid(vc.claim.pubkey) !== vc.claim.session_did) {
        return fail(res, 400, 'session-key session_did must derive from claim.pubkey');
      }
    } catch {
      return fail(res, 400, 'session-key claim.pubkey invalid');
    }
    if (vc.subject !== vc.claim.session_did) {
      return fail(res, 400, 'session-key subject must equal claim.session_did');
    }
    if (vc.claim.expires != null && !Number.isFinite(Number(vc.claim.expires))) {
      return fail(res, 400, 'session-key claim.expires must be a millisecond epoch');
    }
  }
  if (vc.claim && vc.claim.type === 'session-key-revoke') {
    if (!vc.claim.session_did && !vc.claim.ref_sig) {
      return fail(res, 400, 'session-key-revoke requires claim.session_did or claim.ref_sig');
    }
  }
  const subjectAgent = store.getAgentByDid(vc.subject);
  // identity-delegation / session-key subjects may not be registered as agents yet — allow issuance anyway
  const allowUnregisteredSubject = vc.claim && (vc.claim.type === 'identity-delegation'
    || vc.claim.type === 'session-key' || vc.claim.type === 'session-key-revoke');
  if (!subjectAgent && !allowUnregisteredSubject) {
    return fail(res, 404, 'subject DID is not a known agent');
  }
  if (!vcVerify(vc)) return fail(res, 400, 'credential signature does not verify');
  // OR-Set style append: dedupe by signature, keep prior credentials
  const cur = store.getShared(vcKey(vc.subject));
  const list = Array.isArray(cur) ? cur.slice() : [];
  if (!list.some(x => x.sig === vc.sig)) list.push(vc);
  const L = Date.now();
  await store.putShared(vcKey(vc.subject), list, L, me.id);
  ledger.append('credential.issue', { issuer: vc.issuer, subject: vc.subject, claim: vc.claim, ts: Date.now() }).catch(() => {});
  ok(res, { subject: vc.subject, credential_count: list.filter(vcVerify).length });
});
// List an agent's received credentials, each re-verified server-side (verified: bool)
app.get('/api/agents/:id/credentials', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  const list = (a.did && store.getShared(vcKey(a.did))) || [];
  const credentials = (Array.isArray(list) ? list : []).map(vc => ({ ...vc, verified: vcVerify(vc) }));
  ok(res, { agent_id: req.params.id, did: a.did || null, credentials });
});

// T3: list active identity-delegation instances issued by (or for) this agent
app.get('/api/agents/:id/instances', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  const rootDid = a.did;
  const instances = [];
  // Scan all agents' VC bags is expensive; scan ledger credential.issue instead.
  const rows = await ledger.byType('credential.issue', 500);
  for (const e of rows) {
    const c = e.data && e.data.claim;
    if (!c || c.type !== 'identity-delegation') continue;
    if (e.data.issuer !== rootDid && e.data.subject !== rootDid) continue;
    const bag = store.getShared(vcKey(e.data.subject)) || [];
    const live = Array.isArray(bag) ? bag.find((x) => x.sig === e.data.sig || (x.claim && x.claim.instance_did === c.instance_did && x.issuer === e.data.issuer)) : null;
    const vc = live || { issuer: e.data.issuer, subject: e.data.subject, claim: c, sig: e.data.sig };
    if (!vcVerify(vc) && live) continue;
    const revoked = Array.isArray(bag) && bag.some((r) => r.claim && r.claim.type === 'identity-delegation-revoke'
      && (r.claim.instance_did === c.instance_did || r.claim.ref_sig === vc.sig) && vcVerify(r));
    if (revoked) continue;
    if (c.expires && Number(c.expires) < Date.now()) continue;
    instances.push({
      root_did: e.data.issuer,
      instance_did: c.instance_did,
      pubkey: c.pubkey || null,
      scope: c.scope || null,
      expires: c.expires || null,
      sig: vc.sig || e.data.sig,
    });
  }
  ok(res, { agent_id: a.id, did: rootDid, instances });
});

// T8: unified identity timeline (ledger + room messages + credentials), including delegated instances
app.get('/api/agents/:id/timeline', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const instanceDids = a.did ? listInstanceDids(a.did) : [];
  const agentIds = new Set([a.id]);
  const dids = new Set([a.did].filter(Boolean).concat(instanceDids));
  for (const d of instanceDids) {
    const ia = store.getAgentByDid(d);
    if (ia) agentIds.add(ia.id);
  }
  const events = [];
  const tail = await ledger.tail(500);
  for (const e of tail) {
    const d = e.data || {};
    const hit = agentIds.has(d.agent) || agentIds.has(d.id) || agentIds.has(d.from) || agentIds.has(d.to)
      || dids.has(d.issuer) || dids.has(d.subject) || agentIds.has(d.writer) || agentIds.has(d.by)
      || agentIds.has(d.voter) || agentIds.has(d.target);
    if (!hit) continue;
    events.push({ source: 'ledger', type: e.type, ts: e.ts, seq: e.seq, hash: e.hash, data: d });
  }
  for (const did of dids) {
    const bag = store.getShared(vcKey(did)) || [];
    if (!Array.isArray(bag)) continue;
    for (const vc of bag) {
      events.push({
        source: 'credential', type: (vc.claim && vc.claim.type) || 'credential',
        ts: vc.ts || 0, data: { issuer: vc.issuer, subject: vc.subject, claim: vc.claim },
      });
    }
  }
  for (const room of store.listRooms()) {
    if (room.visibility === 'private' && !canReadRoom(room, a.id)) continue;
    const msgs = store.getShared(roomChatKey(room.id)) || [];
    for (const m of msgs) {
      if (agentIds.has(m.from_agent)) {
        events.push({
          source: 'room', type: m.type || 'message', ts: m.ts, room_id: room.id,
          data: { message_id: m.id, from_agent: m.from_agent,
            content_hash: crypto.createHash('sha256').update(m.content || '').digest('hex').slice(0, 16) },
        });
      }
    }
  }
  events.sort((x, y) => (x.ts || 0) - (y.ts || 0) || (x.seq || 0) - (y.seq || 0));
  ok(res, {
    agent_id: a.id, did: a.did || null, instances: instanceDids,
    events: events.slice(-limit),
  });
});

// N3 (ADR-0020): list active vote-delegation VCs.
app.get('/api/delegations', async (req, res) => {
  const domain = (req.query.domain || '').toString().trim() || null;
  const out = [];
  for (const agent of store.listAgents('')) {
    if (!agent.did) continue;
    const list = store.getShared(vcKey(agent.did)) || [];
    if (!Array.isArray(list)) continue;
    for (const vc of list) {
      if (!vc || !vc.claim || vc.claim.type !== 'vote-delegation') continue;
      if (domain && vc.claim.domain !== domain) continue;
      if (!vcVerify(vc)) continue;
      const revoked = list.some((r) => r && r.claim && r.claim.type === 'vote-delegation-revoke'
        && r.claim.domain === vc.claim.domain
        && (r.claim.delegates === vc.issuer || r.claim.ref_sig === vc.sig)
        && vcVerify(r));
      if (revoked) continue;
      out.push({
        delegator: vc.issuer,
        delegate: vc.subject,
        domain: vc.claim.domain || null,
        expires: vc.claim.expires || null,
        sig: vc.sig,
      });
    }
  }
  ok(res, { domain, delegations: out });
});

// ================= ADR-0006 workstream G: contribution visibility (non-monetary, permanent) =====
// Per ADR-0006 §0.5, the founder's explicit and permanent principle: contributions (relay, storage,
// uptime) are surfaced ONLY as visibility/reputation, never as money or tokens. This endpoint records
// self-reported telemetry -- and ONLY records it. It deliberately does NOT feed reputation or
// credentials directly: letting self-reported numbers write straight into a publicly-read trust
// score would be a trivial Sybil vector (report a huge number, inflate your own standing), which
// would violate the spirit of §0.5 even without any money involved. Real trust/visibility for a
// contribution still has to come from a PEER who actually observed it, issuing a verifiable
// credential via POST /api/credentials (e.g. claim: {type:'contribution-endorsement', kind, period,
// metric}) -- that reuses the signature verification already built for VCs instead of inventing a
// second, weaker trust mechanism.
app.post('/api/contributions', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const { kind, metric, period } = req.body || {};
  if (!kind || metric === undefined) return fail(res, 400, 'kind and metric required');
  const entry = await ledger.append('contribution.report', { agent: me.id, kind, metric, period: period || null, ts: Date.now() });
  ok(res, { agent_id: me.id, kind, metric, recorded_seq: entry.seq });
});
// Reads this node's own ledger for an agent's self-reported contributions. Known limitation
// (ADR-0006): the ledger is per-node, not CRDT-synced like shared state -- a report made on node2
// is not currently guaranteed visible when queried from node1, since ledger tails aren't federated.
// This is surfaced honestly rather than assumed; querying multiple nodes may show different results.
app.get('/api/agents/:id/contributions', async (req, res) => {
  if (!store.getAgent(req.params.id)) return fail(res, 404, 'agent not found');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = await ledger.byType('contribution.report', 500); // over-fetch then filter to this agent
  const reports = rows.filter(r => r.data && r.data.agent === req.params.id).slice(-limit);
  ok(res, { agent_id: req.params.id, node: ledger.NODE_ID, reports, note: 'self-reported; not federated across nodes; visibility only, never monetary (see ADR-0006 §0.5)' });
});
// ADR-0006 workstream G3: the honor board this network-wide view was missing -- contributions were
// recorded (G1) and queryable per-agent, but nowhere visible in aggregate. Deliberately does NOT rank
// by self-reported `metric` alone (trivially gameable, see the anti-Sybil reasoning above
// POST /api/contributions) -- `endorsed_count` (peer-issued `contribution-endorsement` VCs, the only
// verifiable trust signal here) is the primary sort key; self-reported activity is shown for
// transparency, never as the thing that establishes trust.
function verifiedEndorsementCount(agent) {
  const did = agent && agent.did; if (!did) return 0;
  const list = store.getShared(vcKey(did)); if (!Array.isArray(list)) return 0;
  return list.filter(vc => vc.claim && vc.claim.type === 'contribution-endorsement' && vcVerify(vc)).length;
}
app.get('/api/contributions', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const rows = await ledger.byType('contribution.report', limit);
  const byAgent = {};
  for (const r of rows) {
    const d = r.data;
    if (!d || !d.agent) continue;
    const bucket = byAgent[d.agent] || (byAgent[d.agent] = { agent_id: d.agent, reports: 0, kinds: {} });
    bucket.reports++;
    const m = typeof d.metric === 'number' ? d.metric : 1;
    bucket.kinds[d.kind] = (bucket.kinds[d.kind] || 0) + m;
  }
  const contributors = Object.values(byAgent).map(b => {
    const agent = store.getAgent(b.agent_id);
    return { ...b, name: agent ? agent.name : null, endorsed_count: verifiedEndorsementCount(agent) };
  }).sort((a, b) => b.endorsed_count - a.endorsed_count || b.reports - a.reports);
  ok(res, {
    node: ledger.NODE_ID, contributors,
    note: 'self-reported reports/kinds are visibility only and never feed reputation (see ADR-0006 §0.5); endorsed_count (peer-issued contribution-endorsement VCs via POST /api/credentials) is the only verifiable trust signal here; per-node view, not federated',
  });
});

// Governance: federation nodes cast signed multi-sig votes; revocation only actually takes effect once
// votes exceed a majority of known nodes (including this one) -- replaces the old single-point ADMIN_TOKEN.
// The signed payload is `revoke:<target>:<voter_node>`, verified against the pubkey that voter_node
// registered in federation_nodes (or this node's own nodeIdentity). The signature itself is the
// authorization, no extra shared secret needed. A raw vote is forwarded to every known peer so each
// tallies it independently -- this way an operator can split their votes across different nodes and
// they still sum up correctly (rather than requiring every vote go through the same node).
app.post('/api/agents/:id/revoke-vote', async (req, res) => {
  const target = req.params.id;
  const { voter_node, sig, relayed, secret } = req.body || {};
  if (!voter_node || !sig) return fail(res, 400, 'voter_node and sig required');
  // Forwarded votes must also carry the federation secret, keeping the same auth baseline as other server-to-server endpoints
  if (relayed && secret !== FED_SECRET) return fail(res, 401, 'invalid federation secret');
  const a = store.getAgent(target);
  if (!a) return fail(res, 404, 'agent not found');
  const isSelf = voter_node === ledger.NODE_ID;
  const node = isSelf ? null : stmt.federationNodeById.get(voter_node);
  const pubkey = isSelf ? nodeIdentity.publicKey : (node && node.pubkey);
  if (!pubkey) return fail(res, 404, `unknown voter_node: ${voter_node}`);
  if (!didlib.verify(pubkey, `revoke:${target}:${voter_node}`, sig)) return fail(res, 403, 'invalid vote signature');
  stmt.upsertVote.run(target, voter_node, sig, Date.now());
  if (!relayed) relayVoteToAllPeers(target, voter_node, sig);
  const votes = stmt.countVotes.get(target).n;
  const totalNodes = stmt.countFederationNodes.get().n + 1; // +1 for this node itself
  const threshold = Math.floor(totalNodes / 2) + 1;
  let applied = false;
  if (votes >= threshold) {
    const L = Date.now();
    await store.putShared('revoke:' + (a.did || target), { revoked: true, votes, threshold, ts: L }, L, ledger.NODE_ID);
    ledger.append('agent.revoke', { id: target, votes, threshold, ts: L }).catch(() => {});
    applied = true;
  }
  ok(res, { target, votes, threshold, applied });
});

// ================= ADR-0006 D2/X2: multi-sig seeds-list governance =================
// GET /api/bootstrap/seeds was single-node self-signed ("self-signed, not multi-sig", per its own comment)
// -- any one node could unilaterally claim "here is the network's entry point list" and a client had
// no way to tell that apart from a majority-endorsed one. This reuses the EXACT same multi-sig
// mechanism the agent-revoke flow already has (governance_votes table, majority-of-known-nodes
// threshold) instead of inventing a second governance primitive: target = 'seeds:<hash>' namespaces
// seed votes away from agent-revoke targets in the same table.
function seedsHash(seeds) { return crypto.createHash('sha256').update(JSON.stringify(seeds)).digest('hex').slice(0, 16); }
function relaySeedVoteToAllPeers(hash, voterNode, sig) {
  for (const peer of PEERS) {
    const u = new URL(peer.endpoint + '/api/governance/seeds/vote');
    const data = JSON.stringify({ hash, voter_node: voterNode, sig, relayed: true, secret: FED_SECRET });
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000 },
      (r) => r.resume());
    req.on('error', () => {}); req.write(data); req.end();
  }
}
// A node proposes a specific seeds list (and this call also casts that node's own first vote for it).
// `seeds` is an array of {id, endpoint}; the hash is a stable identifier other nodes vote against.
app.post('/api/governance/seeds/propose', async (req, res) => {
  const { seeds, voter_node, sig } = req.body || {};
  if (!Array.isArray(seeds) || !seeds.length || !seeds.every(s => s && typeof s.id === 'string' && typeof s.endpoint === 'string')) {
    return fail(res, 400, 'seeds must be a non-empty array of {id, endpoint}');
  }
  if (!voter_node || !sig) return fail(res, 400, 'voter_node and sig required');
  const hash = seedsHash(seeds);
  const isSelf = voter_node === ledger.NODE_ID;
  const node = isSelf ? null : stmt.federationNodeById.get(voter_node);
  const pubkey = isSelf ? nodeIdentity.publicKey : (node && node.pubkey);
  if (!pubkey) return fail(res, 404, `unknown voter_node: ${voter_node}`);
  if (!didlib.verify(pubkey, `seeds-propose:${hash}:${voter_node}`, sig)) return fail(res, 403, 'invalid proposal signature');
  stmt.insertSeedProposal.run(hash, JSON.stringify(seeds), voter_node, Date.now());
  stmt.upsertVote.run('seeds:' + hash, voter_node, sig, Date.now());
  const votes = stmt.countVotes.get('seeds:' + hash).n;
  const totalNodes = stmt.countFederationNodes.get().n + 1;
  const threshold = Math.floor(totalNodes / 2) + 1;
  ok(res, { hash, votes, threshold, endorsed: votes >= threshold });
});
// A federation node votes to endorse an already-proposed seeds list (by hash). Note the signed
// message is still `seeds-propose:<hash>:<voter_node>` -- proposing and voting are the same signed
// claim ("I endorse this specific seeds list"), just possibly from different nodes/times.
app.post('/api/governance/seeds/vote', async (req, res) => {
  const { hash, voter_node, sig, relayed, secret } = req.body || {};
  if (!hash || !voter_node || !sig) return fail(res, 400, 'hash, voter_node and sig required');
  if (relayed && secret !== FED_SECRET) return fail(res, 401, 'invalid federation secret');
  const proposal = stmt.getSeedProposal.get(hash);
  if (!proposal) return fail(res, 404, 'unknown seed proposal hash -- propose it first via POST /api/governance/seeds/propose');
  const isSelf = voter_node === ledger.NODE_ID;
  const node = isSelf ? null : stmt.federationNodeById.get(voter_node);
  const pubkey = isSelf ? nodeIdentity.publicKey : (node && node.pubkey);
  if (!pubkey) return fail(res, 404, `unknown voter_node: ${voter_node}`);
  if (!didlib.verify(pubkey, `seeds-propose:${hash}:${voter_node}`, sig)) return fail(res, 403, 'invalid vote signature');
  stmt.upsertVote.run('seeds:' + hash, voter_node, sig, Date.now());
  if (!relayed) relaySeedVoteToAllPeers(hash, voter_node, sig);
  const votes = stmt.countVotes.get('seeds:' + hash).n;
  const totalNodes = stmt.countFederationNodes.get().n + 1;
  const threshold = Math.floor(totalNodes / 2) + 1;
  const endorsed = votes >= threshold;
  if (endorsed) ledger.append('seeds.endorsed', { hash, votes, threshold, ts: Date.now() }).catch(() => {});
  ok(res, { hash, votes, threshold, endorsed });
});
app.get('/api/governance/seeds/:hash', async (req, res) => {
  const proposal = stmt.getSeedProposal.get(req.params.hash);
  if (!proposal) return fail(res, 404, 'unknown proposal');
  const votes = stmt.countVotes.get('seeds:' + req.params.hash).n;
  const totalNodes = stmt.countFederationNodes.get().n + 1;
  const threshold = Math.floor(totalNodes / 2) + 1;
  ok(res, { hash: req.params.hash, seeds: JSON.parse(proposal.seeds), proposed_by: proposal.proposed_by,
    created_at: proposal.created_at, votes, threshold, endorsed: votes >= threshold });
});

// ---- 2. Discover agents (public) ----
// ADR-0005 direction 1's original design proposed `?capability=X&input=field1,field2` -- filter to
// agents whose matching capability's input_schema they can actually satisfy with the fields the
// caller is offering. This was designed but never implemented (only `capability` name matching
// existed); found during the 2026-07-24 ADR/spec audit. Semantics: an agent matches if some
// capability (matching `cap`, if given) has no input_schema at all (untyped, matches anything) OR
// has an input_schema whose `required` fields are all present in the caller's offered field set --
// i.e. the caller isn't missing anything the agent would need.
function capabilitySatisfiesInput(cap, offeredFields) {
  const structured = cap && typeof cap === 'object';
  const required = structured && cap.input_schema && Array.isArray(cap.input_schema.required) ? cap.input_schema.required : null;
  if (!required) return true; // no declared requirement -- can't rule it out
  return required.every(f => offeredFields.includes(f));
}
// ---- Keyset pagination (P0-1, 2026-07-25) ----
// `GET /api/agents` used to end in a hard-coded `agents.slice(0, 50)` and `/api/rooms` in
// `.slice(0, 30)`, with no limit, no cursor and no total. Past those counts the rest of the
// directory was simply unreachable over the API -- the 51st agent could not be listed at all, and
// the directory page's pager was only ever paging within that truncated window.
//
// Keyset (not offset) because offsets skip or repeat rows when records are inserted concurrently,
// and because keyset is what still works once this moves off an in-memory array onto SQLite/shards
// (ADR-0012) -- the wire contract stays identical through that change, which is the point.
//
// The cursor is opaque to clients on purpose: it encodes {k, id} of the last row emitted under the
// CURRENT sort, so it is only meaningful together with the same `sort`. Changing sort restarts
// paging, which is the honest behavior -- silently reinterpreting a cursor under a new ordering
// would skip rows.
const SORTS = {
  newest:     { key: a => a.created_at || 0,            dir: -1 },
  oldest:     { key: a => a.created_at || 0,            dir: 1  },
  reputation: { key: a => a.reputation || 0,            dir: -1 },
  name:       { key: a => String(a.name || '').toLowerCase(), dir: 1 },
  caps:       { key: a => (a.capabilities || []).length, dir: -1 },
};
function encodeCursor(k, id) { return Buffer.from(JSON.stringify({ k, id })).toString('base64url'); }
function decodeCursor(c) {
  try { const d = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'));
        return (d && 'k' in d && 'id' in d) ? d : null; } catch { return null; }
}
// Total order: sort key first, then id as a deterministic tiebreak so equal keys still page cleanly.
function cmpWith(sort) {
  const { key, dir } = sort;
  return (a, b) => {
    const ka = key(a), kb = key(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}
function paginate(rows, { sort = 'newest', limit, cursor }) {
  const spec = SORTS[sort] || SORTS.newest;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const sorted = rows.slice().sort(cmpWith(spec));
  let start = 0;
  const cur = cursor ? decodeCursor(cursor) : null;
  if (cur) {
    // Resume strictly after the cursor row under this ordering.
    start = sorted.findIndex(r => {
      const kr = spec.key(r);
      if (kr === cur.k) return r.id > cur.id;
      return spec.dir === 1 ? kr > cur.k : kr < cur.k;
    });
    if (start < 0) start = sorted.length;
  }
  const page = sorted.slice(start, start + lim);
  const last = page[page.length - 1];
  const hasMore = start + lim < sorted.length;
  return {
    page,
    total: sorted.length,
    next_cursor: hasMore && last ? encodeCursor(spec.key(last), last.id) : null,
  };
}
app.get('/api/agents', async (req, res) => {
  const q = req.query.q || '';
  const cap = req.query.capability || '';
  const inputFields = (req.query.input || '').split(',').map(s => s.trim()).filter(Boolean);
  // ADR-0008: a pure capability filter (no free-text q) uses the inverted index, O(matching agents)
  // instead of scanning every locally-held agent -- this is the query path that actually needs to
  // stay fast as the directory grows toward the scale ADR-0008 targets. This changed exact-match
  // semantics for capability alone (was substring); combined with `q`, substring matching is kept
  // (that path already requires a full scan, so there's no fast-path benefit to preserve).
  let agents;
  if (cap && !q) {
    agents = store.listAgentsByCapability(cap);
  } else {
    agents = store.listAgents(q);
    // F1: capabilities may be structured objects ({name, input_schema, ...}) as well as legacy
    // strings; match against the normalized capability name either way (schema.capName handles both).
    if (cap) agents = agents.filter(x => (x.capabilities || []).some(c => schema.capName(c).includes(cap)));
  }
  if (inputFields.length) {
    agents = agents.filter(x => (x.capabilities || []).some(c =>
      (!cap || schema.capName(c).includes(cap)) && capabilitySatisfiesInput(c, inputFields)));
  }
  // Attach reputation, revoked flags, and F2 verified-credential count (the trust root, visible)
  agents = agents.map(x => {
    const r = store.getShared(repKey(x.id));
    const rev = store.getShared('revoke:' + (x.did || x.id));
    return { ...x, reputation: r ? r.score : 0, revoked: !!(rev && rev.revoked), credential_count: verifiedCredentialCount(x) };
  });
  const { page, total, next_cursor } = paginate(agents, {
    sort: req.query.sort, limit: req.query.limit, cursor: req.query.cursor,
  });
  ok(res, { agents: page, total, next_cursor, sort: SORTS[req.query.sort] ? req.query.sort : 'newest' });
});

// F1: aggregate capability catalog -- lets an agent discover "what can this network do" in one call
app.get('/api/capabilities', async (req, res) => {
  const counts = store.capabilityCounts(); // ADR-0008: O(distinct capabilities), not O(total agents)
  const capabilities = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, agents]) => ({ name, agents }));
  ok(res, { capabilities });
});

// ADR-0009: protocol feature ADOPTION reporting -- observable data ("how many known nodes support
// feature X"), explicitly NOT an activation trigger. Unlike Bitcoin's soft-fork signaling, MOYE has
// no hashpower-equivalent objective threshold to gate on; this is informational for humans/tooling
// deciding whether a feature is safe to rely on network-wide, not a switch anything flips on
// automatically. Pure function so it's testable without a live DB (see verification in ADR-0009).
function computeAdoption(nodeRows, self) {
  const rows = [{ id: self.id, features: self.features, protocol_version: self.protocol_version }, ...nodeRows];
  const total = rows.length;
  const versions = {};
  const featureCounts = {};
  for (const row of rows) {
    if (row.protocol_version) versions[row.protocol_version] = (versions[row.protocol_version] || 0) + 1;
    let feats = [];
    if (Array.isArray(row.features)) feats = row.features;
    else if (typeof row.features === 'string') { try { feats = JSON.parse(row.features) || []; } catch { feats = []; } }
    for (const f of feats) featureCounts[f] = (featureCounts[f] || 0) + 1;
  }
  const features = Object.entries(featureCounts)
    .map(([name, count]) => ({ name, nodes: count, of_known: total, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.nodes - a.nodes);
  return { known_nodes: total, protocol_versions: versions, features };
}
app.get('/api/protocol/adoption', async (req, res) => {
  const peerRows = stmt.allFederationNodeFeatures.all().map(r => ({ ...r, features: r.features })); // features stays JSON text, computeAdoption parses it
  ok(res, computeAdoption(peerRows, { id: ledger.NODE_ID, features: PROTOCOL_FEATURES, protocol_version: PROTOCOL_VERSION }));
});

// ---- 3. Get a single agent (public) ----
// ADR-0008: when this node doesn't have an agent locally and sharding is in use, give a best-effort
// "try this peer" hint instead of a flat, uninformative 404 -- computed from shard configs peers
// have announced via POST /api/federation/nodes (see bootstrapFederation()). Best-effort only: with
// NUM_SHARDS=1 (default) there's nothing useful to hint (every node should have every agent), and
// even with sharding on, this depends on having already learned a peer's shard config, which isn't
// guaranteed (network still converging, or the operator hasn't wired every peer relationship yet).
function findShardPeerHint(agentId) {
  if (shard.NUM_SHARDS <= 1) return null;
  const target = shard.shardOf(agentId);
  for (const row of stmt.allFederationNodes.all()) {
    if (!row.served_shards) continue;
    let served;
    try { served = JSON.parse(row.served_shards); } catch { continue; }
    if (served === 'all' || (Array.isArray(served) && served.includes(target))) {
      return { shard: target, peer_id: row.id, peer_endpoint: row.endpoint };
    }
  }
  return null;
}

// P2-3: on local miss, 307 or proxy to a peer that serves the agent's shard (client-transparent when
// clients follow redirects / when using proxy mode). NUM_SHARDS=1 → no-op (hint stays null).
async function shardMissResponse(req, res, agentId) {
  const hops = parseInt(req.headers['x-moye-shard-hops'] || '0', 10) || 0;
  const hint = findShardPeerHint(agentId);
  if (!hint || !hint.peer_endpoint) {
    return res.status(404).json({ success: false, error: 'agent not found on this node', hint });
  }
  if (hops >= shard.FORWARD_MAX_HOPS || shard.ROUTE_MODE === 'hint') {
    return res.status(404).json({ success: false, error: 'agent not found on this node', hint });
  }
  const destPath = req.originalUrl || req.url || `/api/agents/${encodeURIComponent(agentId)}`;
  const location = hint.peer_endpoint.replace(/\/$/, '') + destPath.replace(/^\/a2a/, '');
  // Prefer absolute /api/... on peer (peers expose a2a root without /a2a prefix usually)
  const peerUrl = hint.peer_endpoint.replace(/\/$/, '') + `/api/agents/${encodeURIComponent(agentId)}`;

  if (shard.ROUTE_MODE === '307') {
    res.setHeader('Location', peerUrl);
    res.setHeader('X-Moye-Shard', String(hint.shard));
    res.setHeader('X-Moye-Shard-Peer', hint.peer_id || '');
    return res.status(307).json({
      success: false, error: 'redirect to shard peer', hint, location: peerUrl,
    });
  }
  // proxy mode
  try {
    const u = new URL(peerUrl);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const proxied = await new Promise((resolve, reject) => {
      const r = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET',
        headers: {
          Accept: req.headers.accept || 'application/json',
          'X-Moye-Shard-Hops': String(hops + 1),
        },
        timeout: shard.FORWARD_TIMEOUT_MS,
      }, (pr) => {
        let buf = '';
        pr.on('data', (c) => { buf += c; });
        pr.on('end', () => resolve({ status: pr.statusCode, headers: pr.headers, body: buf }));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('shard forward timeout')); });
      r.end();
    });
    res.status(proxied.status || 502);
    res.setHeader('X-Moye-Shard-Proxied', hint.peer_id || '');
    const ct = proxied.headers && proxied.headers['content-type'];
    if (ct) res.setHeader('Content-Type', ct);
    return res.send(proxied.body);
  } catch (e) {
    return res.status(404).json({
      success: false, error: 'agent not found on this node', hint,
      forward_error: e.message || String(e),
    });
  }
}

app.get('/api/agents/:id', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return shardMissResponse(req, res, req.params.id);
  // P1-4 content negotiation (subset): same resource, markdown for LLM clients.
  const accept = (req.headers.accept || '').toString();
  if (accept.includes('text/markdown') && !accept.includes('application/json')) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Vary', 'Accept');
    const caps = (a.capabilities || []).map((c) => (typeof c === 'string' ? c : (c && c.name) || '?')).join(', ');
    return res.send(`# ${a.name}\n\n- id: \`${a.id}\`\n- did: \`${a.did || 'none'}\`\n- capabilities: ${caps || 'none'}\n- home_node: ${a.home_node || '?'}\n\n${a.description || ''}\n`);
  }
  res.setHeader('Vary', 'Accept');
  ok(res, { agent: a });
});

// ---- 4. Send a message (A2A routing, requires auth: from_agent must hold its own token) ----
// ---- 5. Agent pulls its own messages (requires auth) ----
app.get('/api/agents/:id/inbox', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token required');
  if (me.id !== req.params.id) return fail(res, 403, 'token owner mismatch');
  const rows = stmt.inboxByAgent.all(req.params.id);
  rows.forEach(r => {
    r.encrypted = !!r.encrypted;
    if (r.attachments && typeof r.attachments === 'string') {
      try { r.attachments = JSON.parse(r.attachments); } catch { r.attachments = null; }
    }
  });
  ok(res, { messages: rows });
});

// ---- 6. Mark a message read/handled (requires auth: only the recipient can ack their own message) ----
// This route used to be registered twice, along with a separate "anchor the receipt" version below --
// Express only honors the first handler, so:
//   1) recipient check was missing -- any authenticated agent could ack anyone's message (privilege escalation);
//   2) the message.ack ledger-anchoring code never actually ran, so the ledger never had this event type.
// Merged into a single handler, fixing both issues at once.
app.post('/api/messages/:id/ack', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const msg = stmt.messageById.get(req.params.id);
  if (!msg) return fail(res, 404, 'message not found');
  if (msg.to_agent !== me.id) return fail(res, 403, 'only recipient can ack');
  const status = req.body && req.body.status ? req.body.status : 'done';
  stmt.ackMessage.run(status, req.params.id);
  ledger.append('message.ack', { id: req.params.id, status, ts: Date.now() }).catch(()=>{});
  ok(res, { message_id: req.params.id, status });
});

// ================= STAGE 2 + room privacy/E2E chat: Collaboration rooms =================
// Room privacy model (added 2026-07-24, in response to the "private room = shared, confidential,
// multi-agent memory" use case):
//   - visibility: 'public' (default, unchanged behavior) | 'private'
//   - Private rooms are membership-gated for both reading and posting. Membership is proven with a
//     `membership_proof` value the CLIENT derives from a secret it generated itself -- the server
//     only ever sees/stores sha256(secret) equivalent, NEVER the raw secret and NEVER the room's
//     actual encryption key (which the client derives from the same secret via a different HKDF
//     `info` string, entirely client-side, never transmitted). This means: even a fully compromised
//     server can (at most) tamper with the membership LIST or read ciphertext -- it can never derive
//     the key needed to decrypt room chat content. Same trust boundary as the existing 1:1 E2E
//     feature ("server only ever stores ciphertext"), extended to a shared/group key instead of
//     per-message ephemeral ECDH. See a2a/docs/adr/ (local) for the full design writeup.
//   - Room chat messages are stored as an RGA CRDT in shared state (`room-chat:<room_id>`), NOT in
//     SQLite -- this deliberately avoids the existing room_tasks bug (see below) where SQLite-local
//     data silently fails to federate across nodes. Chat converges correctly regardless of which
//     node different members are connected to, exactly like the agent/room directory already does.
//
// FIXED 2026-07-25 (was the KNOWN GAP flagged here): room tasks used to live ONLY in the node-local
// `room_tasks` SQLite table with no federation replication at all, so two agents in the same room but
// connected to different nodes never saw each other's task assignments or results. They now ride the
// same RGA-CRDT shared-state path the room chat log already uses (independently verified to federate
// correctly), as an append-only EVENT log rather than mutable rows -- a task's current state is folded
// from its events, which is what lets concurrent writes on different nodes converge instead of one
// clobbering the other. The `room_tasks` table is kept read-only as the migration source for rows
// written before this change (see migrateLegacyRoomTasks) and is no longer written to.

function roomMembershipHash(proof) { return crypto.createHash('sha256').update(String(proof)).digest('hex'); }
function isRoomMember(room, agentId) { return room.creator === agentId || (Array.isArray(room.member_ids) && room.member_ids.includes(agentId)); }
function canReadRoom(room, agentId) { return room.visibility !== 'private' || isRoomMember(room, agentId); }
function roomChatKey(roomId) { return 'room-chat:' + roomId; }
async function appendRoomMessage(roomId, msg) {
  const key = roomChatKey(roomId);
  const cur = store.getShared(key); // already-materialized array (crdt.read output) or null
  const nodes = (Array.isArray(cur) ? cur : []).map((elem, i) => ({ id: elem.id || `n${i}`, elem, deleted: false }));
  nodes.push({ id: msg.id, elem: msg, deleted: false });
  const L = Date.now();
  await store.putShared(key, { crdt: 'rga', nodes }, L, ledger.NODE_ID);
}

// Site widgets (guestbook + visit counter). Guestbook POST mirrors into the dogfood room so
// ops/dev/coder see submissions without a public list endpoint (privacy fix 2026-08-06).
app.use(siteRoutes(db, {
  onGuestbook: async ({ agent_name, content }) => {
    const roomId = process.env.GUESTBOOK_ROOM_ID || siteRoutes.DEFAULT_MIRROR_ROOM;
    let room = store.getRoom(roomId);
    if (!room) {
      // Seed an empty public room when the configured mirror id is missing (smoke / fresh node).
      // Production dogfood room already exists; this is a no-op there.
      await store.putRoom(roomId, {
        id: roomId,
        name: 'guestbook-mirror',
        description: 'Auto-seeded guestbook mirror target',
        creator: '(site-guestbook)',
        status: 'open',
        home_node: ledger.NODE_ID,
        created_at: Date.now(),
        visibility: 'public',
        membership_proof_hash: null,
        member_ids: [],
      });
      room = store.getRoom(roomId);
    }
    if (!room) {
      console.log(`[guestbook] mirror skipped: could not open room ${roomId}`);
      return;
    }
    const text = `New feedback from ${agent_name}: ${content}`;
    const msg = {
      id: newId('rmsg'),
      from_agent: '(site-guestbook)',
      content: text,
      encrypted: false,
      sender_sig: null,
      type: null,
      ref: null,
      awaiting: null,
      attachments: null,
      ts: Date.now(),
    };
    await appendRoomMessage(roomId, msg);
    for (const uid of (room.member_ids || [])) {
      pushTo(uid, { type: 'room_message', room_id: roomId, message: msg });
    }
    ledger.append('guestbook.mirror', {
      room: roomId, from: '(site-guestbook)', content_hash: crypto.createHash('sha256').update(text).digest('hex'), ts: msg.ts,
    }).catch(() => {});
  },
}));

// ---- Federated room tasks (see the "FIXED 2026-07-25" note above) ----
function roomTasksKey(roomId) { return 'room-tasks:' + roomId; }
async function appendRoomTaskEvent(roomId, ev) {
  const key = roomTasksKey(roomId);
  const cur = store.getShared(key);
  const nodes = (Array.isArray(cur) ? cur : []).map((elem, i) => ({ id: elem.id || `n${i}`, elem, deleted: false }));
  nodes.push({ id: ev.id, elem: ev, deleted: false });
  await store.putShared(key, { crdt: 'rga', nodes }, Date.now(), ledger.NODE_ID);
}
// Fold the event log into current task state. Deliberately TWO passes: RGA orders nodes by event id,
// not by causality, so a 'report' that federated in before its own 'assign' must still apply. Every
// tiebreak is deterministic (ts, then event id) so every node folds the same log into identical
// state -- that property is what makes this safe to replicate, not the ordering of arrival.
function materializeRoomTasks(roomId) {
  const events = store.getShared(roomTasksKey(roomId));
  const list = Array.isArray(events) ? events : [];
  const tasks = new Map();
  for (const e of list) {
    if (!e || e.kind !== 'assign' || !e.task_id) continue;
    tasks.set(e.task_id, {
      id: e.task_id, task: e.task, assignee: e.assignee, result: null, status: 'assigned',
      created_at: e.ts, updated_at: e.ts, _rts: 0, _rid: '',
    });
  }
  for (const e of list) {
    if (!e || e.kind !== 'report' || !e.task_id) continue;
    const t = tasks.get(e.task_id);
    if (!t) continue;                   // a report whose assign event we haven't received (yet)
    if (e.by !== t.assignee) continue;  // same rule as before: only the assignee's own report counts
    if (e.ts < t._rts || (e.ts === t._rts && String(e.id) <= t._rid)) continue; // LWW, id breaks ties
    t.result = e.result; t.status = 'done'; t.updated_at = e.ts; t._rts = e.ts; t._rid = String(e.id);
  }
  return [...tasks.values()]
    .map(({ _rts, _rid, ...t }) => t)
    .sort((a, b) => (a.created_at - b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
// One-time, best-effort migration of rows written before room tasks federated. Only fills in task ids
// the log doesn't already carry, so it is idempotent and can never clobber state that federated in
// from a peer. Runs after store.init() so the log it checks against is the post-sync one.
async function migrateLegacyRoomTasks() {
  let rows;
  try { rows = stmt.allRoomTasks.all(); } catch { return; }
  if (!rows.length) return;
  const byRoom = new Map();
  for (const r of rows) {
    if (!byRoom.has(r.room_id)) byRoom.set(r.room_id, []);
    byRoom.get(r.room_id).push(r);
  }
  let migrated = 0;
  for (const [roomId, list] of byRoom) {
    const known = new Set(materializeRoomTasks(roomId).map(t => t.id));
    for (const r of list) {
      if (known.has(r.id)) continue;
      await appendRoomTaskEvent(roomId, { id: `tev_${r.id}_assign`, kind: 'assign', task_id: r.id,
        task: r.task, assignee: r.assignee, by: '(migrated)', ts: r.created_at });
      if (r.status === 'done' && r.result != null) {
        await appendRoomTaskEvent(roomId, { id: `tev_${r.id}_report`, kind: 'report', task_id: r.id,
          result: r.result, by: r.assignee, ts: r.updated_at });
      }
      migrated++;
    }
  }
  if (migrated) console.log(`[rooms] migrated ${migrated} pre-federation room task(s) into the shared event log`);
}

// ---- 7. Create a room (requires auth) ----
app.post('/api/rooms', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token required');
  const { name, description, members, visibility, membership_proof } = req.body || {};
  if (!name) return fail(res, 400, 'name required');
  const isPrivate = visibility === 'private';
  // Private rooms require a client-derived membership proof at creation time -- the server never
  // generates or sees the raw secret, only whatever one-way value the client chooses to send. See
  // the trust-model comment above the room section.
  if (isPrivate && !membership_proof) return fail(res, 400, 'private rooms require membership_proof (derived client-side from a secret you generate and keep)');
  const id = newId('room');
  await store.putRoom(id, {
    id, name, description: description || '', creator: me.id, status: 'open',
    home_node: ledger.NODE_ID, created_at: Date.now(),
    visibility: isPrivate ? 'private' : 'public',
    membership_proof_hash: isPrivate ? roomMembershipHash(membership_proof) : null,
    member_ids: [me.id],
  });
  if (Array.isArray(members)) {
    for (const m of members) {
      const mid = newId('msg');
      stmt.insertMessage.run(mid, me.id, m, `[room:${id}] Invited you to join collaboration room "${name}"`, 'pending', 0, null, null, null, Date.now());
    }
  }
  ok(res, { room_id: id, visibility: isPrivate ? 'private' : 'public' });
});

// ---- 7b. Join a room (requires auth). Public: open. Private: requires membership_proof. ----
app.post('/api/rooms/:id/join', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (isRoomMember(room, me.id)) return ok(res, { room_id: room.id, already_member: true });
  if (room.visibility === 'private') {
    const { membership_proof } = req.body || {};
    if (!membership_proof || roomMembershipHash(membership_proof) !== room.membership_proof_hash) {
      return fail(res, 403, 'invalid membership_proof');
    }
  }
  const member_ids = [...(room.member_ids || []), me.id];
  await store.putRoom(room.id, { ...room, member_ids });
  ok(res, { room_id: room.id, joined: true });
});

// ---- 8. List rooms (private rooms only shown to members; auth optional, best-effort) ----
app.get('/api/rooms', async (req, res) => {
  const me = await authAgent(req).catch(() => null);
  const rooms = store.listRooms()
    .filter(r => r.visibility !== 'private' || (me && isRoomMember(r, me.id)))
    .map(({ membership_proof_hash, ...r }) => r); // never leak the hash, even to members
  // Same keyset pagination as /api/agents -- this used to be a hard .slice(0, 30), which made the
  // 31st room unreachable over the API entirely.
  const { page, total, next_cursor } = paginate(rooms, {
    sort: req.query.sort, limit: req.query.limit, cursor: req.query.cursor,
  });
  ok(res, { rooms: page, total, next_cursor });
});

// ---- 9. Get room details + all task/result summaries ----
// Note: this route used to be registered twice, along with "10." below -- Express only honors
// the first matching handler, so the version that included tasks never actually took effect
// (callers could never get the task list back). Merged into one.
app.get('/api/rooms/:id', async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private') {
    const me = await authAgent(req).catch(() => null);
    if (!me || !canReadRoom(room, me.id)) return fail(res, 403, 'private room: membership required');
  }
  const { membership_proof_hash, ...safeRoom } = room;
  const tasks = materializeRoomTasks(req.params.id);
  ok(res, { room: safeRoom, tasks });
});

// ---- 9c. Room chat: shared, persistent, federation-safe (RGA CRDT) memory for room members ----
// This is the "shared memory" primitive: any member can post, every member (including ones who join
// later) can read the full history. Optionally E2E-encrypted -- see the trust-model comment above.
// Structured message types (2026-07-24, scenario 5: non-monetary public task claiming) -- a
// convention layered on top of the plain room chat log, not a separate storage mechanism. Reuses
// the already-federating RGA chat log rather than replicating the room_tasks federation bug.
// 'task-broadcast': any member posts a task looking for volunteers (content = description).
// 'task-claim' (ref = broadcast message id): any member volunteers (content = optional note).
// 'task-accept' (ref = claim message id): ONLY the room creator can post this -- the one place this
// convention gets real server-side enforcement, so "who got picked" in the shared log can't be
// spoofed by a non-creator. Everything else is a client-side reading convention; the server just
// carries `type`/`ref` alongside `content` without interpreting them further.
// Structured message types — closed vocabulary (anything else → 400).
// task-*: public task claiming (2026-07-24). ask/resolve: explicit awaiting (ADR-0018 R1).
const ROOM_MESSAGE_TYPES = new Set(['task-broadcast', 'task-claim', 'task-accept', 'ask', 'resolve']);

function materializeRoomAwaiting(roomId) {
  return roomAwaiting.materializeRoomAwaiting(roomId, {
    getRoom: (id) => store.getRoom(id),
    getShared: (k) => store.getShared(k),
    roomChatKey,
    getAgent: (id) => store.getAgent(id),
  });
}
const agentMatchesAwaiting = roomAwaiting.agentMatchesAwaiting;

app.post('/api/rooms/:id/messages', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private' && !isRoomMember(room, me.id)) return fail(res, 403, 'private room: membership required to post');
  const {
    content, encrypted, sender_sig, type, ref, awaiting: awaitingWho,
    awaiting_capability: awaitingCapability, schema, payload, by,
  } = req.body || {};
  if (typeof content !== 'string' || !content) return fail(res, 400, 'content required');
  if (content.length > MAX_CONTENT_LEN) return fail(res, 413, 'content too large');
  if (type !== undefined && type !== null && !ROOM_MESSAGE_TYPES.has(type)) return fail(res, 400, `unknown type: ${type}`);
  if (type === 'task-accept' && me.id !== room.creator) return fail(res, 403, 'only the room creator can accept a claim');
  let askTargets = null;
  if (type === 'ask') {
    askTargets = roomAwaiting.normalizeAskTargets(awaitingWho, awaitingCapability);
    if (!askTargets.ok) return fail(res, askTargets.status || 400, askTargets.error);
  }
  if (type === 'resolve') {
    if (!ref) return fail(res, 400, 'resolve requires ref (ask message id)');
    const prior = (store.getShared(roomChatKey(room.id)) || []).find((m) => m.id === ref);
    if (!prior || prior.type !== 'ask') return fail(res, 400, 'resolve ref must point at an ask message');
  }
  // ADR-0027 R9: optional machine-readable payload (store-and-forward; server does not validate shape).
  let schemaOut = null;
  let payloadOut = null;
  if (schema !== undefined && schema !== null) {
    if (typeof schema !== 'string' || !schema || schema.length > 128) {
      return fail(res, 400, 'schema must be a non-empty string ≤128 chars');
    }
    schemaOut = schema;
  }
  if (payload !== undefined && payload !== null) {
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      return fail(res, 400, 'payload must be a JSON object');
    }
    let raw;
    try { raw = JSON.stringify(payload); }
    catch { return fail(res, 400, 'payload is not JSON-serializable'); }
    if (raw.length > 65536) return fail(res, 413, 'payload too large');
    payloadOut = payload;
  }
  // ADR-0027 R11: optional deadline on ask messages only (ms epoch). No server-side scheduling.
  let byOut = null;
  if (by !== undefined && by !== null) {
    if (type !== 'ask') return fail(res, 400, 'by is only valid on type=ask messages');
    const n = Number(by);
    if (!Number.isFinite(n) || n <= 0) return fail(res, 400, 'by must be a positive ms epoch timestamp');
    byOut = Math.floor(n);
  }
  // Private rooms: refuse plaintext message bodies — same posture as attachments below.
  // Clients must encrypt under room_key and set encrypted:true; omitting the flag is treated as plaintext.
  if (room.visibility === 'private' && !encrypted) {
    return fail(res, 400, 'private room messages must set encrypted:true (encrypt under room_key before post)');
  }
  let atts;
  try { atts = attachments.normalizeAttachments(req.body && req.body.attachments); }
  catch (e) { return fail(res, e.status || 400, e.message); }
  // Private rooms: if any attachment is plaintext (encrypted:false), refuse — otherwise the
  // E2E promise is broken (CID would point at readable bytes the server/IPFS can serve).
  if (room.visibility === 'private' && atts && atts.some((a) => !a.encrypted)) {
    return fail(res, 400, 'private room attachments must set encrypted:true (encrypt under room_key before upload)');
  }
  const msg = {
    id: newId('rmsg'), from_agent: me.id, content, encrypted: !!encrypted,
    sender_sig: sender_sig || null, type: type || null, ref: ref || null,
    awaiting: type === 'ask' ? askTargets.awaiting : null,
    attachments: atts, ts: Date.now(),
  };
  if (type === 'ask' && askTargets.awaiting_capability) msg.awaiting_capability = askTargets.awaiting_capability;
  if (schemaOut) msg.schema = schemaOut;
  if (payloadOut) msg.payload = payloadOut;
  if (byOut != null) msg.by = byOut;
  await appendRoomMessage(room.id, msg);
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  ledger.append('room.message', {
    room: room.id, from: me.id, content_hash: contentHash, type: msg.type || null,
    attachment_cids: atts ? atts.map((a) => a.cid) : null, ts: msg.ts,
  }).catch(() => {});
  for (const uid of (room.member_ids || [])) if (uid !== me.id) pushTo(uid, { type: 'room_message', room_id: room.id, message: msg });
  ok(res, { message_id: msg.id, ts: msg.ts });
});
app.get('/api/rooms/:id/messages', async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private') {
    const me = await authAgent(req).catch(() => null);
    if (!me || !canReadRoom(room, me.id)) return fail(res, 403, 'private room: membership required');
  }
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const all = store.getShared(roomChatKey(room.id)) || [];
  ok(res, { room_id: room.id, messages: all.slice(-limit) });
});

// ADR-0018 R1: open asks targeting a specific agent (or DID) in this room.
app.get('/api/rooms/:id/awaiting/:who', async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private') {
    const me = await authAgent(req).catch(() => null);
    if (!me || !canReadRoom(room, me.id)) return fail(res, 403, 'private room: membership required');
  }
  const who = req.params.who;
  const whoAgent = store.getAgent(who) || { id: who, did: who.startsWith('did:') ? who : null };
  const open = materializeRoomAwaiting(room.id).filter((m) => roomAwaiting.askConcernsAgent(m, who, whoAgent, room));
  ok(res, { room_id: room.id, who, awaiting: open });
});

// Cross-room: everything currently awaiting this agent (by id or did).
app.get('/api/agents/:id/awaiting', async (req, res) => {
  const agent = store.getAgent(req.params.id);
  if (!agent) return fail(res, 404, 'agent not found');
  const items = [];
  for (const room of store.listRooms()) {
    if (room.visibility === 'private' && !canReadRoom(room, agent.id)) continue;
    for (const m of materializeRoomAwaiting(room.id)) {
      if (roomAwaiting.askConcernsAgent(m, agent.id, agent, room) || roomAwaiting.askConcernsAgent(m, agent.did, agent, room)) {
        items.push({ room_id: room.id, room_name: room.name, ask: m });
      }
    }
  }
  ok(res, { agent_id: agent.id, did: agent.did || null, awaiting: items });
});

// ---- ADR-0018 R2: room state document (single current snapshot, CRDT LWW) ----
function roomStateKey(id) { return 'room-state:' + id; }

/** R15 (ADR-0034): read-time only — how far the state doc lags the chat log. No scheduler. */
async function roomStateStaleness(roomId, stateDoc) {
  const msgs = store.getShared(roomChatKey(roomId)) || [];
  const updatedAt = stateDoc && stateDoc.updated_at != null ? Number(stateDoc.updated_at) : 0;
  const messages_since_update = msgs.filter((m) => (m.ts || 0) > updatedAt).length;
  let last_checkpoint = null;
  try {
    const rows = await ledger.byType('room.checkpoint', 500);
    for (let i = rows.length - 1; i >= 0; i--) {
      const e = rows[i];
      if (!e.data || e.data.room_id !== roomId) continue;
      // Prefer an explicit consolidation pointer on the state doc when present (R16).
      if (stateDoc && stateDoc.last_checkpoint_seq != null
        && Number(stateDoc.last_checkpoint_seq) === Number(e.seq)) {
        last_checkpoint = {
          seq: e.seq, hash: e.hash, label: e.data.label || null, ts: e.data.ts || null,
        };
        break;
      }
      // Else: most recent checkpoint at or before the state write (or any if state never written).
      const cpTs = e.data.ts || 0;
      if (!updatedAt || cpTs <= updatedAt) {
        last_checkpoint = {
          seq: e.seq, hash: e.hash, label: e.data.label || null, ts: e.data.ts || null,
        };
        break;
      }
    }
  } catch { /* ledger unavailable — leave null */ }
  return {
    messages_since_update,
    message_count: msgs.length,
    state_updated_at: updatedAt || null,
    last_checkpoint,
  };
}

app.get('/api/rooms/:id/state', async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private') {
    const me = await authAgent(req).catch(() => null);
    if (!me || !canReadRoom(room, me.id)) return fail(res, 403, 'private room: membership required');
  }
  const stateDoc = store.getShared(roomStateKey(room.id)) || {
    summary: '', decisions: [], open_questions: [], awaiting: [], updated_at: null, updated_by: null,
  };
  // Prefer live awaiting materialization over stale copy in the doc.
  const liveAwaiting = materializeRoomAwaiting(room.id).map((m) => ({
    what: m.content, who: m.awaiting, awaiting_capability: m.awaiting_capability || null,
    awaiting_remaining: m.awaiting_remaining || null, awaiting_mode: m.awaiting_mode || null,
    since: m.ts, ref: m.id, by: m.from_agent,
  }));
  const staleness = await roomStateStaleness(room.id, stateDoc);
  ok(res, { room_id: room.id, state: { ...stateDoc, awaiting: liveAwaiting }, staleness });
});
app.post('/api/rooms/:id/state', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (!isRoomMember(room, me.id) && room.creator !== me.id) return fail(res, 403, 'membership required');
  if (room.visibility === 'private' && !isRoomMember(room, me.id)) return fail(res, 403, 'private room: membership required');
  const body = req.body || {};
  const prev = store.getShared(roomStateKey(room.id)) || {};
  const next = {
    summary: body.summary != null ? String(body.summary).slice(0, 4000) : (prev.summary || ''),
    decisions: Array.isArray(body.decisions) ? body.decisions.slice(0, 100) : (prev.decisions || []),
    open_questions: Array.isArray(body.open_questions) ? body.open_questions.slice(0, 100) : (prev.open_questions || []),
    updated_at: Date.now(),
    updated_by: me.id,
  };
  // R16 may pass last_checkpoint_seq when consolidating; preserve unless explicitly cleared.
  if (body.last_checkpoint_seq != null) next.last_checkpoint_seq = Number(body.last_checkpoint_seq);
  else if (prev.last_checkpoint_seq != null) next.last_checkpoint_seq = prev.last_checkpoint_seq;
  await store.putShared(roomStateKey(room.id), next, Date.now(), me.id);
  ledger.append('room.state_update', { room: room.id, by: me.id, ts: next.updated_at }).catch(() => {});
  ok(res, { room_id: room.id, state: next, staleness: await roomStateStaleness(room.id, next) });
});

// R16 (ADR-0034): volunteer consolidation — any member may submit; prior proposals stay visible.
// Reuses schema/payload (R9). Does NOT require creator or N-of-M (user decision).
app.post('/api/rooms/:id/consolidate', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (!isRoomMember(room, me.id) && room.creator !== me.id) return fail(res, 403, 'membership required');
  const body = req.body || {};
  const summary = body.summary != null ? String(body.summary).slice(0, 4000) : '';
  const checkpointSeq = body.checkpoint_seq != null ? Number(body.checkpoint_seq) : null;
  const prev = store.getShared(roomStateKey(room.id)) || {};
  const proposals = Array.isArray(prev.consolidation_proposals) ? prev.consolidation_proposals.slice() : [];
  const proposal = {
    id: newId('cprop'),
    by: me.id,
    ts: Date.now(),
    summary,
    checkpoint_seq: checkpointSeq,
    schema: body.schema || 'room-consolidate-v1',
    payload: body.payload && typeof body.payload === 'object' ? body.payload : null,
  };
  proposals.push(proposal);
  // Keep history visible (do not silently overwrite prior proposals). Cap length.
  const trimmed = proposals.slice(-50);
  const next = {
    summary: summary || prev.summary || '',
    decisions: Array.isArray(prev.decisions) ? prev.decisions : [],
    open_questions: Array.isArray(prev.open_questions) ? prev.open_questions : [],
    consolidation_proposals: trimmed,
    updated_at: Date.now(),
    updated_by: me.id,
  };
  if (checkpointSeq != null) next.last_checkpoint_seq = checkpointSeq;
  else if (prev.last_checkpoint_seq != null) next.last_checkpoint_seq = prev.last_checkpoint_seq;
  await store.putShared(roomStateKey(room.id), next, Date.now(), me.id);
  // Also post a machine-readable room message so the immutable log carries the claim.
  const wire = JSON.stringify({
    schema: proposal.schema, proposal_id: proposal.id, summary, checkpoint_seq: checkpointSeq,
  });
  const msg = {
    id: newId('rmsg'), from_agent: me.id, content: wire, encrypted: false,
    sender_sig: null, type: null, ref: null, awaiting: null,
    schema: proposal.schema, payload: { proposal_id: proposal.id, summary, checkpoint_seq: checkpointSeq },
    attachments: null, ts: Date.now(),
  };
  await appendRoomMessage(room.id, msg);
  ledger.append('room.consolidate', {
    room: room.id, by: me.id, proposal_id: proposal.id, checkpoint_seq: checkpointSeq, ts: msg.ts,
  }).catch(() => {});
  ok(res, {
    room_id: room.id, proposal, message_id: msg.id,
    staleness: await roomStateStaleness(room.id, next),
    note: 'Any member may submit; re-check against the room log. Prior proposals remain in consolidation_proposals.',
  });
});

// R17: visible pin registry (ciphertext CIDs only). No contribution counters.
app.post('/api/rooms/:id/pins', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (!isRoomMember(room, me.id) && room.creator !== me.id) return fail(res, 403, 'membership required');
  const cids = Array.isArray(req.body && req.body.cids) ? req.body.cids : [];
  const clean = cids.filter((c) => typeof c === 'string' && c.length >= 10 && c.length <= 128).slice(0, 64);
  const key = 'room-pins:' + room.id;
  const cur = store.getShared(key) || {};
  const byAgent = cur.by_agent && typeof cur.by_agent === 'object' ? { ...cur.by_agent } : {};
  const prev = new Set(Array.isArray(byAgent[me.id]) ? byAgent[me.id] : []);
  for (const c of clean) prev.add(c);
  byAgent[me.id] = [...prev].slice(-500);
  const next = { by_agent: byAgent, updated_at: Date.now() };
  await store.putShared(key, next, Date.now(), me.id);
  ok(res, { room_id: room.id, agent_id: me.id, cids: byAgent[me.id] });
});
app.get('/api/rooms/:id/pins', async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private') {
    const me = await authAgent(req).catch(() => null);
    if (!me || !canReadRoom(room, me.id)) return fail(res, 403, 'private room: membership required');
  }
  const cur = store.getShared('room-pins:' + room.id) || { by_agent: {} };
  ok(res, { room_id: room.id, by_agent: cur.by_agent || {}, note: 'Ciphertext CID pins only; not a contribution scoreboard.' });
});

// ---- ADR-0018 R3: named checkpoint + changes-since ----
app.post('/api/rooms/:id/checkpoint', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (!isRoomMember(room, me.id) && room.creator !== me.id) return fail(res, 403, 'membership required');
  const label = ((req.body && req.body.label) || '').toString().slice(0, 200) || null;
  const msgs = store.getShared(roomChatKey(room.id)) || [];
  const head = msgs.length ? msgs[msgs.length - 1] : null;
  const tasks = materializeRoomTasks(room.id);
  const stateDoc = store.getShared(roomStateKey(room.id)) || {};
  const snapshot = {
    room_id: room.id, label, ts: Date.now(), by: me.id,
    chat_head: head ? { id: head.id, ts: head.ts } : null,
    message_count: msgs.length,
    tasks_digest: crypto.createHash('sha256').update(JSON.stringify(tasks)).digest('hex').slice(0, 16),
    state_hash: crypto.createHash('sha256').update(JSON.stringify(stateDoc)).digest('hex').slice(0, 16),
  };
  const entry = await ledger.append('room.checkpoint', snapshot);
  ok(res, { checkpoint: { ...snapshot, ledger_seq: entry.seq, ledger_hash: entry.hash } });
});
app.get('/api/rooms/:id/changes', async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private') {
    const me = await authAgent(req).catch(() => null);
    if (!me || !canReadRoom(room, me.id)) return fail(res, 403, 'private room: membership required');
  }
  const since = parseInt(req.query.since, 10) || 0;
  const all = store.getShared(roomChatKey(room.id)) || [];
  const meta = store.getSharedMaterialMeta(all);
  const msgs = roomRead.messagesSince(all, since, {
    knownSorted: meta && meta.tsSorted === true ? true : null,
  });
  const awaiting_now = materializeRoomAwaiting(room.id);
  ok(res, {
    room_id: room.id, since,
    new_messages: msgs.length,
    messages: msgs.slice(-200),
    awaiting_now,
  });
});

async function findRoomCheckpoint(roomId, checkpointId) {
  const rows = await ledger.byType('room.checkpoint', 500);
  const id = (checkpointId == null ? '' : String(checkpointId));
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i];
    if (!e.data || e.data.room_id !== roomId) continue;
    if (String(e.seq) === id || e.hash === id || (e.data.label && e.data.label === id)
      || String(e.data.ledger_seq || '') === id) return e;
  }
  return null;
}

function roomSliceAt(roomId, cutoffTs) {
  const msgs = (store.getShared(roomChatKey(roomId)) || []).filter((m) => (m.ts || 0) <= cutoffTs);
  const stateDoc = store.getShared(roomStateKey(roomId)) || {};
  // State doc is LWW current — for historical accuracy we only trust chat/tasks cut by ts.
  const tasks = materializeRoomTasks(roomId).filter((t) => (t.created_at || t.ts || 0) <= cutoffTs);
  const awaiting = materializeRoomAwaiting(roomId).filter((m) => (m.ts || 0) <= cutoffTs);
  return { messages: msgs, state: stateDoc, tasks, awaiting, cutoff_ts: cutoffTs };
}

// T7: read-only history slice (does not create a room)
app.get('/api/rooms/:id/at', async (req, res) => {
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private') {
    const me = await authAgent(req).catch(() => null);
    if (!me || !canReadRoom(room, me.id)) return fail(res, 403, 'private room: membership required');
  }
  let cutoff = parseInt(req.query.ts, 10);
  let cp = null;
  if (req.query.checkpoint) {
    cp = await findRoomCheckpoint(room.id, req.query.checkpoint);
    if (!cp) return fail(res, 404, 'checkpoint not found');
    cutoff = cp.data.ts;
  }
  if (!Number.isFinite(cutoff)) return fail(res, 400, 'ts= or checkpoint= required');
  const slice = roomSliceAt(room.id, cutoff);
  ok(res, {
    room_id: room.id, at: cutoff,
    checkpoint: cp ? { seq: cp.seq, hash: cp.hash, label: cp.data.label || null } : null,
    ...slice,
  });
});

// T1: fork a new room from a checkpoint (copy, never rewrite the original)
app.post('/api/rooms/:id/fork', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.visibility === 'private' && !isRoomMember(room, me.id)) return fail(res, 403, 'private room: membership required');
  const { checkpoint_id, name } = req.body || {};
  if (!checkpoint_id) return fail(res, 400, 'checkpoint_id required');
  if (!name || typeof name !== 'string') return fail(res, 400, 'name required');
  const cp = await findRoomCheckpoint(room.id, checkpoint_id);
  if (!cp) return fail(res, 404, 'checkpoint not found');
  const slice = roomSliceAt(room.id, cp.data.ts);
  const forkId = newId('room');
  const now = Date.now();
  await store.putRoom(forkId, {
    id: forkId,
    name: String(name).slice(0, 200),
    description: room.description || '',
    creator: me.id,
    status: 'open',
    home_node: ledger.NODE_ID,
    created_at: now,
    visibility: room.visibility === 'private' ? 'private' : 'public',
    membership_proof_hash: room.membership_proof_hash || null,
    member_ids: Array.from(new Set([me.id, ...(room.member_ids || [])])),
    forked_from: {
      room_id: room.id,
      checkpoint_seq: cp.seq,
      checkpoint_hash: cp.hash,
      checkpoint_ts: cp.data.ts,
    },
  });
  // Seed chat log as plain RGA append of the sliced messages (keep original ids for auditability).
  for (const m of slice.messages) {
    await appendRoomMessage(forkId, { ...m });
  }
  if (slice.state && (slice.state.summary || (slice.state.decisions || []).length)) {
    await store.putShared(roomStateKey(forkId), {
      summary: slice.state.summary || '',
      decisions: slice.state.decisions || [],
      open_questions: slice.state.open_questions || [],
      updated_at: now,
      updated_by: me.id,
    }, now, me.id);
  }
  await ledger.append('room.fork', {
    room: forkId, from_room: room.id, checkpoint_seq: cp.seq, checkpoint_hash: cp.hash,
    by: me.id, ts: now,
  });
  ok(res, {
    room_id: forkId,
    forked_from: { room_id: room.id, checkpoint_id: cp.seq, checkpoint_hash: cp.hash },
    message_count: slice.messages.length,
    ts: now,
  });
});

// ADR-0031: room-as-MCP-server — Streamable HTTP MCP transport scoped to :id.
// Mounted after room helpers (authAgent, isRoomMember, appendRoomMessage, …) exist.
roomMcp.mount(app, {
  authAgent, store, isRoomMember, canReadRoom, roomChatKey, appendRoomMessage,
  newId, ledger, pushTo, ok, fail, materializeRoomAwaiting, MAX_CONTENT_LEN,
});

// ---- 8. Distribute a task to a room (requires auth: room creator) ----
app.post('/api/rooms/:id/tasks', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token required');
  const { task, assignees, input, capability } = req.body || {};
  if (!task || !Array.isArray(assignees) || !assignees.length) return fail(res, 400, 'task and assignees[] required');
  const room = store.getRoom(req.params.id);
  if (!room) return fail(res, 404, 'room not found');
  if (room.creator !== me.id) return fail(res, 403, 'only room creator can assign');
  const ids = [];
  for (const a of assignees) {
    const agent = store.getAgent(a);
    if (!agent) return fail(res, 404, `agent not found: ${a}`);
    // F1: if an `input` is supplied and the assignee declared a structured capability with an
    // input_schema, validate up front so a mismatch fails fast here rather than confusing the
    // assignee later. Only enforced when both the input and a matching schema exist (fully additive).
    if (input !== undefined && capability) {
      const capDef = (agent.capabilities || []).find(c => schema.capName(c) === capability && c && c.input_schema);
      if (capDef) {
        const v = schema.validate(capDef.input_schema, input);
        if (!v.ok) return fail(res, 400, `input schema violation for ${a}/${capability}: ${v.errors.join('; ')}`);
      }
    }
    const tid = newId('task');
    const now = Date.now();
    await appendRoomTaskEvent(req.params.id, {
      id: `tev_${tid}_assign`, kind: 'assign', task_id: tid, task, assignee: a, by: me.id, ts: now,
    });
    // Notify the assignee. This used to write straight into this node's message table and push
    // locally, which silently did nothing useful when the assignee's home node was a DIFFERENT node
    // -- the other half of the same federation gap the task log above just fixed. Route it through
    // the same cross-node relay POST /api/messages uses instead.
    const mid = newId('msg');
    const content = `[room:${req.params.id}] New task: ${task}`;
    const peer = agent.home_node && agent.home_node !== ledger.NODE_ID
      ? PEERS.find(p => p.id === agent.home_node) : null;
    if (peer) {
      relayToPeer(peer, { type: 'message', id: mid, from_agent: '(room)', to_agent: a, content });
    } else {
      stmt.insertMessage.run(mid, '(room)', a, content, 'pending', 0, null, null, null, now);
      pushTo(a, { type: 'message', message: { id: mid, from_agent: '(room)', to_agent: a, content, status: 'pending' } });
      if (agent.webhook_url) deliverWebhook(agent.webhook_url, { event: 'message', id: mid, from_agent: '(room)', to_agent: a, content, ts: now });
    }
    ids.push(tid);
  }
  // Live-update every member's task board, not just the assignee's inbox.
  for (const uid of (room.member_ids || [])) pushTo(uid, { type: 'room_task', room_id: req.params.id });
  ok(res, { task_ids: ids, assigned: assignees.length });
});

// ---- 9b. Agent reports back a task result (requires auth: task assignee) ----
// This used to be registered twice, along with "collaboration receipt anchoring" -- the task.report
// ledger-anchoring code never actually ran (the ledger never had this event type). Merged into one.
app.post('/api/rooms/:id/tasks/:tid/report', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const { result } = req.body || {};
  if (!result) return fail(res, 400, 'result required');
  const task = materializeRoomTasks(req.params.id).find(t => t.id === req.params.tid);
  if (!task) return fail(res, 404, 'task not found');
  if (task.assignee !== me.id) return fail(res, 403, 'only assignee can report');
  const now = Date.now();
  // Event id is scoped by reporter+timestamp, not just the task id, so a re-report is a new event the
  // LWW fold resolves rather than a silent overwrite that would diverge between nodes.
  await appendRoomTaskEvent(req.params.id, {
    id: `tev_${req.params.tid}_report_${me.id}_${now}`, kind: 'report',
    task_id: req.params.tid, result, by: me.id, ts: now,
  });
  ledger.append('task.report', { room: req.params.id, task: req.params.tid, agent: me.id, ts: now }).catch(()=>{});
  const rm = store.getRoom(req.params.id);
  for (const uid of ((rm && rm.member_ids) || [])) pushTo(uid, { type: 'room_task', room_id: req.params.id });
  ok(res, { task_id: req.params.tid, status: 'done' });
});

// ================= MOYE-NET: decentralization layer (P3) =================
// When a recipient publishes p2p multiaddrs, also broadcast messages relayed through this node to the
// IPFS pubsub topic /moye/msg/<to_agent> -- the recipient can subscribe to its own topic to catch up
// after being offline (a decentralized fallback channel; this node isn't the sole delivery path).
function p2pBroadcast(toAgent, payload) {
  try {
    const ipfs = store.ipfs();
    if (ipfs && ipfs.pubsub) ipfs.pubsub.publish('/moye/msg/' + toAgent, Buffer.from(JSON.stringify(payload))).catch(()=>{});
  } catch (e) {}
}
// Query an agent's p2p direct-connect info (lets the SDK decide whether to bypass this node)
app.get('/api/agents/:id/p2p', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  ok(res, { agent_id: req.params.id, p2p_addrs: a.p2p_addrs || null, home_node: a.home_node, deliver_via: a.p2p_addrs ? 'p2p' : 'relay', relay_tier: a.relay_tier || 'unknown', overlay_addr: a.overlay_addr || null });
});

// Anchor a sent message to the ledger
app.post('/api/messages', async (req, res, next) => {
  const _json = res.json.bind(res);
  res.json = (body) => {
    if (body.success && body.message_id) {
      // F3: anchor content_hash so the ledger is a verifiable record of what was sent (not just
      // that something was sent). sha256 of the exact content bytes -- for E2E messages this is the
      // hash of the ciphertext, so the server still never sees plaintext.
      const contentHash = typeof req.body.content === 'string'
        ? crypto.createHash('sha256').update(req.body.content).digest('hex') : null;
      let attachment_cids = null;
      try {
        const atts = attachments.normalizeAttachments(req.body && req.body.attachments);
        if (atts) attachment_cids = atts.map((a) => a.cid);
      } catch { /* validated later in handler */ }
      ledger.append('message.send', {
        id: body.message_id, from: req.body.from_agent, to: req.body.to_agent,
        content_hash: contentHash, attachment_cids, ts: Date.now(),
      }).catch(()=>{});
    }
    return _json(body);
  };
  next();
}, async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.body.from_agent) return fail(res, 403, 'identity mismatch');
  const { from_agent, to_agent, content, encrypted, nonce, force_relay, sender_sig } = req.body;
  if (typeof content === 'string' && content.length > MAX_CONTENT_LEN) return fail(res, 413, 'content too large');
  let atts;
  try { atts = attachments.normalizeAttachments(req.body && req.body.attachments); }
  catch (e) { return fail(res, e.status || 400, e.message); }
  const attJson = atts ? JSON.stringify(atts) : null;
  const rec0 = store.getAgent(to_agent);
  if (!rec0) return fail(res, 404, 'recipient agent not found');
  const isEnc = encrypted ? 1 : 0;
  // P3: decentralization first -- if the recipient publishes p2p multiaddrs, point the SDK at a direct
  // connection instead of relaying through this node.
  // force_relay: this used to unconditionally tell any p2p_addrs-registered recipient "go connect
  // directly yourself", even if their p2p node happened to be offline at that moment -- if the SDK's
  // direct-connect attempt failed, falling back to HTTP would get blocked by this same check again,
  // and the message could never get delivered at all. The SDK now retries with force_relay:true after
  // a failed direct attempt, and this lets it through to the normal store/forward path below.
  if (rec0.p2p_addrs && !force_relay && (!rec0.home_node || rec0.home_node === ledger.NODE_ID)) {
    return ok(res, {
      message_id: null, status: 'deliver-via-p2p',
      deliver_via: 'p2p', p2p_addrs: rec0.p2p_addrs, to_agent,
      note: 'recipient supports libp2p; send directly to avoid server relay'
    });
  }
  // When relaying for an external agent (not owned by this node), don't pile its messages into this
  // node's own storage -- this node only routes/forwards, so it doesn't become a de facto central
  // store for other nodes' agents (in keeping with "this node is just an origin point")
  const sender = store.getAgent(from_agent);
  const senderLocal = sender && sender.home_node === ledger.NODE_ID;
  if (!senderLocal) {
    // External sender: don't persist here. Relay straight to the recipient's home node;
    // if the recipient is on this node, deliver locally + webhook only.
    if (rec0.home_node && rec0.home_node !== ledger.NODE_ID) {
      const peer = PEERS.find(p => p.id === rec0.home_node);
      if (peer) {
        relayToPeer(peer, { type: 'message', id: newId('msg'), from_agent, to_agent, content, encrypted: isEnc, nonce: nonce || null, sender_sig: sender_sig || null });
        return ok(res, { message_id: null, status: 'relayed', relayed_to: rec0.home_node, note: 'external sender: not stored locally' });
      }
    }
    // Recipient is on this node: local push + webhook only, don't write to this node's message table
    const eid = newId('msg');
    pushTo(to_agent, { type: 'message', message: { id: eid, from_agent, to_agent, content, status: 'pending', encrypted: isEnc, attachments: atts } });
    if (!isEnc && rec0.webhook_url) deliverWebhook(rec0.webhook_url, { event: 'message', id: eid, from_agent, to_agent, content, attachments: atts, ts: Date.now() });
    return ok(res, { message_id: eid, status: 'delivered-local', note: 'external sender: not stored locally' });
  }
  const id = newId('msg');
  stmt.insertMessage.run(id, from_agent, to_agent, content, 'pending', isEnc, nonce || null, sender_sig || null, attJson, Date.now());
  // Cross-node relay: recipient's home node isn't this one -> forward it there for delivery
  if (rec0.home_node && rec0.home_node !== ledger.NODE_ID) {
    const peer = PEERS.find(p => p.id === rec0.home_node);
    if (peer) {
      relayToPeer(peer, { type: 'message', id, from_agent, to_agent, content, encrypted: isEnc, nonce: nonce || null, sender_sig: sender_sig || null, attachments: atts });
      return ok(res, { message_id: id, status: 'relayed', relayed_to: rec0.home_node });
    }
  }
  pushTo(to_agent, { type: 'message', message: { id, from_agent, to_agent, content, status: 'pending', encrypted: isEnc, sender_sig: sender_sig || null, attachments: atts } });
  // Webhook bridge: if the recipient registered a webhook_url, push asynchronously (the key to zero-SDK onboarding)
  if (!isEnc && rec0.webhook_url) {
    deliverWebhook(rec0.webhook_url, { event: 'message', id, from_agent, to_agent, content, attachments: atts, ts: Date.now() });
  }
  // P3 decentralized fallback: broadcast to the recipient's pubsub topic so subscribers can catch up after being offline
  p2pBroadcast(to_agent, { type: 'message', id, from_agent, to_agent, content, encrypted: isEnc, attachments: atts, ts: Date.now() });
  ok(res, { message_id: id, status: 'pending', encrypted: isEnc, attachments: atts });
});

// ================= Webhook bridge (zero-SDK onboarding) ================
// Any runtime that can receive an HTTP POST (Hermes / OpenClaw / n8n / Zapier) can connect directly:
//   1) Register once: POST /api/bridge/register {name, webhook_url, capabilities}
//      -> returns agent_id + bridge_token (save it in your own config, use it to send messages)
//   2) Receive messages: moye-net actively POSTs to webhook_url (plaintext, not an encrypted channel)
//   3) Send messages: POST /api/bridge/send {from, to, content} (with X-Bridge-Token)
// No SDK, no crypto implementation, no polling required anywhere in this flow.

app.post('/api/bridge/register', async (req, res) => {
  const { name, webhook_url, capabilities, description, enc_pubkey } = req.body || {};
  if (!name) return fail(res, 400, 'name required');
  // SSRF guard (see webhookUrlSafe): blocks loopback/private/link-local + non-http(s) targets
  if (webhook_url) { const v = await webhookUrlSafe(webhook_url); if (!v.ok) return fail(res, 400, 'invalid webhook_url: ' + v.reason); }
  const id = newId('ag');
  const token = newToken();
  stmt.insertAgent.run(id, name, hashToken(token), ledger.NODE_ID, Date.now());
  await store.putAgent(id, {
    id, name, description: description || '', capabilities: capabilities || [], endpoint: webhook_url || '',
    owner: '', pubkey: null, did: null, enc_pubkey: enc_pubkey || null,
    webhook_url: webhook_url || null, home_node: ledger.NODE_ID, created_at: Date.now()
  });
  if (PEERS.length) announceToPeers({ id, name, description: description || '', capabilities: capabilities || [], endpoint: webhook_url || '', owner: '', did: null, home_node: ledger.NODE_ID, created_at: Date.now() });
  await ledger.append('agent.register', { id, name, bridge: true, ts: Date.now() });
  ok(res, { agent_id: id, bridge_token: token, webhook_url: webhook_url || null,
            note: 'Save bridge_token and use it to call /api/bridge/send; messages sent to this agent will be POSTed to webhook_url' });
});

// Needs a SQLite lookup: this used to incorrectly look for a .token field on the IPFS directory object,
// which was never written there, so /api/bridge/send always returned 401 for any bridge_token --
// bridge sending never actually worked before this fix.
app.post('/api/bridge/send', async (req, res) => {
  const token = (req.headers['x-bridge-token'] || '').toString();
  if (!token) return fail(res, 401, 'X-Bridge-Token required');
  const row = stmt.agentByTokenHash.get(hashToken(token));
  if (!row) return fail(res, 401, 'invalid bridge token');
  const me = { id: row.id, name: row.name };
  const { to, content, encrypted } = req.body || {};
  if (!to || !content) return fail(res, 400, 'to and content required');
  if (typeof content === 'string' && content.length > MAX_CONTENT_LEN) return fail(res, 413, 'content too large');
  const rec0 = store.getAgent(to);
  if (!rec0) return fail(res, 404, 'recipient not found');
  const id = newId('msg');
  const isEnc = encrypted ? 1 : 0;
  stmt.insertMessage.run(id, me.id, to, content, 'pending', isEnc, null, null, null, Date.now());
  // Cross-node relay
  if (rec0.home_node && rec0.home_node !== ledger.NODE_ID) {
    const peer = PEERS.find(p => p.id === rec0.home_node);
    if (peer) { relayToPeer(peer, { type: 'message', id, from_agent: me.id, to_agent: to, content, encrypted: isEnc }); return ok(res, { message_id: id, status: 'relayed', relayed_to: rec0.home_node }); }
  }
  pushTo(to, { type: 'message', message: { id, from_agent: me.id, to_agent: to, content, status: 'pending', encrypted: isEnc } });
  // If the recipient also has a webhook, forward there too (bridges across runtimes)
  if (rec0.webhook_url && !isEnc) deliverWebhook(rec0.webhook_url, { event: 'message', id, from_agent: me.id, to_agent: to, content, ts: Date.now() });
  ledger.append('message.send', { id, from: me.id, to, ts: Date.now() }).catch(()=>{});
  ok(res, { message_id: id, status: 'pending', encrypted: isEnc });
});

// Shared intent: intents/declarations anchored to the ledger (visible network-wide)
app.post('/api/shared-intent', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const { intent, scope } = req.body || {};
  if (!intent) return fail(res, 400, 'intent required');
  const r = await ledger.append('shared.intent', { agent: me.id, intent, scope: scope || 'global', ts: Date.now() });
  ok(res, { seq: r.hash, type: 'shared.intent' });
});

// ---- Ledger queries ----
// ---- ADR-0013 firehose: live ledger-derived event stream (SSE + NDJSON) ----
// Public, metadata-only (same fields the ledger already exposes). Agents subscribe instead of
// polling; /stream renders the same feed as a digital-rain visualization; L2 indexers (ADR-0012)
// will also consume this. Light nodes: ENABLE_FIREHOSE=0. Capacity: FIREHOSE_MAX_CLIENTS (default 32).
app.get('/api/stream', (req, res) => {
  const result = firehose.subscribe(res, { format: 'sse', query: req.query });
  if (!result.ok) {
    if (result.reason === 'disabled') return fail(res, 404, 'firehose disabled on this node (ENABLE_FIREHOSE=0)');
    return fail(res, 503, `firehose at capacity (max ${firehose.info().max_clients})`);
  }
  // Intentionally do not call res.end() — the connection stays open until the client disconnects.
});
app.get('/api/stream.ndjson', (req, res) => {
  const result = firehose.subscribe(res, { format: 'ndjson', query: req.query });
  if (!result.ok) {
    if (result.reason === 'disabled') return fail(res, 404, 'firehose disabled on this node (ENABLE_FIREHOSE=0)');
    return fail(res, 503, `firehose at capacity (max ${firehose.info().max_clients})`);
  }
});
app.get('/api/stream/info', (req, res) => {
  ok(res, firehose.info());
});

// ---- N1 / ADR-0021: attachments are reference-only — MOYE nodes do not store/pin bytes.
// POST/GET /api/blobs removed. Clients upload elsewhere and put {cid,sha256,...} on messages.

// ---- P2-4 + T6 search: capability/text match, then gravity-rank by reputation mass ----
function reputationScore(agentId) {
  const rep = store.getShared('reputation:' + agentId);
  return (rep && typeof rep.score === 'number') ? rep.score : 0;
}
function endorsementNeighbors(didOrId) {
  const out = new Set();
  const list = (didOrId && store.getShared(vcKey(didOrId))) || [];
  if (!Array.isArray(list)) return out;
  for (const vc of list) {
    // T4/T6: identity-delegation does not transfer reputation mass — only explicit endorsements do.
    if (!vc || !vc.issuer || !vcVerify(vc)) continue;
    if (vc.claim && (vc.claim.type === 'identity-delegation' || vc.claim.type === 'identity-delegation-revoke')) continue;
    out.add(vc.issuer);
  }
  return out;
}
function gravityScore(agent) {
  // Per-agent score only — never roll up instance reputation into the root (T4).
  const mass = Math.max(0, reputationScore(agent.id));
  let pull = mass;
  for (const issuerDid of endorsementNeighbors(agent.did || agent.id)) {
    const issuer = store.getAgentByDid(issuerDid) || store.getAgent(issuerDid);
    if (!issuer) continue;
    if (sameIdentityFamily(agent.id, issuer.id)) continue;
    pull += Math.max(0, reputationScore(issuer.id)) / 4;
  }
  return pull;
}

app.post('/api/search', async (req, res) => {
  const body = req.body || {};
  const q = (body.q || '').toString().trim().toLowerCase();
  const capability = (body.capability || '').toString().trim();
  const limit = Math.min(parseInt(body.limit, 10) || 50, 200);
  let agents = capability ? store.listAgentsByCapability(capability) : store.listAgents(q || '');
  if (q && capability) {
    agents = agents.filter((a) => {
      const hay = `${a.name || ''} ${a.description || ''} ${(a.capabilities || []).map(schema.capName).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }
  const minRep = body.min_reputation != null ? Number(body.min_reputation) : null;
  if (minRep != null && Number.isFinite(minRep)) {
    agents = agents.filter((a) => reputationScore(a.id) >= minRep);
  }
  const claimType = (body.claim_type || '').toString().trim();
  if (claimType) {
    const creds = await ledger.byType('credential.issue', 500).catch(() => []);
    const subjects = new Set(creds.filter((e) => e.data && e.data.claim && e.data.claim.type === claimType).map((e) => e.data.subject));
    agents = agents.filter((a) => subjects.has(a.did) || subjects.has(a.id));
  }
  agents = agents
    .map((a) => ({ a, g: gravityScore(a) }))
    .sort((x, y) => (y.g - x.g) || (x.a.id < y.a.id ? -1 : 1))
    .map(({ a, g }) => ({
      id: a.id, name: a.name, did: a.did || null, capabilities: a.capabilities || [],
      description: a.description || '', home_node: a.home_node || null,
      gravity: g, reputation: reputationScore(a.id),
    }));
  ok(res, { total: agents.length, agents: agents.slice(0, limit) });
});

// ---- ADR-0013 verb table (machine-readable; ⌘K / CLI / MCP project from this) ----
app.get('/api/verbs', (req, res) => {
  ok(res, { verbs: verbs.list() });
});

app.get('/api/ledger/verify', async (req, res) => {
  const v = await ledger.verify();
  ok(res, v);
});
// ---- Chain anchoring ----
app.get('/api/ledger/root', async (req, res) => {
  const merkle = await ledger.root();
  const head = await ledger.tail(1);
  ok(res, { merkle_root: merkle, height: head.length ? head[0].seq : 0 });
});
app.get('/api/ledger/anchors', async (req, res) => {
  const rows = stmt.listAnchors.all(50);
  ok(res, { anchors: rows });
});
// Requires auth: this used to be completely open, letting anyone trigger a real Arweave anchoring
// transaction with no credentials at all (real funds move once a wallet is configured), or stuff
// completely fabricated chain/tx_hash values into the anchors table, polluting what's supposed to be
// a trustworthy anchoring audit record.
app.post('/api/ledger/anchor', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  const { chain, tx_hash, merkle_root } = req.body || {};
  if (!chain) return fail(res, 400, 'chain required (e.g. "ipfs" or "arweave")');
  // Free path: anchor to local IPFS (immutable, self-hosted)
  if (chain === 'ipfs') {
    try { const r = await ledger.anchorToIpfs(); return ok(res, r); }
    catch (e) { return fail(res, 500, 'ipfs anchor failed: ' + e.message); }
  }
  // Permanent anchoring to Arweave (requires an AR wallet configured on this node; errors clearly if absent)
  if (chain === 'arweave') {
    try { const r = await ledger.anchorToArweave(); return ok(res, r); }
    catch (e) { return fail(res, 502, 'arweave anchor failed: ' + e.message); }
  }
  // External chain path: caller must have already anchored on-chain and pass tx_hash
  if (!tx_hash) return fail(res, 400, 'tx_hash required for chain=' + chain);
  const r = await ledger.anchor(chain, tx_hash, merkle_root || (await ledger.root()));
  ok(res, r);
});
app.get('/api/ledger/:type', async (req, res) => {
  const rows = await ledger.byType(req.params.type, Math.min(parseInt(req.query.limit) || 50, 200));
  ok(res, { type: req.params.type, entries: rows });
});
app.get('/api/ledger', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = await ledger.tail(limit);
  ok(res, { height: rows.length, entries: rows });
});

// ADR-0006 workstream B: distribution independence. Points at the most recent self-published
// source-code release (see scripts/publish-source.js) so anyone -- including a node bootstrapping
// itself for the first time -- can recover the exact source tree off THIS network's own IPFS/Arweave
// storage, independent of GitHub or any single git-hosting platform being reachable.
app.get('/api/source/latest', async (req, res) => {
  const rel = await ledger.latestSourceRelease();
  if (!rel) return fail(res, 404, 'no source release recorded yet (run scripts/publish-source.js)');
  const { tarball_cid, sha256, git_commit, version, size_bytes, arweave_tx, ts } = rel.data;
  ok(res, {
    tarball_cid, sha256, git_commit, version, size_bytes, arweave_tx, published_at: ts,
    recover: `ipfs cat ${tarball_cid} > moye-source.tar.gz && sha256sum moye-source.tar.gz  # must equal ${sha256}`,
    arweave_url: arweave_tx ? `https://arweave.net/${arweave_tx}` : null,
  });
});

// ---- Federation handshake (bidirectional reconcile) ----
// Node registration (other MOYE nodes joining the network)
// Requires FED_SECRET: otherwise anyone could claim to be a "node" and inject entries into
// federation_nodes, letting /api/federation/sync merge forged records into the global directory
// as if they legitimately belonged to that node
app.post('/api/federation/nodes', async (req, res) => {
  const auth = federationAuthorized(req);
  if (!auth.ok) return fail(res, 401, 'invalid federation auth: ' + (auth.reason || 'secret or node-did required'));
  const { id, name, endpoint, pubkey, num_shards, served_shards, protocol_version, features } = req.body || {};
  if (!id || !endpoint) return fail(res, 400, 'id and endpoint required');
  // ADR-0008: a peer announces its own shard configuration here so this node can later give
  // "try this peer" redirect hints for agents it doesn't have locally (see GET /api/agents/:id).
  // ADR-0009: a peer also announces its protocol_version/features, feeding GET /api/protocol/adoption
  // -- observable adoption data for protocol evolution, not an activation trigger (see that ADR).
  // NULL/absent (older peer, or a field genuinely unused) is a valid, expected value -- "unknown".
  stmt.upsertFederationNode.run(id, name || '', endpoint, pubkey || null, Date.now(),
    Number.isFinite(num_shards) ? num_shards : null, served_shards ? JSON.stringify(served_shards) : null,
    Array.isArray(features) ? JSON.stringify(features) : null, protocol_version || null);
  ok(res, { node_id: id, auth_mode: auth.mode });
});

// ---- Federation relay delivery: receive a message forwarded by a peer node, store and deliver it locally ----
app.post('/api/federation/deliver', async (req, res) => {
  const auth = federationAuthorized(req);
  if (!auth.ok) return fail(res, 401, 'invalid federation auth: ' + (auth.reason || 'secret or node-did required'));
  const { node, type, id, from_agent, to_agent, content, encrypted, nonce, sender_sig, attachments: attIn } = req.body || {};
  if (type !== 'message' || !to_agent) return fail(res, 400, 'invalid deliver payload');
  // Only deliver to recipients owned by this node
  const rec = store.getAgent(to_agent);
  if (!rec) return fail(res, 404, 'recipient not here');
  if (rec.home_node !== ledger.NODE_ID) return fail(res, 403, 'not my agent');
  const isEnc = encrypted ? 1 : 0;
  let atts = null;
  try { atts = attachments.normalizeAttachments(attIn); } catch { atts = null; }
  const attJson = atts ? JSON.stringify(atts) : null;
  // F3: carry sender_sig across the relay so the recipient can still verify the original sender,
  // even though this message reached them via a peer node (which is exactly the hop that used to be
  // spoofable). The recipient verifies locally against from_agent's pubkey -- it doesn't trust us.
  stmt.insertMessageIfNew.run(id, from_agent, to_agent, content, 'pending', isEnc, nonce || null, sender_sig || null, attJson, Date.now());
  pushTo(to_agent, { type: 'message', message: { id, from_agent, to_agent, content, status: 'pending', encrypted: isEnc, sender_sig: sender_sig || null, attachments: atts } });
  if (!isEnc && rec.webhook_url) deliverWebhook(rec.webhook_url, { event: 'message', id, from_agent, to_agent, content, attachments: atts, ts: Date.now() });
  ledger.append('message.deliver', { id, from: from_agent, to: to_agent, via: node || null, ts: Date.now() }).catch(()=>{});
  ok(res, { delivered: true, auth_mode: auth.mode });
});

// Bidirectional sync: pull what's owned locally, and merge in whatever the peer pushed
// Request body may include { since_ts, remote_agents, remote_rooms } -> merged into local IPFS state
// Requires FED_SECRET: this used to have no auth at all, so any public caller could POST forged
// agent/room records straight into the global directory (the directory is broadcast to every node
// via IPFS pubsub, making this the single biggest open injection surface, hence the auth requirement)
app.post('/api/federation/sync', async (req, res) => {
  const auth = federationAuthorized(req);
  if (!auth.ok) return fail(res, 401, 'invalid federation auth: ' + (auth.reason || 'secret or node-did required'));
  const body = req.body || {};
  const since = parseInt(body.since_ts) || 0;
  if (body.tombstones) store.mergeTombstones(body.tombstones);
  // 1) Merge records pushed by the peer (only accept ones owned by that peer, to avoid loops).
  // Tombstone check matters here too: without it, a peer that hasn't learned about a local
  // deletion yet would keep pushing the deleted record back on every reconcile cycle forever.
  let merged = 0;
  if (Array.isArray(body.remote_agents)) {
    for (const a of body.remote_agents) {
      if (!a.id || !a.home_node || a.home_node === ledger.NODE_ID) continue;
      // ADR-0008: peers push everything they own; this node decides what to keep based on its own
      // shard responsibility (a no-op filter when sharding is disabled, NUM_SHARDS=1 default).
      if (!shard.isResponsibleFor(a.id)) continue;
      // P3-6: lamport+home_node LWW (was insert-only — stale incomplete copies stuck forever).
      if (store.isTombstoned('agents', a.id)) continue;
      const cur = store.getAgent(a.id);
      if (!store.agentLwwWins(a, cur)) continue;
      await store.putAgent(a.id, a, { preserveLamport: true }); merged++;
    }
  }
  if (Array.isArray(body.remote_rooms)) {
    for (const r of body.remote_rooms) {
      if (!r.id || !r.home_node || r.home_node === ledger.NODE_ID) continue;
      if (!store.getRoom(r.id) && !store.isTombstoned('rooms', r.id)) { await store.putRoom(r.id, r); merged++; }
    }
  }
  // Shared state (room chat/task logs, reputation, VCs) -- see sharedSince/mergeRemoteShared.
  merged += await mergeRemoteShared(body.remote_shared);
  // 2) Return local increments since since_ts (including ones owned by this node)
  // P3-6: return agents whose lamport advanced since `since`, not only brand-new created_at.
  const agents = Object.entries(store._raw().agents)
    .filter(([, v]) => store.agentLamport(v) > since)
    .map(([id, v]) => ({ id, ...v }));
  const rooms = Object.entries(store._raw().rooms)
    .filter(([, v]) => (v.created_at || 0) > since)
    .map(([id, v]) => ({ id, ...v }));
  const head = await ledger.tail(1);
  ok(res, {
    node: ledger.NODE_ID,
    merged_remote: merged,
    since_ts: since,
    agents, rooms,
    shared: sharedSince(since),
    tombstones: store.getTombstones(),
    ledger_height: head.length ? head[0].seq : 0,
    ts: Date.now(),
  });
});

// Legacy pull-only compatibility (read-only)
app.get('/api/federation/sync', async (req, res) => {
  const agents = Object.entries(store._raw().agents).map(([id, v]) => ({ id, ...v }));
  const rooms = Object.entries(store._raw().rooms).map(([id, v]) => ({ id, ...v }));
  const head = await ledger.tail(1);
  ok(res, { node: ledger.NODE_ID, agents, rooms, ledger_height: head.length ? head[0].seq : 0, ts: Date.now() });
});

// ================= n4: dashboard aggregation endpoint =================
// This node acts as the monitor: reads IPFS shared state (decentralized, network-wide) and probes health of every known node
app.get('/api/dashboard', async (req, res) => {
  // 1) Global shared state (from IPFS, consistent across nodes)
  const agents = Object.entries(store._raw().agents).map(([id, v]) => ({ id, ...v }));
  // SECURITY FIX (2026-07-24, found via code review while extending this endpoint): this used to
  // dump every room's RAW object with zero auth and zero filtering -- leaking membership_proof_hash
  // for every private room, and completely bypassing the private-room visibility rule that
  // GET /api/rooms already enforces correctly. Applying the identical rule here: best-effort auth,
  // private rooms only included if the caller is a member, membership_proof_hash always stripped.
  // Scenario 1 (audit view): also attaches a per-room message count from the room chat log (the
  // count itself, not content -- an aggregate stat, safe to show alongside the same visibility rule).
  const dashMe = await authAgent(req).catch(() => null);
  const rooms = Object.entries(store._raw().rooms)
    .map(([id, v]) => ({ id, ...v }))
    .filter(r => r.visibility !== 'private' || (dashMe && isRoomMember(r, dashMe.id)))
    .map(({ membership_proof_hash, ...r }) => ({ ...r, message_count: (store.getShared(roomChatKey(r.id)) || []).length }));
  const shared = store.allShared();
  // 2) Health probe for each known node (this node + PEERS)
  const nodes = [{ id: ledger.NODE_ID, endpoint: process.env.PUBLIC_ENDPOINT || `http://localhost:${PORT}` }];
  for (const p of PEERS) nodes.push({ id: p.id, endpoint: p.endpoint });
  const health = {};
  await Promise.all(nodes.map(async (n) => {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(n.endpoint + '/health', { signal: ctrl.signal });
      clearTimeout(to);
      const j = await r.json();
      health[n.id] = { ok: true, node: j.node, ws: j.ws, ts: Date.now() };
    } catch (e) { health[n.id] = { ok: false, error: e.message, ts: Date.now() }; }
  }));
  // 3) Ledger + anchoring
  const merkle = await ledger.root();
  const head = await ledger.tail(1);
  const anchors = stmt.listAnchors.all(10);
  // 4) Local ledger height (strongly consistent)
  const cnt = stmt.ledgerCount.get();
  ok(res, {
    generated_at: Date.now(),
    this_node: ledger.NODE_ID,
    ipfs_root_cid: store._rootCid(),
    totals: { agents: agents.length, rooms: rooms.length, shared_keys: Object.keys(shared).length, ledger_entries: cnt.n },
    nodes: health,
    agents, rooms, shared,
    ledger: { merkle_root: merkle, height: cnt.n, anchors },
  });
});

app.get('/health', async (req, res) => ok(res, { service: 'moye-a2a', stage: 4, net: 'moye-net', node: ledger.NODE_ID, ws: '/ws' }));

// ADR-0006 workstream D: bootstrap independence. BOOTSTRAP_SEEDS lets an operator hard-code
// additional entry points (other domains, bare IPs, other nodes' multiaddrs) that don't depend on
// this node's own PUBLIC_ENDPOINT or any single domain like moye.ai -- a new node/agent that can
// reach ANY one of them can still discover the rest of the network even if moye.ai itself is
// unreachable (DNS seizure, registrar action, etc). Format matches PEERS: "id=endpoint id2=endpoint2".
const BOOTSTRAP_SEEDS = (process.env.BOOTSTRAP_SEEDS || '')
  .split(/\s+/).filter(Boolean)
  .map(s => { const [id, endpoint] = s.split('='); return { id, endpoint }; });
function allSeeds() {
  const seeds = [{ id: ledger.NODE_ID, endpoint: process.env.PUBLIC_ENDPOINT || `http://localhost:${PORT}` }];
  const seen = new Set([ledger.NODE_ID]);
  for (const p of [...PEERS, ...BOOTSTRAP_SEEDS]) if (!seen.has(p.id)) { seeds.push(p); seen.add(p.id); }
  return seeds;
}
// This node's own identity, standalone (previously only embedded inline in federation-node
// registration calls) -- a client fetching /api/bootstrap/seeds from several independent nodes can
// fetch each one's pubkey here and verify that node's seeds-list signature, without trusting any
// single node's claim about the network's shape.
app.get('/api/node/identity', async (req, res) => {
  ok(res, { node_id: nodeIdentity.nodeId, did: nodeIdentity.did, pubkey: nodeIdentity.publicKey });
});
// Signed bootstrap seeds list: a self-attested (not multi-sig) pointer to known entry points, so a
// new node/agent isn't limited to hard-coded PUBLIC_ENDPOINT/BOOTSTRAP_SEEDS -- it can ask several
// independent seeds for their view and cross-check the signatures, rather than trusting one domain.
app.get('/api/bootstrap/seeds', async (req, res) => {
  const seeds = allSeeds();
  const payload = JSON.stringify(seeds);
  ok(res, { node_id: ledger.NODE_ID, seeds, signed_at: Date.now(), sig: nodeIdentity.sign(payload) });
});

// ================= ADR-0005 direction 5 + ADR-0010: Agent Card interop (Google A2A protocol) ======
// Discovery (agentToCard/agent-card) lets any A2A-aware client find a MOYE agent's capabilities
// without first learning the MOYE protocol. The card's `url` now points at a real per-agent JSON-RPC
// endpoint (below) that bridges a practical subset of A2A's task-invocation model onto MOYE's
// existing inbox/message queue -- see the endpoint's own comment for exactly what's implemented and
// what isn't (no streaming, no full auth-scheme negotiation). Card shape follows A2A's published
// Agent Card structure; not tested against a real external A2A client, see the ADR's honest-limitations note.
function capabilityToSkill(cap) {
  const name = schema.capName(cap);
  const structured = cap && typeof cap === 'object';
  const skill = {
    id: name, name,
    description: (structured && cap.description) || '',
    tags: [name, ...(structured && Array.isArray(cap.tags) ? cap.tags : [])],
    inputModes: structured && cap.input_schema ? ['application/json'] : ['text/plain'],
    outputModes: structured && cap.output_schema ? ['application/json'] : ['text/plain'],
  };
  // A structured capability already carries machine-readable schemas -- surface them on the skill so
  // a caller can validate a payload BEFORE dispatching, instead of discovering the contract from a
  // rejection. GET /api/agents?capability=X&input=a,b filters on exactly these.
  if (structured && cap.input_schema) skill.inputSchema = cap.input_schema;
  if (structured && cap.output_schema) skill.outputSchema = cap.output_schema;
  if (structured && Array.isArray(cap.examples)) skill.examples = cap.examples;
  return skill;
}

// Every way this agent can actually be reached, ranked. A MOYE agent is genuinely multi-transport
// (HTTP now, libp2p direct, Yggdrasil overlay, offline pubsub catch-up), and a card that mentions
// only the HTTP URL hides most of what the network can do -- so each live transport is declared with
// the address that actually works for it.
function agentInterfaces(a, endpoint) {
  const list = [{ transport: 'JSONRPC', url: `${endpoint}/api/agents/${a.id}/a2a`, preferred: true }];
  list.push({ transport: 'HTTP+JSON', url: `${endpoint}/api/messages`, note: 'native MOYE message send' });
  if (Array.isArray(a.p2p_addrs) && a.p2p_addrs.length) {
    list.push({ transport: 'libp2p', addrs: a.p2p_addrs, relay_tier: a.relay_tier || 'unknown',
      note: 'direct/relayed p2p; content is Noise-encrypted end to end' });
  }
  if (a.overlay_addr) {
    list.push({ transport: 'yggdrasil', address: a.overlay_addr,
      note: 'public-key-derived IPv6 overlay; reachable without DNS' });
  }
  if (a.webhook_url) list.push({ transport: 'webhook', push: true, note: 'node pushes inbound messages to a registered URL' });
  list.push({ transport: 'ipfs-pubsub', topic: `/moye/msg/${a.id}`, note: 'offline catch-up channel' });
  return list;
}

// The trust block. This is the part a directory listing can't fake: reputation and credentials are
// summarized WITH the evidence needed to re-derive them independently, and every credential is
// re-verified against its issuer's signature at read time rather than trusted from storage.
function agentTrust(a) {
  const r = store.getShared(repKey(a.id));
  const vcs = (a.did && store.getShared(vcKey(a.did))) || [];
  const verified = (Array.isArray(vcs) ? vcs : []).filter(vcVerify);
  const byType = {};
  for (const vc of verified) {
    const t = (vc.claim && vc.claim.type) || 'credential';
    byType[t] = (byType[t] || 0) + 1;
  }
  return {
    reputation: r ? r.score : 0,
    reputation_updated_at: r ? r.updated_at : null,
    verified_credentials: verified.length,
    credentials_by_type: byType,
    issuers: [...new Set(verified.map(vc => vc.issuer).filter(Boolean))].slice(0, 20),
    revoked: !!(store.getShared('revoke:' + a.id) || {}).revoked,
    // Everything above is independently checkable -- these are the exact endpoints to do it with,
    // so "trust us" never has to be part of reading this card.
    verify_with: {
      credentials: `/api/agents/${a.id}/credentials`,
      reputation: `/api/agents/${a.id}/reputation`,
      address_attestations: `/api/agents/${a.id}/resolve`,
      ledger_integrity: '/api/ledger/verify',
      pubkey: `/api/agents/${a.id}/pubkey`,
    },
  };
}

function agentToCard(a, { extended = true } = {}) {
  const endpoint = process.env.PUBLIC_ENDPOINT || `http://localhost:${PORT}`;
  const interfaces = agentInterfaces(a, endpoint);
  const card = {
    protocolVersion: '0.3.0',           // A2A card schema version this shape targets
    name: a.name,
    description: a.description || '',
    url: `${endpoint}/api/agents/${a.id}/a2a`,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: interfaces.slice(1),
    version: '1.0',
    documentationUrl: `${endpoint.replace(/\/a2a$/, '')}/docs`,
    provider: {
      organization: a.owner || `moye-net node ${a.home_node || ledger.NODE_ID}`,
      url: endpoint,
    },
    capabilities: {
      streaming: true,                  // ADR-0030: tasks/resubscribe + GET .../a2a/stream
      pushNotifications: !!a.webhook_url,
      stateTransitionHistory: true,     // room task events + ledger give a real audit trail
      extensions: PROTOCOL_FEATURES.map(f => ({ uri: `https://moye.ai/ext/${f}`, required: false })),
    },
    // A2A's modern shape is securitySchemes+security. MOYE's DID signature isn't one of A2A's
    // standard schemes, so it's declared as an explicit custom scheme rather than mislabeled as
    // something a client would then use incorrectly.
    securitySchemes: {
      moyeDidSignature: {
        type: 'custom', scheme: 'moye-did-signature',
        description: 'Ed25519 signature over the exact JSON body (POST) or over {method,path,ts} (GET). did:moye:<sha256(spki)[:32]>.',
        headers: ['X-Moye-Did', 'X-Moye-Sig', 'X-Moye-Ts', 'X-Moye-Session'],
      },
      moyeBearer: { type: 'http', scheme: 'bearer', description: 'Node-issued token; not portable across devices -- prefer moyeDidSignature.' },
    },
    security: [{ moyeDidSignature: [] }, { moyeBearer: [] }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: (a.capabilities || []).map(capabilityToSkill),
    supportsAuthenticatedExtendedCard: false,
  };
  if (!extended) return card;

  // MOYE-native block. Namespaced so a strict A2A client can ignore it wholesale, while a MOYE-aware
  // one gets identity, trust and every reachable transport without a second round-trip.
  card['x-moye'] = {
    agent_id: a.id,
    did: a.did || null,
    home_node: a.home_node || ledger.NODE_ID,
    created_at: a.created_at || null,
    interfaces,
    trust: agentTrust(a),
    discovery: {
      by_did: a.did ? `/api/agents/by-did/${a.did}` : null,
      dht: a.did ? `/api/dht/resolve-did/${a.did}` : null,
      resolve: `/api/agents/${a.id}/resolve`,
      note: 'by_did is this node\'s local index; dht asks the network which nodes know this DID, so the agent stays findable without DNS or a central directory.',
    },
    principles: {
      monetization: 'none',
      note: 'MOYE is a commons: contribution is surfaced as reputation and verifiable credentials only. There is no token and no payment path, permanently.',
    },
  };
  return card;
}

// A card is only worth as much as your ability to check it wasn't rewritten in transit by whoever
// served it. The node signs the exact card bytes with its own Ed25519 node identity, so a consumer
// can verify against the node's published pubkey (/api/node/identity) before trusting anything here.
// This is a NODE attestation ("this node served exactly this card"), deliberately NOT a claim that
// the agent itself signed it -- the node never holds an agent's private key.
function signCard(card) {
  const canonical = JSON.stringify(card);
  return {
    ...card,
    signatures: [{
      protected: { alg: 'EdDSA', kid: nodeIdentity.did, node: ledger.NODE_ID },
      signature: nodeIdentity.sign(canonical),
      canonicalization: 'JSON.stringify of this object with the `signatures` field absent',
      verify_with: '/api/node/identity',
    }],
  };
}

app.get('/api/agents/:id/agent-card', async (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return fail(res, 404, 'agent not found');
  const card = agentToCard(a, { extended: req.query.plain !== '1' });
  // raw A2A shape at the top level, not the {success:true,...} envelope -- external A2A clients
  // expect the card itself. ?plain=1 drops the MOYE extension + signature for strict-A2A consumers.
  res.json(req.query.plain === '1' ? card : signCard(card));
});

// ---- ADR-0010 + ADR-0030: A2A JSON-RPC invocation bridge ----
// Beyond discovery: lets a real external A2A client submit work to a MOYE agent and poll for the
// result, using MOYE's existing async inbox/message pattern as the queue -- deliberately NOT
// synchronous invocation. MOYE agents are pull-based by design (an agent might be offline and catch
// up later); forcing a live request/response round-trip here would break that model for every agent,
// not just A2A callers. Implements a practical subset of the A2A JSON-RPC methods:
//   - message/send (and the older tasks/send alias): submits a task, returns {id, status:"submitted"}
//   - tasks/get {id}: current status/result
//   - tasks/cancel {id}: best-effort cancel if not already terminal
//   - tasks/resubscribe {id}: SSE stream of status changes (ADR-0030); also GET .../a2a/stream
// NOT implemented: push-notification webhooks over this path, full A2A OAuth negotiation.
// The Agent Card declares no required auth scheme, so this endpoint is open to any
// caller the same way POST /api/messages historically was -- the rate limit below is the concrete
// trade-off for that openness (an unauthenticated caller can still only submit ~30 tasks/min/agent
// before being throttled, not flood an agent's inbox unbounded).
//
// For a MOYE agent to actually answer A2A tasks: watch the inbox for messages from
// '(a2a-bridge)', parse `{a2a_task_id, text}` out of the JSON content, process it, then call
// POST /api/agents/:id/a2a-result {task_id, state, parts} (self-auth) to update/complete the task.
const A2A_RATE_WINDOW_MS = 60 * 1000;
const A2A_RATE_LIMIT = 30; // task submissions per agent per minute
const A2A_TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);
const A2A_RESULT_STATES = new Set([
  'working', 'input_required', 'auth_required',
  'completed', 'failed', 'canceled', 'rejected',
]);
const a2aRateWindows = new Map(); // agent_id -> [timestamps within the window]
function a2aRateLimited(agentId) {
  const now = Date.now();
  const win = (a2aRateWindows.get(agentId) || []).filter(t => now - t < A2A_RATE_WINDOW_MS);
  win.push(now);
  a2aRateWindows.set(agentId, win);
  return win.length > A2A_RATE_LIMIT;
}
function partsToText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map(p => (p && typeof p.text === 'string') ? p.text : '')
    .filter(Boolean).join('\n');
}
function a2aTaskToJson(row) {
  const out = { id: row.id, status: { state: row.status, timestamp: new Date(row.updated_at).toISOString() } };
  if (row.result) {
    try { out.artifacts = [{ parts: JSON.parse(row.result) }]; } catch { out.artifacts = [{ parts: [{ type: 'text', text: row.result }] }]; }
  }
  return out;
}
function jsonRpcError(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }; }
function jsonRpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function publicBaseUrl(req) {
  // Prefer operator-set PUBLIC_ENDPOINT; otherwise derive from the incoming request so
  // external-facing URLs (e.g. A2A streamUrl) aren't stuck on localhost when the env is unset
  // (ops live check after M1 deploy — a2aStreamUrl newly exposed this existing config gap).
  if (process.env.PUBLIC_ENDPOINT) return process.env.PUBLIC_ENDPOINT.replace(/\/$/, '');
  if (req) {
    const host = (req.get && req.get('host')) || req.headers.host;
    if (host) {
      const xf = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
      const proto = xf || req.protocol || 'http';
      return `${proto}://${host}`;
    }
  }
  return `http://localhost:${PORT}`;
}
function a2aStreamUrl(agentId, taskId, req) {
  return `${publicBaseUrl(req)}/api/agents/${agentId}/a2a/stream?task_id=${encodeURIComponent(taskId)}`;
}
function wantsA2aSse(req) {
  const accept = (req.headers.accept || '').toString().toLowerCase();
  return accept.includes('text/event-stream');
}

app.post('/api/agents/:id/a2a', async (req, res) => {
  const agentId = req.params.id;
  const agent = store.getAgent(agentId);
  const rpcId = req.body && req.body.id;
  if (!agent) return res.status(404).json(jsonRpcError(rpcId, -32001, 'agent not found'));
  const { jsonrpc, method, params } = req.body || {};
  if (jsonrpc !== '2.0' || !method) return res.status(400).json(jsonRpcError(rpcId, -32600, 'invalid JSON-RPC 2.0 request'));

  if (method === 'message/send' || method === 'tasks/send') {
    if (a2aRateLimited(agentId)) return res.status(429).json(jsonRpcError(rpcId, -32000, 'rate limited: too many tasks submitted to this agent'));
    const message = params && (params.message || params);
    const text = partsToText(message && message.parts);
    if (!text) return res.status(400).json(jsonRpcError(rpcId, -32602, 'invalid params: message.parts with a text part required'));
    if (text.length > MAX_CONTENT_LEN) return res.status(400).json(jsonRpcError(rpcId, -32602, 'message too large'));
    const taskId = newId('a2a');
    const now = Date.now();
    stmt.insertA2aTask.run(taskId, agentId, null, JSON.stringify(message), 'submitted', now, now);
    const msgId = newId('msg');
    stmt.insertMessage.run(msgId, '(a2a-bridge)', agentId, JSON.stringify({ a2a_task_id: taskId, text }), 'pending', 0, null, null, null, now);
    stmt.updateA2aTaskMessageId.run(msgId, taskId);
    ledger.append('a2a.task_submit', { task: taskId, agent: agentId, ts: now }).catch(() => {});
    return res.json(jsonRpcResult(rpcId, {
      id: taskId,
      status: { state: 'submitted', timestamp: new Date(now).toISOString() },
      history: [message],
      streamUrl: a2aStreamUrl(agentId, taskId, req),
    }));
  }

  if (method === 'tasks/get' || method === 'tasks/cancel') {
    const taskId = params && params.id;
    const row = taskId && stmt.a2aTaskById.get(taskId);
    if (!row || row.agent_id !== agentId) return res.status(404).json(jsonRpcError(rpcId, -32001, 'task not found'));
    if (method === 'tasks/get') return res.json(jsonRpcResult(rpcId, a2aTaskToJson(row)));
    // tasks/cancel
    if (A2A_TERMINAL.has(row.status)) {
      return res.status(400).json(jsonRpcError(rpcId, -32002, `task already ${row.status}, cannot cancel`));
    }
    stmt.updateA2aTaskStatus.run('canceled', Date.now(), taskId);
    const canceled = a2aTaskToJson(stmt.a2aTaskById.get(taskId));
    a2aTaskStream.publish(canceled);
    ledger.append('a2a.task_result', { task: taskId, agent: agentId, state: 'canceled', ts: Date.now() }).catch(() => {});
    return res.json(jsonRpcResult(rpcId, canceled));
  }

  // ADR-0030: tasks/resubscribe — A2A method name. Prefer Accept: text/event-stream (hijack this
  // response as SSE); otherwise return a streamUrl for GET /api/agents/:id/a2a/stream.
  if (method === 'tasks/resubscribe') {
    const taskId = params && params.id;
    const row = taskId && stmt.a2aTaskById.get(taskId);
    if (!row || row.agent_id !== agentId) return res.status(404).json(jsonRpcError(rpcId, -32001, 'task not found'));
    const snapshot = a2aTaskToJson(row);
    if (wantsA2aSse(req) || params && params.subscribe === true) {
      const sub = a2aTaskStream.subscribe(res, { taskId, agentId, snapshot });
      if (!sub.ok) return res.status(503).json(jsonRpcError(rpcId, -32000, 'stream unavailable: ' + sub.reason));
      return; // response stays open
    }
    return res.json(jsonRpcResult(rpcId, { id: taskId, status: snapshot.status, streamUrl: a2aStreamUrl(agentId, taskId, req) }));
  }

  return res.status(400).json(jsonRpcError(rpcId, -32601, `method not found: ${method}`));
});

// ADR-0030: REST SSE mirror of tasks/resubscribe (easier for curl / EventSource clients).
app.get('/api/agents/:id/a2a/stream', (req, res) => {
  const agentId = req.params.id;
  const agent = store.getAgent(agentId);
  if (!agent) return fail(res, 404, 'agent not found');
  const taskId = (req.query.task_id || '').toString();
  if (!taskId) return fail(res, 400, 'task_id query required');
  const row = stmt.a2aTaskById.get(taskId);
  if (!row || row.agent_id !== agentId) return fail(res, 404, 'task not found');
  const sub = a2aTaskStream.subscribe(res, { taskId, agentId, snapshot: a2aTaskToJson(row) });
  if (!sub.ok) return fail(res, 503, 'stream unavailable: ' + sub.reason);
});

// The receiving MOYE agent reports its own task's result (self-auth only). Mirrors the existing
// room-task-report pattern (POST /api/rooms/:id/tasks/:tid/report).
// ADR-0030: accepts the full non-initial A2A lifecycle. Intermediate states
// (working/input_required/auth_required) may be reported repeatedly; terminal states may not.
app.post('/api/agents/:id/a2a-result', async (req, res) => {
  const me = await authAgent(req);
  if (!me) return fail(res, 401, 'Bearer token or DID sig required');
  if (me.id !== req.params.id) return fail(res, 403, 'identity mismatch');
  const { task_id, state, parts } = req.body || {};
  if (!task_id) return fail(res, 400, 'task_id required');
  if (!A2A_RESULT_STATES.has(state)) {
    return fail(res, 400, 'state must be one of working|input_required|auth_required|completed|failed|canceled|rejected');
  }
  const row = stmt.a2aTaskById.get(task_id);
  if (!row || row.agent_id !== me.id) return fail(res, 404, 'task not found');
  if (A2A_TERMINAL.has(row.status)) {
    return fail(res, 400, `task already ${row.status}; terminal states cannot be updated`);
  }
  const now = Date.now();
  // Intermediate + terminal both may carry parts (e.g. input_required prompt); overwrite result.
  stmt.updateA2aTaskResult.run(state, JSON.stringify(parts || []), now, task_id);
  const updated = a2aTaskToJson(stmt.a2aTaskById.get(task_id));
  a2aTaskStream.publish(updated);
  ledger.append('a2a.task_result', { task: task_id, agent: me.id, state, ts: now }).catch(() => {});
  ok(res, { task_id, state, terminal: A2A_TERMINAL.has(state) });
});
// Node-level index card -- explicitly labeled as a registry/gateway, not a single agent's card, so
// an A2A client doesn't mistake "this whole MOYE node" for one agent.
app.get('/.well-known/agent.json', async (req, res) => {
  const endpoint = process.env.PUBLIC_ENDPOINT || `http://localhost:${PORT}`;
  res.json({
    name: `MOYE network (${ledger.NODE_ID})`,
    description: 'This is a MOYE registry/gateway node, not a single agent. It hosts many independently-identified agents (see agents[]), each with its own Agent Card.',
    url: endpoint,
    version: '1.0',
    is_registry: true,
    discover: endpoint + '/api/agents',
    agents: store.listAgents('').slice(0, 50).map(a => ({ id: a.id, name: a.name, agent_card: `${endpoint}/api/agents/${a.id}/agent-card` })),
  });
});

// n4+: network self-description (machine-readable discovery entrypoint) -- agents read this to self-onboard
app.get(['/api/network', '/.well-known/moye-net'], async (req, res) => {
  const seeds = allSeeds();
  const endpointReachability = await p2pRelay.reachabilityHint();
  ok(res, {
    protocol: 'moye-net',
    version: PROTOCOL_VERSION,
    // Capabilities an agent can probe for before relying on them (spec: a2a/docs/spec, local).
    features: PROTOCOL_FEATURES,
    this_node: ledger.NODE_ID,
    role: 'seed',                       // this node is a seed/origin point
    // ADR-0006 workstream P2 (scaffolding, unverified): this node's own Yggdrasil overlay IPv6
    // address, if the operator ran scripts/setup-yggdrasil.sh and set OVERLAY_ADDR in its systemd
    // unit. null until then -- this is a discovery surface, not a claim that overlay routing works.
    overlay_addr: process.env.OVERLAY_ADDR || null,
    // ADR-0008: directory sharding. num_shards=1 / served_shards=[0] (the default) means this node
    // holds the full directory, exactly like every node before sharding existed -- nothing to
    // change for today's small deployments. A client/SDK doing agent lookups can use this to decide
    // whether it needs to fan out to multiple nodes for full-network coverage.
    sharding: {
      num_shards: shard.NUM_SHARDS,
      served_shards: shard.servedShardsList(),
      // P2-3 routing surface — all values estimated, no real load data as of 2026-08-06
      route_mode: shard.ROUTE_MODE,
      forward_timeout_ms: shard.FORWARD_TIMEOUT_MS,
      forward_max_hops: shard.FORWARD_MAX_HOPS,
      query_fanout_max: shard.QUERY_FANOUT_MAX,
      enable_shard_dht: shard.ENABLE_SHARD_DHT,
    },
    ipfs_root_cid: store._rootCid() || null,
    // true when no operator-issued invite code is required, i.e. anyone can register by
    // clearing the automatic PoW challenge or bringing their own DID pubkey -- NOT "no
    // admission control at all" (PoW/DID are still enforced either way, see POST /api/agents)
    open_registration: !process.env.OPEN_INVITE,
    join: {
      register: '/api/agents  (POST, requires x-invite if the operator set one, otherwise PoW or pubkey[DID])',
      discover: '/api/agents  (GET, public)',
      bridge: '/api/bridge/register  (zero-SDK onboarding)',
      shared_state: '/api/shared-state',
      ledger_anchor: '/api/ledger/anchor  (POST {chain:"ipfs"})',
      // ADR-0013: live event stream — SSE for browsers/agents, NDJSON for indexers/CLIs.
      // Query: ?types=agent.register,room.message&did=did:moye:...  (both optional filters).
      firehose: '/api/stream  (SSE) | /api/stream.ndjson  (NDJSON); disable with ENABLE_FIREHOSE=0',
      // P2-5: optional L2 indexer URLs (operators run tools/moye-indexer.js). Empty until configured.
      // estimated INDEXER_* tunables live on the indexer process, not this node.
      indexers: (process.env.INDEXER_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
      search: '/api/search  (POST {q, capability, min_reputation, claim_type, limit}; gravity-ranked)',
      verbs: '/api/verbs',
      room_fork: '/api/rooms/:id/fork  (POST {checkpoint_id,name})',
      room_at: '/api/rooms/:id/at?ts=|checkpoint=',
      // ADR-0031: per-room MCP Streamable HTTP (JSON-RPC initialize|tools/list|tools/call).
      // Coexists with stdio MCP at /mcp-dist — scoped to one room_id; no create/join tools.
      room_mcp: '/mcp/rooms/:id  (POST JSON-RPC; GET discovery|SSE hello); Bearer or DID',
      resolve_at: '/api/agents/:id/resolve?at=<ts|seq:N>',
      timeline: '/api/agents/:id/timeline',
      dashboard: '/dashboard/dashboard.html',
    },
    // Machine-readable auth contract so a self-onboarding agent knows exactly how to authenticate
    // a write without scraping human docs -- notably the anti-replay `ts` requirement on DID sigs.
    auth: {
      modes: ['bearer', 'did'],
      bearer: { header: 'Authorization: Bearer <token>' },
      did: {
        headers: ['X-Moye-Did: <did>', 'X-Moye-Sig: base64(Ed25519 sign over the exact JSON request body)'],
        body_must_include: { ts: 'milliseconds since epoch; must be within 5 minutes; a given signature is accepted only once (replay protection)' },
        note: 'The signature covers the whole JSON body including ts. Servers in migration mode (ALLOW_UNSIGNED_TS=1) still accept bodies without ts.',
      },
      registration_admission: ['x-invite (if operator set OPEN_INVITE)', 'pubkey (DID self-attestation)', 'PoW (server-issued one-time challenge; solve prefix+nonce, sha256 starts with N zeros)'],
      reserved_shared_state_prefixes: ['revoke:', 'reputation:'],
    },
    docs: { human: '/docs', llms: '/llms.txt', sdk: '/sdk-dist', mcp: '/mcp-dist', agent_card: '/.well-known/agent.json', protocol_adoption: '/api/protocol/adoption', openapi: '/api/network' },
    seeds,
    p2p_relay: p2pRelay.info(), // P3: libp2p circuit-relay-v2 relay info, the agent SDK uses this to connect to the relay and dial direct connections
    // ADR-0006 workstream E1 (partial): 'public'/'private'/'unknown' from resolving PUBLIC_ENDPOINT --
    // a necessary-but-not-sufficient signal for relay viability (doesn't confirm the port is actually
    // open), surfaced so an operator/other node can weigh it. Does NOT auto-enable ENABLE_P2P by itself.
    endpoint_reachability: endpointReachability,
    access_modes: ['http', 'ipfs(native cat <ipfs_root_cid>)', 'ws-bridge', 'webhook-bridge', 'libp2p-relay'],
  });
});

server.listen(PORT, async () => {
  console.log(`MOYE A2A server on :${PORT} (http+ws) node=${ledger.NODE_ID}`);
  await store.init();        // Subscribe to the IPFS shared-state channel (agent/room/shared)
  await migrateLegacyRoomTasks().catch(e => console.log('[rooms] legacy task migration skipped:', e.message));
  // P3 libp2p relay is off by default: it needs its own firewall port (LIBP2P_PORT) opened, and
  // direct-connect reliability still has known issues -- it shouldn't come online as a passive
  // side effect of deploying governance, so it only starts when ENABLE_P2P=1 is explicitly set.
  let enableP2p = process.env.ENABLE_P2P === '1';
  // ADR-0006 workstream E1/E2 (2026-07-25): AUTO_ENABLE_P2P=1 is a separate, still-opt-in flag --
  // it does NOT change the ENABLE_P2P default for anyone who hasn't set it. When set (and ENABLE_P2P
  // itself wasn't already explicitly decided), it asks a federation peer to verify this node's own
  // PORT is really reachable from the outside (checkSelfReachability above) before starting the P3
  // relay, instead of an operator having to guess. This tests the already-listening HTTP port as a
  // proxy for "is this box reachable from the internet at all" -- it does NOT confirm LIBP2P_PORT
  // specifically is open/forwarded too (that port isn't listening yet at this point in startup, so it
  // can't be tested directly); the operator still needs to have opened LIBP2P_PORT for the relay to
  // actually be dialable once it starts.
  if (!process.env.ENABLE_P2P && process.env.AUTO_ENABLE_P2P === '1') {
    const result = await checkSelfReachability(PORT).catch(() => null);
    if (result && result.reachable) {
      console.log(`[p2p-relay] AUTO_ENABLE_P2P: peer ${result.checked_via} confirmed :${PORT} reachable -- enabling`);
      enableP2p = true;
    } else {
      console.log(`[p2p-relay] AUTO_ENABLE_P2P: reachability not confirmed (${result ? 'peer reports unreachable' : 'no peer could check'}) -- staying disabled`);
    }
  }
  if (enableP2p) {
    await p2pRelay.init().catch(e => console.log('[p2p-relay] failed to start:', e.message));
  } else {
    console.log('[p2p-relay] not enabled (set ENABLE_P2P=1 to force-enable, or AUTO_ENABLE_P2P=1 to auto-enable after a peer-verified reachability check)');
  }
  // P2-3: optional DHT announce of shard:<n> ownership (ADR-0008 gap). estimated, no real load data.
  if (shard.ENABLE_SHARD_DHT && enableP2p) {
    const served = shard.servedShardsList();
    const list = served === 'all'
      ? Array.from({ length: shard.NUM_SHARDS }, (_, i) => i)
      : (Array.isArray(served) ? served : [0]);
    for (const n of list) {
      p2pRelay.provideShard(n).catch(() => {});
    }
    console.log(`[shard-dht] providing ${list.length} shard key(s) (ENABLE_SHARD_DHT=1)`);
  }
  // Auto-anchoring: the hash-chain ledger is only "tamper-evident" against a wholesale rewrite by
  // the node operator to the extent its Merkle root is periodically pinned to an external, immutable
  // store that a rewrite can't reach back and change. Left purely manual, a long-lived node might go
  // weeks with no external checkpoint. When AUTO_ANCHOR_MS is set, snapshot+anchor to local IPFS on
  // that cadence (free, self-hosted); operators wanting stronger guarantees still anchor to Arweave.
  const autoAnchorMs = parseInt(process.env.AUTO_ANCHOR_MS || '0', 10);
  if (autoAnchorMs > 0) {
    setInterval(() => {
      ledger.anchorToIpfs()
        .then(r => console.log(`[anchor] auto-anchored ledger to ipfs cid=${r.cid} height=${r.height}`))
        .catch(e => console.log('[anchor] auto-anchor skipped:', e.message));
    }, autoAnchorMs);
    console.log(`[anchor] auto-anchor enabled every ${autoAnchorMs}ms`);
  }
  bootstrapFederation();
});
