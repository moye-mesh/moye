'use strict';
// moye-net: tamper-evident append-only ledger (hash chain)
// Each entry = { seq, hash, prev, type, data, ts, node }
// hash = sha256(prev + '|' + type + '|' + JSON(data) + '|' + ts + '|' + node)
const crypto = require('crypto');
const db = require('./db');

const NODE_ID = process.env.NODE_ID || 'seed1';

// Recursively sort keys so JSON serialization is identical on any end
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function hashOf(prev, type, data, ts, node) {
  return crypto.createHash('sha256')
    .update(prev + '|' + type + '|' + stableStringify(data) + '|' + ts + '|' + node)
    .digest('hex');
}

const selectLastHash = db.prepare('SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1');
const insertEntry = db.prepare('INSERT INTO ledger (hash, prev, type, data, ts, node) VALUES (?,?,?,?,?,?)');

// Optional listeners (e.g. ADR-0013 firehose). Kept inside ledger so every append path —
// including federation/governance — fans out without each call site remembering to publish.
const appendListeners = [];
function onAppend(fn) {
  if (typeof fn === 'function') appendListeners.push(fn);
  return () => {
    const i = appendListeners.indexOf(fn);
    if (i >= 0) appendListeners.splice(i, 1);
  };
}

// Appends an entry, automatically chaining to the previous hash.
// better-sqlite3 is a synchronous API on Node's single thread, so the function body wrapped by
// db.transaction never yields the event loop -- this naturally avoids the race between "read the
// last hash" and "insert the new entry" that the old MySQL version needed SELECT ... FOR UPDATE for.
const appendTx = db.transaction((type, data, node) => {
  const last = selectLastHash.get();
  const prev = last ? last.hash : '0'.repeat(64);
  const ts = Date.now();
  const norm = JSON.parse(JSON.stringify(data));
  const hash = hashOf(prev, type, norm, ts, node);
  const info = insertEntry.run(hash, prev, type, JSON.stringify(norm), ts, node);
  return { seq: info.lastInsertRowid, hash, prev, type, data: norm, ts, node };
});

async function append(type, data, node = NODE_ID) {
  const entry = appendTx(type, data, node);
  for (const fn of appendListeners) {
    try { fn(entry); } catch (e) { console.error('[ledger] onAppend listener error:', e.message); }
  }
  return entry;
}

function rowToEntry(r) {
  return { seq: r.seq, hash: r.hash, prev: r.prev, type: r.type, data: JSON.parse(r.data), ts: r.ts, node: r.node };
}

// Verifies continuity and hash correctness across the whole chain, returns {ok, errors, height}
async function verify() {
  const rows = db.prepare('SELECT seq, hash, prev, type, data, ts, node FROM ledger ORDER BY seq ASC').all();
  let prev = '0'.repeat(64);
  const errors = [];
  for (const r of rows) {
    const data = JSON.parse(r.data);
    const expect = hashOf(r.prev, r.type, data, r.ts, r.node);
    if (expect !== r.hash) errors.push({ seq: r.seq, reason: 'hash mismatch' });
    if (r.prev !== prev) errors.push({ seq: r.seq, reason: 'prev link broken' });
    prev = r.hash;
  }
  return { ok: errors.length === 0, errors, height: rows.length };
}

async function tail(limit = 50) {
  const rows = db.prepare('SELECT seq, hash, prev, type, data, ts, node FROM ledger ORDER BY seq DESC LIMIT ?').all(limit);
  return rows.reverse().map(rowToEntry);
}

async function byType(type, limit = 50) {
  const rows = db.prepare('SELECT seq, hash, prev, type, data, ts, node FROM ledger WHERE type=? ORDER BY seq DESC LIMIT ?').all(type, limit);
  return rows.reverse().map(rowToEntry);
}

// Computes the ledger's current Merkle root (pairwise-merges every entry hash)
async function root() {
  const rows = db.prepare('SELECT hash FROM ledger ORDER BY seq ASC').all();
  if (!rows.length) return '0'.repeat(64);
  let level = rows.map(r => r.hash);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = (i + 1 < level.length) ? level[i + 1] : level[i]; // odd one out pairs with itself
      next.push(crypto.createHash('sha256').update(left + right).digest('hex'));
    }
    level = next;
  }
  return level[0];
}

// Records an external anchoring event (e.g. a public-chain tx hash), linking the merkle root to that tx
async function anchor(chain, txHash, merkleRoot) {
  db.prepare('INSERT INTO anchors (chain, tx_hash, merkle_root, ts) VALUES (?,?,?,?)')
    .run(chain, txHash, merkleRoot, Date.now());
  return { chain, txHash, merkleRoot };
}

// n3: anchor a ledger snapshot + Merkle root to IPFS (free, immutable, self-hosted)
async function anchorToIpfs() {
  const merkle = await root();
  const rows = db.prepare('SELECT seq, hash, prev, type, data, ts, node FROM ledger ORDER BY seq ASC').all().map(rowToEntry);
  const snapshot = { merkle_root: merkle, height: rows.length, entries: rows, anchored_at: Date.now(), node: NODE_ID };
  const ipfs = (await import('ipfs-http-client')).create({ url: process.env.IPFS_URL || 'http://127.0.0.1:5001' });
  const res = await ipfs.add(JSON.stringify(snapshot));
  const cid = res.cid.toString();
  db.prepare('INSERT INTO anchors (chain, tx_hash, merkle_root, ts) VALUES (?,?,?,?)')
    .run('ipfs', cid, merkle, Date.now());
  return { chain: 'ipfs', cid, merkle_root: merkle, height: rows.length };
}

// Module 7: permanently anchor a ledger snapshot to Arweave (needs an AR wallet, independently verifiable off this node)
async function anchorToArweave() {
  let arweave, wallet;
  try {
    const Arweave = (await import('arweave')).default;
    arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
    if (process.env.AR_JWK) {
      wallet = JSON.parse(require('fs').readFileSync(process.env.AR_JWK, 'utf8'));
    } else if (process.env.AR_KEY) {
      wallet = JSON.parse(Buffer.from(process.env.AR_KEY, 'base64').toString('utf8'));
    } else {
      throw new Error('no AR_JWK/AR_KEY configured');
    }
  } catch (e) {
    throw new Error('arweave unavailable: ' + e.message);
  }
  const merkle = await root();
  const rows = db.prepare('SELECT seq, hash, prev, type, data, ts, node FROM ledger ORDER BY seq ASC').all().map(rowToEntry);
  const snapshot = { protocol: 'moye-net-ledger', merkle_root: merkle, height: rows.length, entries: rows, anchored_at: Date.now(), node: NODE_ID };
  const tx = await arweave.createTransaction({ data: JSON.stringify(snapshot) }, wallet);
  tx.addTag('App-Name', 'moye-net');
  tx.addTag('Type', 'ledger-anchor');
  tx.addTag('Merkle-Root', merkle);
  await arweave.transactions.sign(tx, wallet);
  const res = await arweave.transactions.post(tx);
  if (res.status !== 200 && res.status !== 202) throw new Error('arweave post failed: ' + res.status);
  const txid = tx.id;
  db.prepare('INSERT INTO anchors (chain, tx_hash, merkle_root, ts) VALUES (?,?,?,?)')
    .run('arweave', txid, merkle, Date.now());
  return { chain: 'arweave', txid, merkle_root: merkle, height: rows.length, url: `https://arweave.net/${txid}` };
}

// ADR-0006 (distribution independence): record a source-code release's IPFS CID on the ledger, so
// the project can distribute itself off its OWN network -- if every git forge (GitHub included) is
// unreachable or censored, any node/agent that still has the ledger can recover the exact source
// tree that produced a given commit, independent of any single hosting platform. This only records
// a pointer (cid + hashes); the actual upload happens in scripts/publish-source.js, which calls this.
async function recordSourceRelease({ version, git_commit, tarball_cid, sha256, size_bytes, arweave_tx }) {
  if (!tarball_cid || !sha256) throw new Error('tarball_cid and sha256 required');
  return append('source.release', {
    version: version || null, git_commit: git_commit || null,
    tarball_cid, sha256, size_bytes: size_bytes || null, arweave_tx: arweave_tx || null,
    ts: Date.now(),
  });
}
// Latest recorded release (byType already sorts ascending then we take the tail)
async function latestSourceRelease() {
  const rows = await byType('source.release', 1);
  return rows.length ? rows[rows.length - 1] : null;
}

module.exports = { db, append, onAppend, verify, tail, byType, root, anchor, anchorToIpfs, anchorToArweave, recordSourceRelease, latestSourceRelease, NODE_ID, hashOf };
