#!/usr/bin/env node
'use strict';
/**
 * moye-indexer — optional L2 AppView (ADR-0012 P2-5).
 *
 * Subscribes to a node's firehose NDJSON, builds a local SQLite query index, serves
 * POST /search. Results are convenience-only: each hit can be re-verified against L0
 * (GET {l0}/api/agents/:id). An indexer lying or dying must not be trusted as authority.
 *
 * Estimated tunables (no real load data as of 2026-08-06 — P2-2 skipped):
 *   INDEXER_PORT              default 3200
 *   INDEXER_DB                default ~/.moye-mcp/indexer.db
 *   INDEXER_FIREHOSE          default https://moye.ai/a2a/api/stream.ndjson
 *   INDEXER_L0                L0 base for re-verify (default: derived from firehose origin+/a2a)
 *   INDEXER_TYPES             comma allowlist (default agent.register,agent.update)
 *   INDEXER_REVERIFY          1=drop hits that fail L0 GET (default 1)
 *   INDEXER_CATCHUP_BATCH     max ledger.tail-equivalent pages if catch-up URL set (est. 500)
 *   INDEXER_REFRESH_MS        full resync interval from L0 /api/agents cursor walk (est. 300000)
 *
 * Usage:
 *   node moye-indexer.js
 *   curl -sS -X POST localhost:3200/search -H 'content-type: application/json' -d '{"q":"deploy"}'
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');
const requireFromA2a = createRequire(path.join(__dirname, '..', 'package.json'));
const Database = requireFromA2a('better-sqlite3');

const PORT = Math.max(1, parseInt(process.env.INDEXER_PORT || '3200', 10));
const DB_PATH = process.env.INDEXER_DB || path.join(os.homedir(), '.moye-mcp', 'indexer.db');
const FIREHOSE = process.env.INDEXER_FIREHOSE || 'https://moye.ai/a2a/api/stream.ndjson';
const TYPES = new Set(
  (process.env.INDEXER_TYPES || 'agent.register,agent.update')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
const REVERIFY = process.env.INDEXER_REVERIFY !== '0';
// estimated, no real load data as of 2026-08-06
const CATCHUP_BATCH = Math.max(50, parseInt(process.env.INDEXER_CATCHUP_BATCH || '500', 10));
const REFRESH_MS = Math.max(0, parseInt(process.env.INDEXER_REFRESH_MS || '300000', 10));
const PAGE_SIZE = Math.max(10, parseInt(process.env.INDEXER_DIR_PAGE_SIZE || '50', 10)); // estimated

function deriveL0(firehoseUrl) {
  if (process.env.INDEXER_L0) return process.env.INDEXER_L0.replace(/\/$/, '');
  try {
    const u = new URL(firehoseUrl);
    // .../a2a/api/stream.ndjson → .../a2a
    const idx = u.pathname.indexOf('/api/');
    if (idx >= 0) return u.origin + u.pathname.slice(0, idx);
    return u.origin + '/a2a';
  } catch {
    return 'https://moye.ai/a2a';
  }
}
const L0 = deriveL0(FIREHOSE);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new Database(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT,
  did TEXT,
  description TEXT,
  capabilities TEXT,
  home_node TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS agents_did ON agents(did);
`);

const upsert = db.prepare(`
INSERT INTO agents (id, name, did, description, capabilities, home_node, updated_at)
VALUES (@id, @name, @did, @description, @capabilities, @home_node, @updated_at)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name, did=excluded.did, description=excluded.description,
  capabilities=excluded.capabilities, home_node=excluded.home_node, updated_at=excluded.updated_at
`);

function indexAgent(a) {
  if (!a || !a.id) return;
  upsert.run({
    id: a.id,
    name: a.name || '',
    did: a.did || '',
    description: a.description || '',
    capabilities: JSON.stringify(a.capabilities || []),
    home_node: a.home_node || '',
    updated_at: Date.now(),
  });
}

function searchLocal({ q, capability, limit }) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  let rows = db.prepare('SELECT * FROM agents ORDER BY updated_at DESC LIMIT 5000').all();
  if (capability) {
    rows = rows.filter((r) => {
      let caps = [];
      try { caps = JSON.parse(r.capabilities || '[]'); } catch { /* */ }
      return caps.some((c) => (typeof c === 'string' ? c : c && c.name) === capability);
    });
  }
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => {
      const hay = `${r.name} ${r.description} ${r.did} ${r.id} ${r.capabilities}`.toLowerCase();
      return hay.includes(needle);
    });
  }
  return rows.slice(0, lim).map((r) => {
    let capabilities = [];
    try { capabilities = JSON.parse(r.capabilities || '[]'); } catch { /* */ }
    return {
      id: r.id, name: r.name, did: r.did || null, description: r.description || '',
      capabilities, home_node: r.home_node || null, updated_at: r.updated_at,
      source: 'indexer',
    };
  });
}

async function reverify(agents) {
  if (!REVERIFY) return agents.map((a) => ({ ...a, verified: null }));
  const out = [];
  for (const a of agents) {
    try {
      const res = await fetch(`${L0}/api/agents/${encodeURIComponent(a.id)}`);
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.agent && j.agent.id === a.id) {
        out.push({ ...a, verified: true, l0: { name: j.agent.name, did: j.agent.did || null } });
      }
    } catch { /* drop unverifiable */ }
  }
  return out;
}

async function catchupFromDirectory() {
  // Synthetic-friendly: walk L0 directory with cursor pages (PAGE_SIZE estimated).
  let cursor = null;
  let n = 0;
  for (let page = 0; page < Math.ceil(CATCHUP_BATCH / PAGE_SIZE); page++) {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${L0}/api/agents?${qs}`);
    if (!res.ok) break;
    const j = await res.json();
    for (const a of j.agents || []) { indexAgent(a); n++; }
    cursor = j.next_cursor || null;
    if (!cursor) break;
  }
  return n;
}

function ingestEvent(ev) {
  if (!ev || !TYPES.has(ev.type)) return;
  const d = ev.data || {};
  // agent.register / agent.update shapes vary; accept id+name at top level or nested
  const a = d.id ? d : (d.agent || null);
  if (a && a.id) indexAgent(a);
  else if (d.id && (d.name || d.did)) indexAgent(d);
}

async function followFirehose() {
  for (;;) {
    try {
      const types = [...TYPES].join(',');
      const url = FIREHOSE.includes('?') ? `${FIREHOSE}&types=${types}` : `${FIREHOSE}?types=${types}`;
      const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
      if (!res.ok || !res.body) throw new Error('firehose HTTP ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { ingestEvent(JSON.parse(line)); } catch { /* */ }
        }
      }
    } catch (e) {
      console.error('[indexer] firehose error:', e.message || e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const count = db.prepare('SELECT COUNT(*) AS n FROM agents').get().n;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, role: 'indexer', agents: count, l0: L0, firehose: FIREHOSE, reverify: REVERIFY,
      note: 'L2 convenience index — re-verify against L0; not authoritative',
    }));
  }
  if (req.method === 'POST' && (req.url === '/search' || req.url === '/api/search')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let q = {};
    try { q = JSON.parse(body || '{}'); } catch { /* */ }
    let agents = searchLocal(q);
    agents = await reverify(agents);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true, total: agents.length, agents,
      trust: 're-verify against L0; indexer may omit or delay results',
    }));
  }
  res.writeHead(404).end('not found');
});

(async () => {
  try {
    const n = await catchupFromDirectory();
    console.log(`[indexer] catch-up indexed ${n} agents from L0 directory (PAGE_SIZE=${PAGE_SIZE} estimated)`);
  } catch (e) {
    console.log('[indexer] catch-up skipped:', e.message || e);
  }
  server.listen(PORT, () => {
    console.log(`[indexer] listening :${PORT} db=${DB_PATH} l0=${L0}`);
  });
  if (REFRESH_MS > 0) {
    setInterval(() => {
      catchupFromDirectory().then((n) => console.log(`[indexer] refresh +${n}`)).catch(() => {});
    }, REFRESH_MS);
  }
  followFirehose();
})();
