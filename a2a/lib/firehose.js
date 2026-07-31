'use strict';
// ADR-0013 firehose: one live event stream, two wire formats (SSE + NDJSON).
// Events are ledger-derived metadata only — never message plaintext — so a public
// subscriber cannot use this as a content tap. Small/light nodes can disable with
// ENABLE_FIREHOSE=0; connection count is capped (FIREHOSE_MAX_CLIENTS, default 32).

const crypto = require('crypto');

const ENABLED = process.env.ENABLE_FIREHOSE !== '0';
const MAX_CLIENTS = Math.max(1, parseInt(process.env.FIREHOSE_MAX_CLIENTS || '32', 10));
const HEARTBEAT_MS = Math.max(5000, parseInt(process.env.FIREHOSE_HEARTBEAT_MS || '15000', 10));
// Soft backpressure: if a client can't keep up, drop events for them rather than
// buffering unboundedly into node3's 458 MB heap.
const MAX_BUFFERED = Math.max(8, parseInt(process.env.FIREHOSE_MAX_BUFFERED || '64', 10));

/** @type {Set<Client>} */
const clients = new Set();
let seq = 0;

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {import('http').ServerResponse} res
 * @property {'sse'|'ndjson'} format
 * @property {Set<string>|null} types  null = all
 * @property {string|null} did
 * @property {number} buffered
 * @property {boolean} dropped
 */

function info() {
  return {
    enabled: ENABLED,
    clients: clients.size,
    max_clients: MAX_CLIENTS,
    heartbeat_ms: HEARTBEAT_MS,
  };
}

function parseFilter(query) {
  const typesRaw = (query.types || '').toString().trim();
  const types = typesRaw
    ? new Set(typesRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const did = (query.did || '').toString().trim() || null;
  return { types, did };
}

/** Pull any DID-ish strings out of a ledger entry's data for ?did= filtering. */
function entryDids(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  for (const k of ['did', 'from', 'to', 'issuer', 'subject', 'agent', 'voter', 'target', 'writer']) {
    const v = data[k];
    if (typeof v === 'string' && v.startsWith('did:')) out.push(v);
  }
  // agent ids are not DIDs; also match when caller filters by agent id via the same param
  for (const k of ['id', 'from', 'to', 'agent', 'assignee', 'writer']) {
    const v = data[k];
    if (typeof v === 'string' && (v.startsWith('ag_') || v.startsWith('did:'))) out.push(v);
  }
  return out;
}

function matches(client, entry) {
  if (client.types && !client.types.has(entry.type)) return false;
  if (client.did) {
    const hay = entryDids(entry.data);
    if (!hay.includes(client.did) && entry.data && entry.data.id !== client.did) return false;
  }
  return true;
}

function writeClient(client, chunk) {
  if (client.dropped) return;
  if (client.buffered >= MAX_BUFFERED) {
    client.dropped = true;
    try { client.res.end(); } catch { /* already gone */ }
    clients.delete(client);
    return;
  }
  client.buffered += 1;
  const ok = client.res.write(chunk);
  if (ok) {
    client.buffered = Math.max(0, client.buffered - 1);
  } else {
    client.res.once('drain', () => {
      client.buffered = Math.max(0, client.buffered - 1);
    });
  }
}

function formatSse(entry, eventId) {
  const payload = JSON.stringify({
    type: entry.type,
    seq: entry.seq,
    hash: entry.hash,
    ts: entry.ts,
    node: entry.node,
    data: entry.data,
  });
  return `id: ${eventId}\nevent: ${entry.type}\ndata: ${payload}\n\n`;
}

function formatNdjson(entry) {
  return JSON.stringify({
    type: entry.type,
    seq: entry.seq,
    hash: entry.hash,
    ts: entry.ts,
    node: entry.node,
    data: entry.data,
  }) + '\n';
}

/** Called from ledger.onAppend with a full ledger entry. */
function publish(entry) {
  if (!ENABLED || !clients.size) return;
  const eventId = String(++seq);
  for (const client of [...clients]) {
    if (!matches(client, entry)) continue;
    const chunk = client.format === 'sse' ? formatSse(entry, eventId) : formatNdjson(entry);
    writeClient(client, chunk);
  }
}

/**
 * Attach a long-lived response. Returns false if the firehose is disabled or at capacity
 * (caller should 503 / 404 accordingly).
 */
function subscribe(res, { format = 'sse', query = {} } = {}) {
  if (!ENABLED) return { ok: false, reason: 'disabled' };
  if (clients.size >= MAX_CLIENTS) return { ok: false, reason: 'capacity' };

  const { types, did } = parseFilter(query);
  const client = {
    id: crypto.randomBytes(8).toString('hex'),
    res,
    format: format === 'ndjson' ? 'ndjson' : 'sse',
    types,
    did,
    buffered: 0,
    dropped: false,
  };

  // Disable proxy buffering (nginx / some CF paths) so events flush immediately.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (client.format === 'sse') {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  } else {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  }
  res.flushHeaders?.();

  clients.add(client);

  // Hello so the client knows the stream is live even before the next ledger write.
  if (client.format === 'sse') {
    writeClient(client, `: firehose connected node clients=${clients.size}\n\n`);
    writeClient(client, `event: firehose.hello\ndata: ${JSON.stringify({ ok: true, format: 'sse', filters: { types: types ? [...types] : null, did } })}\n\n`);
  } else {
    writeClient(client, JSON.stringify({ type: 'firehose.hello', ok: true, format: 'ndjson', filters: { types: types ? [...types] : null, did } }) + '\n');
  }

  const onClose = () => {
    clients.delete(client);
    clearInterval(heartbeat);
  };
  res.on('close', onClose);
  res.on('error', onClose);

  const heartbeat = setInterval(() => {
    if (!clients.has(client)) return;
    if (client.format === 'sse') writeClient(client, `: ping ${Date.now()}\n\n`);
    else writeClient(client, JSON.stringify({ type: 'firehose.ping', ts: Date.now() }) + '\n');
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return { ok: true, id: client.id };
}

module.exports = { publish, subscribe, info, ENABLED };
