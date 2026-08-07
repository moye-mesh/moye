'use strict';
// IPFS shared-state backend -- replaces MySQL for agents/rooms/shared_state
// Incremental-CID model: each agent/room/shared-key gets its own CID, the root manifest only
// stores the mapping. Writing a single agent uploads just that agent's JSON + a small manifest
// (O(1)), instead of re-adding the entire state on every write.
const fs = require('fs');
const path = require('path');
const crdt = require('./crdt'); // F4: rich CRDT merge laws for tagged shared-state values
const schema = require('./schema'); // capName() normalizes legacy string vs. structured (F1) capabilities
const shard = require('./shard'); // ADR-0008: consistent-hash directory sharding
const spill = require('./dir_spill'); // ADR-0012 S2 / P2-1: SQLite write-through + cold load

const IPFS_URL = process.env.IPFS_URL || 'http://127.0.0.1:5001';
const ROOT_FILE = path.join(__dirname, '..', '.ipfs_root_cid');
const CHANNEL = 'moye-net-state';
// Hot cache size. IDs/indexes stay complete in memory; full agent/room/shared bodies beyond
// this budget are served from SQLite (dir_spill) so RAM stays roughly flat as the directory grows.
const MEM_BUDGET = Math.max(64, parseInt(process.env.MEM_BUDGET || '2000', 10) || 2000);

let ipfs = null;
let ready = false;
let rootCid = fs.existsSync(ROOT_FILE) ? fs.readFileSync(ROOT_FILE, 'utf8').trim() : null;
let state = { agents: {}, rooms: {}, shared: {} };
// In-memory CID map: the current IPFS CID for each key (the basis for incremental writes)
let cids = { agents: {}, rooms: {}, shared: {} };
// OR-Set tombstones: once an id is removed it must never be silently re-added just because some
// peer's manifest still references it -- see removeAgent()/removeRoom() and the merge comment
// below for the bug this exists to prevent.
let tombstones = { agents: new Set(), rooms: new Set() };
let sub = null;
// did -> agent id index; DID auth uses this for an O(1) lookup instead of scanning every agent
// (much faster once the agent count grows)
let didIndex = new Map();
// ADR-0008: capability -> Set<agentId> inverted index. GET /api/agents?capability=X used to be a
// full O(N) scan of every agent's capabilities array on every single query (fine at hundreds of
// agents, a real bottleneck heading toward the directory sizes ADR-0008 targets). Maintained
// incrementally on put/remove, same pattern as didIndex right above. Bounded by capability
// cardinality (typically far smaller than agent count), not agent count.
let capabilityIndex = new Map();
// Insertion-order Maps used as LRUs (Map preserves insertion order; re-set = most recent).
const agentLru = new Map();
const roomLru = new Map();
const sharedLru = new Map();
// R20: memoize crdt.read() materialization per shared key. Invalidated when the backing row
// object changes (putShared) or the key is LRU-evicted. Read-heavy room catch-up goes from
// O(n) rebuild per request to amortized O(1).
const readCache = new Map(); // key -> { row, value }
// WeakMap so callers can ask whether a materialized array is ts-sorted without re-scanning.
const materialMeta = new WeakMap(); // array -> { tsSorted: boolean }

function invalidateReadCache(key) {
  if (key == null) readCache.clear();
  else readCache.delete(key);
}

function touchAgent(id, obj) {
  if (agentLru.has(id)) agentLru.delete(id);
  agentLru.set(id, true);
  state.agents[id] = obj;
  while (agentLru.size > MEM_BUDGET) {
    const oldest = agentLru.keys().next().value;
    agentLru.delete(oldest);
    delete state.agents[oldest];
  }
}
function touchRoom(id, obj) {
  if (roomLru.has(id)) roomLru.delete(id);
  roomLru.set(id, true);
  state.rooms[id] = obj;
  while (roomLru.size > MEM_BUDGET) {
    const oldest = roomLru.keys().next().value;
    roomLru.delete(oldest);
    delete state.rooms[oldest];
  }
}
function touchShared(key, obj) {
  if (sharedLru.has(key)) sharedLru.delete(key);
  sharedLru.set(key, true);
  state.shared[key] = obj;
  while (sharedLru.size > MEM_BUDGET) {
    const oldest = sharedLru.keys().next().value;
    sharedLru.delete(oldest);
    delete state.shared[oldest];
    invalidateReadCache(oldest);
  }
}
function indexAgent(id, obj) {
  if (obj && obj.did) didIndex.set(obj.did, id);
  for (const cap of (obj && obj.capabilities) || []) {
    const name = schema.capName(cap);
    if (!name) continue;
    if (!capabilityIndex.has(name)) capabilityIndex.set(name, new Set());
    capabilityIndex.get(name).add(id);
  }
}
function deindexAgentCapabilities(id) {
  for (const [name, set] of capabilityIndex.entries()) {
    set.delete(id);
    if (set.size === 0) capabilityIndex.delete(name); // keep the index tidy: no capability entries with zero agents
  }
}
function rebuildDidIndex() {
  didIndex = new Map();
  capabilityIndex = new Map();
  for (const [id, obj] of Object.entries(state.agents)) indexAgent(id, obj);
}

// Deterministic JSON (sorted object keys) so two nodes that end up with identical manifest
// content always produce the identical CID -- plain JSON.stringify preserves insertion order,
// so the same logical content built up through a different sequence of writes could otherwise
// serialize differently and mint a different CID, which defeats the "did anything actually
// change" check used below to decide whether to republish.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

async function addJson(obj) {
  const res = await ipfs.add(stableStringify(obj));
  return res.cid.toString();
}
async function catJson(cid) {
  if (!cid) return null;
  if (!ipfs) return null;
  const chunks = [];
  for await (const c of ipfs.cat(cid)) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}
function saveRoot(cid) { rootCid = cid; fs.writeFileSync(ROOT_FILE, cid); }

function serializeTombstones() { return { agents: [...tombstones.agents], rooms: [...tombstones.rooms] }; }
// Also self-heals: if this node already has a since-tombstoned id in its own state (e.g. it
// resurrected a ghost copy before it learned about the deletion), purge it now rather than
// waiting for someone to notice. Used both for the IPFS-manifest tombstones field and for the
// HTTP federation reconcile below (nodes with no local IPFS -- like node3 -- only ever learn
// about tombstones this way, since they can't subscribe to the pubsub channel at all).
function loadTombstones(obj) {
  if (!obj) return;
  for (const id of obj.agents || []) {
    tombstones.agents.add(id);
    if (state.agents[id] || spill.getAgent(id)) {
      delete state.agents[id]; agentLru.delete(id); spill.delAgent(id); delete cids.agents[id];
    }
  }
  for (const id of obj.rooms || []) {
    tombstones.rooms.add(id);
    if (state.rooms[id] || spill.getRoom(id)) {
      delete state.rooms[id]; roomLru.delete(id); spill.delRoom(id); delete cids.rooms[id];
    }
  }
}

async function publishManifest() {
  if (!ipfs) { console.log('[ipfs-store] not connected, memory-only'); return null; }
  const manifest = { agents: cids.agents, rooms: cids.rooms, shared: cids.shared, tombstones: serializeTombstones() };
  const cid = await addJson(manifest);
  saveRoot(cid);
  try { await ipfs.pubsub.publish(CHANNEL, Buffer.from(cid)); } catch (e) {}
  return cid;
}

// Merges an incoming manifest into local state. Returns true if anything actually changed, so
// callers can decide whether it's worth republishing.
//
// agents/rooms use OR-Set semantics: add if we don't already have the id (and it isn't
// tombstoned), never overwrite an id we already have. There's no legitimate "edit" API for
// either (see docs/DEPLOY.md known limits), so there's no real concurrent-edit case to resolve
// -- the previous code overwrote state.agents[id] any time the incoming CID differed from the
// cached one, with no notion of "newer", which both violated convergence (two nodes could end
// up disagreeing depending on message arrival order) and made deletions unstable (a peer's
// stale manifest would silently resurrect an id you'd just removed).
//
// shared uses the exact same lamport/owner comparison putShared() already applies on the local
// write path -- previously the pubsub-receive path bypassed that comparison entirely and just
// overwrote state.shared[key] whenever the incoming CID differed, which was a real CRDT
// violation: the code claims "all nodes converge to the same result" but message reordering
// could make that false.
async function mergeManifest(manifest) {
  if (!manifest) return false;
  let changed = false;
  loadTombstones(manifest.tombstones);

  for (const [id, cid] of Object.entries(manifest.agents || {})) {
    if (tombstones.agents.has(id)) continue;
    // ADR-0008: only replicate agents this node is actually responsible for (its served shards).
    // With NUM_SHARDS=1 (default), isResponsibleFor() is always true -- this is a no-op and every
    // node keeps replicating everything, exactly like before sharding existed. Scoped to agents
    // only (not rooms) -- "billions of agents" is the stated target, room counts are orders of
    // magnitude smaller and stay fully-replicated for simplicity.
    if (!shard.isResponsibleFor(id)) continue;
    // P3-6: previously `cids.agents[id]` short-circuited forever (insert-only). Same CID = no-op;
    // a newer CID is accepted only when LWW says the incoming record wins.
    if (cids.agents[id] === cid) continue;
    const obj = await catJson(cid);
    if (!obj) continue;
    const cur = state.agents[id] || spill.getAgent(id);
    if (!agentLwwWins(obj, cur)) continue;
    deindexAgentCapabilities(id);
    touchAgent(id, obj); spill.putAgent(id, obj); cids.agents[id] = cid; indexAgent(id, obj); changed = true;
  }
  for (const [id, cid] of Object.entries(manifest.rooms || {})) {
    if (tombstones.rooms.has(id) || cids.rooms[id]) continue;
    const obj = await catJson(cid);
    if (obj) { touchRoom(id, obj); spill.putRoom(id, obj); cids.rooms[id] = cid; changed = true; }
  }
  for (const [key, cid] of Object.entries(manifest.shared || {})) {
    if (cids.shared[key] === cid) continue; // already have exactly this version
    const obj = await catJson(cid);
    if (!obj) continue;
    // F4: CRDT-tagged incoming value -> merge (order-independent), so pubsub/federation reordering
    // can't diverge. Untagged -> the original lamport/owner LWW comparison, byte-for-byte unchanged.
    if (obj && crdt.isCrdt(obj.value)) {
      const cur = state.shared[key] || spill.getShared(key);
      const base = cur && crdt.isCrdt(cur.value) && cur.value.crdt === obj.value.crdt ? cur.value : {};
      const merged = crdt.merge(obj.value.crdt, base, obj.value) || obj.value;
      const row = { value: merged, lamport: Math.max(obj.lamport || 0, cur ? cur.lamport : 0), owner: obj.owner || '' };
      touchShared(key, row); spill.putShared(key, row);
      cids.shared[key] = cid; changed = true;
    } else {
      const cur = state.shared[key] || spill.getShared(key);
      if (!cur || obj.lamport > cur.lamport || (obj.lamport === cur.lamport && (obj.owner || '') > (cur.owner || ''))) {
        touchShared(key, obj); spill.putShared(key, obj);
        cids.shared[key] = cid; changed = true;
      }
    }
  }
  return changed;
}

// Backward-compat migration: the old "full state" root CID (where agents were inline objects,
// not CID strings) gets split into the incremental format
async function migrateIfNeeded() {
  if (!rootCid || !ipfs) return;
  const old = await catJson(rootCid);
  if (old && old.agents && typeof Object.values(old.agents)[0] === 'object') {
    console.log('[ipfs-store] detected legacy full-state format, migrating to incremental CIDs...');
    for (const [id, obj] of Object.entries(old.agents || {})) cids.agents[id] = await addJson(obj);
    for (const [id, obj] of Object.entries(old.rooms || {})) cids.rooms[id] = await addJson(obj);
    for (const [key, obj] of Object.entries(old.shared || {})) cids.shared[key] = await addJson(obj);
    state = old;
    rebuildDidIndex();
    await publishManifest();
    console.log('[ipfs-store] migration complete, new root CID=', rootCid);
  }
}

async function loadFromIpfs() {
  if (!rootCid) return state;
  try {
    const manifest = await catJson(rootCid);
    if (!manifest) return state;
    // Format detection used to require finding a string-typed (CID) value to conclude "this is
    // the new incremental format" -- broken as soon as agents ever legitimately reaches zero
    // entries (Object.values({})[0] is undefined, `typeof undefined === 'string'` is false), which
    // never happened before deletion existed but now does on every node that's had everything
    // removed. That silently fell through to migrateIfNeeded(), whose own legacy-format check
    // *also* fails on an empty map, so nothing ran at all -- manifest.tombstones (and any shared
    // state) never got loaded. Invert the check: only treat it as legacy if we find positive
    // evidence (an inline object value), default to the current format otherwise.
    const looksLegacy = manifest.agents && Object.values(manifest.agents).some((v) => v && typeof v === 'object');
    if (looksLegacy) {
      await migrateIfNeeded();
    } else {
      await mergeManifest(manifest);   // new incremental format (state starts empty, so this is a full load)
    }
  } catch (e) { console.log('[ipfs-store] load failed, keeping in-memory state:', e.message); }
  return state;
}

// `ipfs` being non-null only means the client object was constructed, not that the daemon is
// actually reachable (ipfs-http-client's create() never tests connectivity) -- so these calls
// can and do fail at request time whenever the daemon is unreachable, and previously did so
// uncaught, crashing the whole process on the next agent/room/shared-state write after any
// Kubo hiccup. The in-memory state (state.agents[id] etc.) is already updated by the caller
// before commit*() runs, so on failure we keep serving from memory / federation HTTP sync and
// just skip durable IPFS persistence for this write, instead of taking the server down over it.
async function commitAgent(id) {
  if (!ipfs) return;
  try {
    const obj = getAgent(id);
    if (!obj) return;
    cids.agents[id] = await addJson(obj);
    await publishManifest();
  } catch (e) { console.log('[ipfs-store] commitAgent failed, keeping in-memory only:', e.message); }
}
async function commitRoom(id) {
  if (!ipfs) return;
  try {
    const obj = getRoom(id);
    if (!obj) return;
    cids.rooms[id] = await addJson(obj);
    await publishManifest();
  } catch (e) { console.log('[ipfs-store] commitRoom failed, keeping in-memory only:', e.message); }
}
async function commitShared(key) {
  if (!ipfs) return;
  try {
    const obj = state.shared[key] || spill.getShared(key);
    if (!obj) return;
    cids.shared[key] = await addJson(obj);
    await publishManifest();
  } catch (e) { console.log('[ipfs-store] commitShared failed, keeping in-memory only:', e.message); }
}

/** Binary blob add (N1 attachments). Returns cid string or null if IPFS unavailable. */
async function addBytes(bytes, name = 'blob') {
  if (!ipfs) return null;
  const res = await ipfs.add({ path: name, content: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
  return res.cid.toString();
}

/** Cat bytes by CID. Returns Buffer or null. Caps at maxBytes to protect node memory. */
async function catBytes(cid, maxBytes = 8 * 1024 * 1024) {
  if (!ipfs || !cid) return null;
  const chunks = [];
  let total = 0;
  for await (const c of ipfs.cat(cid)) {
    total += c.length;
    if (total > maxBytes) {
      const err = new Error(`blob exceeds ${maxBytes} bytes`);
      err.status = 413;
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function init() {
  // Hydrate indexes (+ a hot slice) from SQLite before/without IPFS so a restart on a
  // memory-constrained node does not begin empty until the next peer sync.
  try {
    const persisted = spill.allAgents();
    const ids = Object.keys(persisted);
    for (const id of ids) indexAgent(id, persisted[id]);
    // Warm the LRU with the most recently written MEM_BUDGET agents (SQLite has no order here —
    // take an arbitrary slice; subsequent gets will promote).
    for (const id of ids.slice(-MEM_BUDGET)) touchAgent(id, persisted[id]);
    const rooms = spill.allRooms();
    for (const id of Object.keys(rooms).slice(-MEM_BUDGET)) touchRoom(id, rooms[id]);
    const shared = spill.allShared();
    for (const key of Object.keys(shared).slice(-MEM_BUDGET)) touchShared(key, shared[key]);
    const metaCids = spill.getMeta('cids');
    if (metaCids && typeof metaCids === 'object') {
      cids.agents = metaCids.agents || cids.agents;
      cids.rooms = metaCids.rooms || cids.rooms;
      cids.shared = metaCids.shared || cids.shared;
    }
    const metaTombs = spill.getMeta('tombstones');
    if (metaTombs) loadTombstones(metaTombs);
    if (ids.length) console.log('[ipfs-store] hydrated from SQLite:', spill.agentCount(), 'agents,', spill.roomCount(), 'rooms, budget', MEM_BUDGET);
  } catch (e) {
    console.log('[ipfs-store] SQLite hydrate skipped:', e.message);
  }

  try {
    const mod = await import('ipfs-http-client');
    ipfs = mod.create({ url: IPFS_URL });
  } catch (e) { console.log('[ipfs-store] import failed:', e.message); return; }
  await loadFromIpfs();
  try {
    // pubsub.subscribe() returns a promise that only resolves once the daemon confirms the
    // subscription (it makes a real HTTP call) -- this was previously not awaited, so if the
    // daemon was unreachable the rejection went unhandled and crashed the whole process instead
    // of being caught by this try/catch. Same failure mode as the rest of this file: log and
    // keep running in memory-only mode, don't take the server down over IPFS being unavailable.
    sub = await ipfs.pubsub.subscribe(CHANNEL, async (msg) => {
      const incomingCid = msg.data.toString();
      if (incomingCid === rootCid) return;
      try {
        const manifest = await catJson(incomingCid);
        if (!manifest) return;
        const changed = await mergeManifest(manifest);
        // Never adopt a peer's CID as our own root pointer -- pubsub delivery has no ordering
        // guarantee, so incomingCid can easily be older/smaller than what we already have.
        // Blindly saving it here was the actual bug: it made the persisted root regress to a
        // stale snapshot, which on the next restart would get reloaded as if it were current,
        // silently discarding anything committed after that snapshot was taken. Only ever
        // advance the root by republishing our own (monotonically-growing, OR-Set-merged) view.
        if (changed) await publishManifest();
      } catch (e) {}
    });
    ready = true;
    console.log('[ipfs-store] subscribed to shared-state channel', CHANNEL, 'root CID=', rootCid || '(new)');
  } catch (e) { console.log('[ipfs-store] subscribe failed, continuing memory-only:', e.message); }
}

// P3-6: agent-record federation LWW. Analogous to shared state's (lamport, owner) — for agents
// the writer identity is home_node (the authoritative node), not the free-text `owner` org field.
function agentLamport(a) {
  if (!a) return 0;
  return a.lamport || a.updated_at || a.created_at || 0;
}
function agentLwwWins(incoming, local) {
  if (!local) return true;
  const iL = agentLamport(incoming);
  const cL = agentLamport(local);
  if (iL !== cL) return iL > cL;
  return String(incoming.home_node || '') > String(local.home_node || '');
}

// ---- agents ----
// opts.preserveLamport: federation merge of a peer's already-versioned record — keep its lamport.
// Local writes (default) bump lamport so peers can LWW-accept the update (P3-6).
async function putAgent(id, obj, opts = {}) {
  const cur = state.agents[id] || spill.getAgent(id);
  const next = { ...obj, id };
  if (opts.preserveLamport) {
    if (next.lamport == null) next.lamport = next.created_at || Date.now();
  } else {
    let L = Date.now();
    const curL = agentLamport(cur);
    if (L <= curL) L = curL + 1;
    next.lamport = L;
  }
  deindexAgentCapabilities(id); // safe no-op today (no capability-update endpoint exists yet), but
  indexAgent(id, next);         // keeps the index correct if a future re-put ever changes capabilities
  touchAgent(id, next);
  spill.putAgent(id, next);
  spill.putMeta('cids', cids);
  await commitAgent(id);
  return next;
}
function getAgent(id) {
  if (state.agents[id]) {
    touchAgent(id, state.agents[id]);
    return state.agents[id];
  }
  const obj = spill.getAgent(id);
  if (!obj) return null;
  touchAgent(id, obj);
  return obj;
}
function getAgentByDid(did) { const id = didIndex.get(did); return id ? getAgent(id) : null; }
// Bug found via code review (2026-07-24): `c.includes(q)` assumed every capability entry is a
// string, but F1 (structured capabilities) can put objects here -- `c.includes` would throw
// TypeError for any agent that registered a structured capability and any caller that also passed
// a free-text `q`. Fixed with schema.capName(), the same normalizer already used for the
// `?capability=` filter path in server.js.
function listAgents(q) {
  // Full directory listing must see cold rows too — IDs live in SQLite even when bodies are evicted.
  const ids = new Set([...spill.allAgentIds(), ...Object.keys(state.agents)]);
  let a = [];
  for (const id of ids) {
    if (tombstones.agents.has(id)) continue;
    const v = getAgent(id);
    if (v) a.push({ id, ...v });
  }
  if (q) a = a.filter(x => (x.name || '').includes(q) || (x.capabilities || []).some(c => schema.capName(c).includes(q)));
  return a;
}
// ADR-0008: O(matching agents) capability lookup via the inverted index, instead of scanning every
// agent in state.agents. Falls back to the full scan only if the index somehow has no entry for a
// capability that does exist (shouldn't happen given indexAgent() runs on every putAgent(), but a
// stale/empty index degrading to "no results" instead of a crash is the safer failure mode).
function listAgentsByCapability(capability) {
  const ids = capabilityIndex.get(capability);
  if (!ids) return [];
  const out = [];
  for (const id of ids) {
    const a = getAgent(id);
    if (a) out.push({ id, ...a });
  }
  return out;
}
// O(distinct capabilities) instead of O(total agents * avg capabilities per agent) for the
// GET /api/capabilities aggregate endpoint.
function capabilityCounts() {
  const out = {};
  for (const [name, ids] of capabilityIndex.entries()) out[name] = ids.size;
  return out;
}
// Permanently removes an agent (OR-Set remove: tombstoned so no peer can resurrect it by
// re-merging an older manifest that still references it). Used by self/governance deregistration.
async function removeAgent(id) {
  if (!getAgent(id) && !spill.getAgent(id)) return false;
  delete state.agents[id];
  agentLru.delete(id);
  spill.delAgent(id);
  delete cids.agents[id];
  tombstones.agents.add(id);
  spill.putMeta('tombstones', serializeTombstones());
  spill.putMeta('cids', cids);
  didIndex.forEach((v, k) => { if (v === id) didIndex.delete(k); });
  deindexAgentCapabilities(id);
  if (ipfs) { try { await publishManifest(); } catch (e) { console.log('[ipfs-store] removeAgent publish failed:', e.message); } }
  return true;
}
// ---- rooms ----
async function putRoom(id, obj) {
  touchRoom(id, obj);
  spill.putRoom(id, obj);
  spill.putMeta('cids', cids);
  await commitRoom(id);
  return obj;
}
function getRoom(id) {
  if (state.rooms[id]) {
    touchRoom(id, state.rooms[id]);
    return state.rooms[id];
  }
  const obj = spill.getRoom(id);
  if (!obj) return null;
  touchRoom(id, obj);
  return obj;
}
function listRooms() {
  const ids = new Set([...spill.allRoomIds(), ...Object.keys(state.rooms)]);
  const out = [];
  for (const id of ids) {
    if (tombstones.rooms.has(id)) continue;
    const v = getRoom(id);
    if (v) out.push({ id, ...v });
  }
  return out;
}
async function removeRoom(id) {
  if (!getRoom(id) && !spill.getRoom(id)) return false;
  delete state.rooms[id];
  roomLru.delete(id);
  spill.delRoom(id);
  delete cids.rooms[id];
  tombstones.rooms.add(id);
  spill.putMeta('tombstones', serializeTombstones());
  spill.putMeta('cids', cids);
  if (ipfs) { try { await publishManifest(); } catch (e) { console.log('[ipfs-store] removeRoom publish failed:', e.message); } }
  return true;
}
// ---- shared (CRDT: LWW-Register, multiple writers, deterministic convergence) ----
// A key's final value = (highest lamport, ties broken by writer lexicographically) --
// all nodes converge to the same result, no owner lock
async function putShared(key, value, lamport, writer) {
  const cur = state.shared[key] || spill.getShared(key);
  const L = lamport || 0;
  const W = writer || '';
  // F4: a CRDT-tagged value is MERGED with whatever is stored (its merge law -- not lamport -- decides
  // convergence), so the write always lands regardless of lamport ordering. Untagged values keep the
  // exact original LWW-Register behavior below, so all existing shared state is unaffected.
  if (crdt.isCrdt(value)) {
    const base = cur && crdt.isCrdt(cur.value) && cur.value.crdt === value.crdt ? cur.value : {};
    const merged = crdt.merge(value.crdt, base, value) || value;
    const row = { value: merged, lamport: Math.max(L, cur ? cur.lamport : 0), owner: W };
    invalidateReadCache(key);
    touchShared(key, row);
    spill.putShared(key, row);
    await commitShared(key);
    return row;
  }
  if (!cur || L > cur.lamport || (L === cur.lamport && W > (cur.owner || ''))) {
    const row = { value, lamport: L, owner: W };
    invalidateReadCache(key);
    touchShared(key, row);
    spill.putShared(key, row);
    await commitShared(key);
    return row;
  }
  return cur;
}
// Bug found via room-chat integration testing (2026-07-24): this used to return the raw stored
// value verbatim, which for a CRDT-tagged value (e.g. the rga-backed room chat log) is the internal
// {crdt, nodes} representation, not the readable materialized form -- inconsistent with allShared()
// below, which already materializes via crdt.read(). Any caller of getShared() on a CRDT key got the
// wrong shape. crdt.read() is the identity function for anything without a recognized `crdt` tag, so
// this is a no-op for every existing non-CRDT caller (repKey/vcKey/revoke: etc.) -- pure bug fix.
// R20: memoize materialization; row-identity check means putShared automatically misses the cache.
function getShared(key) {
  let row = state.shared[key];
  if (!row) {
    row = spill.getShared(key);
    if (row) touchShared(key, row);
  } else {
    touchShared(key, row);
  }
  if (!row) return null;
  const hit = readCache.get(key);
  if (hit && hit.row === row) return hit.value;
  const value = crdt.read(row.value);
  if (Array.isArray(value)) {
    // RGA merge sorts by (elem.ts, id); materialization preserves that order. Other shapes are
    // not assumed sorted — callers must verify or fall back (see lib/room_read.js).
    materialMeta.set(value, { tsSorted: !!(row.value && row.value.crdt === 'rga') });
  }
  readCache.set(key, { row, value });
  return value;
}

/** Optional metadata for a value previously returned by getShared (WeakMap; GC-safe). */
function getSharedMaterialMeta(value) {
  if (value == null || typeof value !== 'object') return null;
  return materialMeta.get(value) || null;
}
// F4: materialize CRDT values to their readable form (counter->number, orset->array); untagged
// values pass through unchanged (crdt.read is identity for anything without a known crdt tag).
function allShared() {
  const all = spill.allShared();
  for (const [k, v] of Object.entries(state.shared)) all[k] = v;
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, crdt.read(v.value)]));
}

function allAgentIds() {
  return [...new Set([...spill.allAgentIds(), ...Object.keys(state.agents)])]
    .filter((id) => !tombstones.agents.has(id));
}
// Callers merging remote-provided agent/room records (federation HTTP reconcile, not just the
// IPFS-pubsub path inside this file) must check this before re-adding an id they don't have
// locally -- "don't have it" and "deliberately removed it" look identical from the outside
// without this, which is exactly how a deleted agent could get silently resurrected by a peer
// that hasn't caught up yet. See server.js's bootstrapFederation()/POST /api/federation/sync.
function isTombstoned(kind, id) { return !!(tombstones[kind] && tombstones[kind].has(id)); }
function _cids() { return cids; }
function _tombstones() { return tombstones; }
function _raw() {
  // Federation/sync callers need the complete directory, not just the hot LRU slice.
  const agents = spill.allAgents();
  for (const [id, obj] of Object.entries(state.agents)) agents[id] = obj;
  const rooms = spill.allRooms();
  for (const [id, obj] of Object.entries(state.rooms)) rooms[id] = obj;
  const shared = spill.allShared();
  for (const [key, obj] of Object.entries(state.shared)) shared[key] = obj;
  return { agents, rooms, shared };
}

module.exports = {
  init, ipfs: () => ipfs, ready: () => ready,
  putAgent, getAgent, getAgentByDid, listAgents, listAgentsByCapability, capabilityCounts, removeAgent,
  agentLamport, agentLwwWins,
  putRoom, getRoom, listRooms, removeRoom,
  putShared, getShared, getSharedMaterialMeta, allShared, allAgentIds, isTombstoned,
  getTombstones: serializeTombstones, mergeTombstones: loadTombstones,
  addBytes, catBytes,
  _raw, _rootCid: () => rootCid, _cids, _tombstones,
};
