'use strict';
/**
 * ADR-0031 + ADR-0033 M3/M4/M5: room-as-MCP-server (Streamable HTTP).
 * Dual-version: legacy initialize/ping kept; 2026-07-28 adds server/discover, resultType,
 * ttlMs/cacheScope, Mcp-Method/Mcp-Name headers, MRTR input_required ↔ room ask/resolve.
 * Extension namespace: ai.moye/room
 */
const crypto = require('crypto');
const roomAwaiting = require('./room_awaiting');

const PROTOCOL_VERSION_LEGACY = '2025-03-26';
const PROTOCOL_VERSION_STATELESS = '2026-07-28';
const PROTOCOL_VERSION = PROTOCOL_VERSION_STATELESS;
const MOYE_ROOM_EXTENSION = 'ai.moye/room';
// estimated list cache TTL — no real MCP client load data as of 2026-08-07
const TOOLS_LIST_TTL_MS = Math.max(1000, parseInt(process.env.MCP_TOOLS_LIST_TTL_MS || '30000', 10));

const ROOM_MESSAGE_TYPES = new Set([
  'ask', 'resolve', 'task-broadcast', 'task-claim', 'task-accept',
]);

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}
function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

function withResultType(payload, resultType) {
  return { resultType: resultType || 'complete', ...payload };
}

function toolComplete(obj) {
  return withResultType({
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  }, 'complete');
}

function toolError(msg) {
  return withResultType({
    content: [{ type: 'text', text: msg }],
    isError: true,
  }, 'complete');
}

/** M3: express an open ask as MCP MRTR input_required. Multi-target asks degrade: one inputRequest
 *  for the calling client when they are among targets; extension metadata carries full N-of-M. */
function askAsInputRequired(ask, me) {
  const targets = roomAwaiting.normalizeAwaitingList(ask.awaiting) || [];
  const multi = Array.isArray(ask.awaiting);
  const concernsMe = !multi
    || targets.some((t) => t === me.id || t === me.did)
    || (ask.awaiting_capability && roomAwaiting.agentHasCapability(me, ask.awaiting_capability));
  const inputRequests = concernsMe ? [{
    id: ask.id,
    description: typeof ask.content === 'string' ? ask.content.slice(0, 2000) : 'Room ask awaiting your response',
    schema: { type: 'object', properties: { content: { type: 'string' }, encrypted: { type: 'boolean' } }, required: ['content'] },
  }] : [];
  return withResultType({
    content: [{
      type: 'text',
      text: JSON.stringify({
        moye_ask_id: ask.id,
        awaiting: ask.awaiting,
        awaiting_remaining: ask.awaiting_remaining || null,
        awaiting_mode: ask.awaiting_mode || (multi ? 'n-of-m' : 'single'),
        note: multi
          ? 'Multi-target ask (N-of-M). MCP MRTR exposes one inputRequest for you; other targets resolve independently via room_resolve / inputResponses.'
          : 'Respond by retrying tools/call with inputResponses, or call room_resolve.',
      }, null, 2),
    }],
    inputRequests,
    _meta: {
      [MOYE_ROOM_EXTENSION]: {
        ask_id: ask.id,
        multi_target: multi,
        awaiting: ask.awaiting,
        awaiting_remaining: ask.awaiting_remaining || null,
        awaiting_capability: ask.awaiting_capability || null,
      },
    },
  }, 'input_required');
}

function toolsList(roomId) {
  const tools = [
    {
      name: 'room_send',
      description: `Post a message to MOYE room ${roomId}. Private rooms: encrypt under room_key and set encrypted:true.`,
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          encrypted: { type: 'boolean' },
          type: { type: 'string' },
          ref: { type: 'string' },
          awaiting: { description: 'agent id/did or string[] (R10 multi-target)' },
          awaiting_capability: { type: 'string' },
          inputResponses: { description: 'MRTR retry: map ask id → { content, encrypted? }' },
        },
        required: ['content'],
      },
    },
    {
      name: 'room_messages',
      description: `Read recent messages from room ${roomId} (wire content; decrypt locally if private).`,
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    },
    {
      name: 'room_changes',
      description: `Catch up on room ${roomId} since a ms cursor.`,
      inputSchema: { type: 'object', properties: { since: { type: 'number' } }, required: ['since'] },
    },
    {
      name: 'room_watch',
      description: `Wait for the next message in room ${roomId} after since. Every result carries a `
        + `"cursor" -- persist it and pass it back as "since" on the next call. Omitting "since" `
        + `starts from now and silently skips anything posted while you were away.`,
      inputSchema: {
        type: 'object',
        properties: { since: { type: 'number' }, timeout_ms: { type: 'number' } },
      },
    },
    {
      name: 'room_resolve',
      description: `Resolve an open ask (or pass inputResponses for MRTR).`,
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          content: { type: 'string' },
          encrypted: { type: 'boolean' },
          inputResponses: { description: 'MRTR: { "<ask_id>": { content, encrypted? } }' },
        },
      },
    },
    {
      name: 'room_awaiting',
      description: `List open asks that still concern the authenticated agent in this room (MRTR-friendly).`,
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  // Deterministic order for client caching (2026-07-28 SHOULD).
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    resultType: 'complete',
    ttlMs: TOOLS_LIST_TTL_MS,
    cacheScope: 'session',
    tools,
  };
}

function serverDiscover(room) {
  return {
    resultType: 'complete',
    protocolVersion: PROTOCOL_VERSION_STATELESS,
    serverInfo: {
      name: `moye-room-${room.id}`,
      version: '1.0.0',
      title: `MOYE room ${room.name || room.id}`,
    },
    capabilities: {
      tools: { listChanged: false },
      extensions: {
        [MOYE_ROOM_EXTENSION]: {
          version: '1.0.0',
          features: ['multi-target-ask', 'membership', 'e2e', 'ledger-anchor', 'mrtr-ask'],
        },
      },
    },
    instructions: room.visibility === 'private'
      ? 'Private room: encrypt under room_key; set encrypted:true. Server never decrypts.'
      : 'Public room MCP — tools scoped to this room_id. Dual-version: legacy initialize still accepted.',
  };
}

function clientProtocolVersion(req, body) {
  const meta = (body && body.params && body.params._meta)
    || (body && body._meta)
    || {};
  const fromMeta = meta['io.modelcontextprotocol/protocolVersion']
    || meta.protocolVersion;
  const header = (req.headers['mcp-protocol-version'] || '').toString();
  return fromMeta || header || null;
}

function mount(app, deps) {
  const {
    authAgent,
    store,
    isRoomMember,
    canReadRoom,
    roomChatKey,
    appendRoomMessage,
    newId,
    ledger,
    pushTo,
    ok,
    fail,
    materializeRoomAwaiting,
    MAX_CONTENT_LEN = 32768,
  } = deps;

  async function requireMember(req, res, roomId) {
    const room = store.getRoom(roomId);
    if (!room) {
      res.status(404).json(jsonRpcError(null, -32001, 'room not found'));
      return null;
    }
    const me = await authAgent(req);
    if (!me) {
      res.status(401).json(jsonRpcError(null, -32000, 'Bearer token or DID sig required'));
      return null;
    }
    if (room.visibility === 'private' && !isRoomMember(room, me.id)) {
      res.status(403).json(jsonRpcError(null, -32000, 'private room: membership required'));
      return null;
    }
    return { room, me };
  }

  async function postMessage(room, me, { content, encrypted, type, ref, awaiting, awaiting_capability }) {
    if (typeof content !== 'string' || !content) throw Object.assign(new Error('content required'), { status: 400 });
    if (content.length > MAX_CONTENT_LEN) throw Object.assign(new Error('content too large'), { status: 413 });
    if (room.visibility === 'private' && !isRoomMember(room, me.id)) {
      throw Object.assign(new Error('private room: membership required to post'), { status: 403 });
    }
    if (type !== undefined && type !== null && !ROOM_MESSAGE_TYPES.has(type)) {
      throw Object.assign(new Error('unknown type: ' + type), { status: 400 });
    }
    let askTargets = null;
    if (type === 'ask') {
      askTargets = roomAwaiting.normalizeAskTargets(awaiting, awaiting_capability);
      if (!askTargets.ok) throw Object.assign(new Error(askTargets.error), { status: askTargets.status || 400 });
    }
    if (type === 'resolve') {
      if (!ref) throw Object.assign(new Error('resolve requires ref'), { status: 400 });
      const prior = (store.getShared(roomChatKey(room.id)) || []).find((m) => m.id === ref);
      if (!prior || prior.type !== 'ask') {
        throw Object.assign(new Error('resolve ref must point at an ask message'), { status: 400 });
      }
    }
    if (type === 'task-accept' && me.id !== room.creator) {
      throw Object.assign(new Error('only the room creator can accept a claim'), { status: 403 });
    }
    if (room.visibility === 'private' && !encrypted) {
      throw Object.assign(new Error(
        'private room messages must set encrypted:true (encrypt under room_key before post)',
      ), { status: 400 });
    }
    const msg = {
      id: newId('rmsg'),
      from_agent: me.id,
      content,
      encrypted: !!encrypted,
      sender_sig: null,
      type: type || null,
      ref: ref || null,
      awaiting: type === 'ask' ? askTargets.awaiting : null,
      attachments: null,
      ts: Date.now(),
    };
    if (type === 'ask' && askTargets.awaiting_capability) msg.awaiting_capability = askTargets.awaiting_capability;
    await appendRoomMessage(room.id, msg);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    ledger.append('room.message', {
      room: room.id, from: me.id, content_hash: contentHash, type: msg.type || null,
      via: 'mcp', ts: msg.ts,
    }).catch(() => {});
    if (typeof pushTo === 'function') {
      for (const uid of (room.member_ids || [])) {
        if (uid !== me.id) pushTo(uid, { type: 'room_message', room_id: room.id, message: msg });
      }
    }
    return { message_id: msg.id, ts: msg.ts, encrypted: !!msg.encrypted };
  }

  async function applyInputResponses(room, me, inputResponses) {
    if (!inputResponses || typeof inputResponses !== 'object') return [];
    const out = [];
    for (const [askId, resp] of Object.entries(inputResponses)) {
      const r = resp && typeof resp === 'object' ? resp : { content: String(resp) };
      out.push(await postMessage(room, me, {
        content: r.content,
        encrypted: r.encrypted,
        type: 'resolve',
        ref: askId,
      }));
    }
    return out;
  }

  async function callTool(room, me, name, args) {
    const a = args && typeof args === 'object' ? args : {};

    // M3 MRTR: inputResponses on retry of room_send / room_resolve / room_awaiting
    if (a.inputResponses) {
      const resolved = await applyInputResponses(room, me, a.inputResponses);
      return toolComplete({ resolved, via: 'inputResponses' });
    }

    if (name === 'room_send') {
      const sent = await postMessage(room, me, a);
      return toolComplete(sent);
    }
    if (name === 'room_resolve') {
      return toolComplete(await postMessage(room, me, {
        content: a.content,
        encrypted: a.encrypted,
        type: 'resolve',
        ref: a.ref,
      }));
    }
    if (name === 'room_awaiting') {
      const open = (typeof materializeRoomAwaiting === 'function'
        ? materializeRoomAwaiting(room.id)
        : []).filter((ask) => roomAwaiting.askConcernsAgent(ask, me.id, me, room));
      if (open.length === 1) return askAsInputRequired(open[0], me);
      if (open.length > 1) {
        // Degrade: primary MRTR for first; list others in extension meta
        const primary = askAsInputRequired(open[0], me);
        primary._meta[MOYE_ROOM_EXTENSION].additional_asks = open.slice(1).map((x) => x.id);
        return primary;
      }
      return toolComplete({ room_id: room.id, awaiting: [] });
    }
    if (name === 'room_messages') {
      if (room.visibility === 'private' && !canReadRoom(room, me.id)) {
        return toolError('private room: membership required');
      }
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 50, 1), 200);
      const all = store.getShared(roomChatKey(room.id)) || [];
      return toolComplete({ room_id: room.id, messages: all.slice(-limit) });
    }
    if (name === 'room_changes') {
      if (room.visibility === 'private' && !canReadRoom(room, me.id)) {
        return toolError('private room: membership required');
      }
      const since = Number(a.since) || 0;
      const msgs = (store.getShared(roomChatKey(room.id)) || [])
        .filter((m) => (m.ts || 0) > since)
        .slice(0, 200);
      return toolComplete({ room_id: room.id, since, messages: msgs, new_messages: msgs.length });
    }
    if (name === 'room_watch') {
      if (room.visibility === 'private' && !canReadRoom(room, me.id)) {
        return toolError('private room: membership required');
      }
      let since = a.since != null ? Number(a.since) : Date.now();
      if (!Number.isFinite(since)) since = Date.now();
      const timeoutMs = Math.min(Math.max(parseInt(a.timeout_ms, 10) || 25000, 500), 55000);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = (store.getShared(roomChatKey(room.id)) || [])
          .filter((m) => (m.ts || 0) > since)
          .sort((x, y) => (x.ts - y.ts) || String(x.id).localeCompare(String(y.id)))[0];
        if (hit) {
          if (hit.type === 'ask' && roomAwaiting.askConcernsAgent(hit, me.id, me, room)) {
            return askAsInputRequired(hit, me);
          }
          // `cursor` is the value to pass as `since` next call. Returning it explicitly is what
          // lets a client resume exactly where it left off instead of re-defaulting to "now" --
          // MCP 2026-07-28 dropped stream resumability, so the cursor has to live with the client.
          return toolComplete({ room_id: room.id, message: hit, cursor: hit.ts || since });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      // Timing out with no cursor was a real gap: a client re-calling without `since` would
      // default to Date.now() and silently skip anything posted between the timeout returning
      // and the next call landing. Same failure shape as R14. Hand back the unchanged cursor.
      return toolComplete({ room_id: room.id, message: null, timed_out: true, cursor: since });
    }
    return toolError('unknown tool: ' + name);
  }

  async function handleRpc(req, res, room, me, body) {
    const { id, method, params } = body || {};
    // Allow method from Mcp-Method header (2026-07-28) when body omits it
    const headerMethod = (req.headers['mcp-method'] || '').toString().trim();
    const effectiveMethod = method || headerMethod;
    if ((!body || body.jsonrpc !== '2.0') && !headerMethod) {
      return res.status(400).json(jsonRpcError(id, -32600, 'invalid JSON-RPC 2.0 request'));
    }
    if (!effectiveMethod) {
      return res.status(400).json(jsonRpcError(id, -32600, 'method required (body.method or Mcp-Method header)'));
    }

    const pv = clientProtocolVersion(req, body);

    // M4: server/discover is MUST for 2026-07-28
    if (effectiveMethod === 'server/discover') {
      return res.json(jsonRpcResult(id, serverDiscover(room)));
    }

    // Legacy handshake — still accepted for old clients (dual-version).
    // Return the legacy protocolVersion here so official @modelcontextprotocol/sdk (pre-2026)
    // can connect; new clients use server/discover for 2026-07-28.
    if (effectiveMethod === 'initialize') {
      const disc = serverDiscover(room);
      const wantLegacy = !pv || String(pv).startsWith('2025') || String(pv).startsWith('2024');
      return res.json(jsonRpcResult(id, {
        protocolVersion: wantLegacy ? PROTOCOL_VERSION_LEGACY : PROTOCOL_VERSION_STATELESS,
        capabilities: disc.capabilities,
        serverInfo: disc.serverInfo,
        instructions: disc.instructions,
      }));
    }

    if (effectiveMethod === 'notifications/initialized' || effectiveMethod === 'initialized') {
      return res.status(202).end();
    }

    if (effectiveMethod === 'ping') {
      return res.json(jsonRpcResult(id, {}));
    }

    if (effectiveMethod === 'tools/list') {
      return res.json(jsonRpcResult(id, toolsList(room.id)));
    }

    if (effectiveMethod === 'tools/call') {
      const name = (params && params.name)
        || (req.headers['mcp-name'] || '').toString().trim();
      const args = (params && params.arguments) || {};
      if (!name) return res.status(400).json(jsonRpcError(id, -32602, 'tools/call requires params.name or Mcp-Name'));
      try {
        const result = await callTool(room, me, name, args);
        return res.json(jsonRpcResult(id, result));
      } catch (e) {
        const status = e.status || 500;
        if (status >= 400 && status < 500) {
          return res.json(jsonRpcResult(id, toolError(e.message || String(e))));
        }
        return res.status(500).json(jsonRpcError(id, -32603, e.message || String(e)));
      }
    }

    return res.status(400).json(jsonRpcError(id, -32601, 'method not found: ' + effectiveMethod));
  }

  app.get('/mcp/rooms/:id', async (req, res) => {
    const room = store.getRoom(req.params.id);
    if (!room) return fail(res, 404, 'room not found');
    const accept = (req.headers.accept || '').toString();
    if (accept.includes('text/event-stream')) {
      const ctx = await requireMember(req, res, req.params.id);
      if (!ctx) return;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.write(`event: moye.mcp.hello\ndata: ${JSON.stringify({
        ok: true, room_id: room.id, transport: 'streamable-http',
        post: `/mcp/rooms/${room.id}`,
        methods: ['server/discover', 'initialize', 'tools/list', 'tools/call', 'ping'],
        extension: MOYE_ROOM_EXTENSION,
      })}\n\n`);
      const ping = setInterval(() => {
        try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* */ }
      }, 15000);
      if (typeof ping.unref === 'function') ping.unref();
      req.on('close', () => clearInterval(ping));
      return;
    }
    ok(res, {
      protocol: 'mcp',
      transport: 'streamable-http',
      room_id: room.id,
      visibility: room.visibility || 'public',
      endpoint: `/mcp/rooms/${room.id}`,
      protocol_versions: [PROTOCOL_VERSION_LEGACY, PROTOCOL_VERSION_STATELESS],
      methods: ['server/discover', 'initialize', 'tools/list', 'tools/call', 'ping'],
      tools: toolsList(room.id).tools.map((t) => t.name),
      extension: MOYE_ROOM_EXTENSION,
      auth: ['bearer', 'did'],
      note: 'Dual-version MCP. Prefer server/discover (2026-07-28). Legacy initialize still accepted.',
    });
  });

  app.post('/mcp/rooms/:id', async (req, res) => {
    const ctx = await requireMember(req, res, req.params.id);
    if (!ctx) return;
    const { room, me } = ctx;
    const body = req.body;
    if (Array.isArray(body)) {
      return res.status(400).json(jsonRpcError(null, -32600, 'batch requests: send one JSON-RPC object per POST in this version'));
    }
    return handleRpc(req, res, room, me, body || {});
  });
}

module.exports = {
  mount,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_LEGACY,
  PROTOCOL_VERSION_STATELESS,
  MOYE_ROOM_EXTENSION,
  toolsList,
};
