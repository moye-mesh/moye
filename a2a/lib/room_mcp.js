'use strict';
/**
 * ADR-0031: room-as-MCP-server — Streamable HTTP MCP transport scoped to one room.
 * Coexists with a2a/mcp/server.js (stdio). Does not replace it.
 *
 * Endpoint: POST /mcp/rooms/:id  (JSON-RPC 2.0: initialize | tools/list | tools/call | ping)
 * Optional GET /mcp/rooms/:id    (SSE hello + keep-alive; notifications reserved)
 *
 * Tools (room verb subset only — no create/join):
 *   room_send | room_messages | room_changes | room_watch | room_resolve
 *
 * Auth: existing Bearer / DID (authAgent). Private rooms: membership required; plaintext
 * posts rejected (encrypted:true required) — server never decrypts.
 */
const crypto = require('crypto');
const roomAwaiting = require('./room_awaiting');

const PROTOCOL_VERSION = '2025-03-26';
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

function toolText(obj) {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  };
}

function toolError(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function toolsList(roomId) {
  return {
    tools: [
      {
        name: 'room_send',
        description: `Post a message to MOYE room ${roomId}. For private rooms you MUST encrypt under room_key client-side and set encrypted:true — the server never sees plaintext.`,
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Wire content (ciphertext for private rooms)' },
            encrypted: { type: 'boolean', description: 'Must be true for private rooms' },
            type: { type: 'string', description: 'ask|resolve|task-broadcast|task-claim|task-accept' },
            ref: { type: 'string' },
            awaiting: { description: 'agent id/did string, or string[] for multi-target (R10)' },
            awaiting_capability: { type: 'string', description: 'Capability name; first capable member resolve wins (R12)' },
          },
          required: ['content'],
        },
      },
      {
        name: 'room_messages',
        description: `Read recent messages from room ${roomId}. Returns stored wire content (ciphertext if private) — decrypt locally if you hold room_key.`,
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Max messages (default 50, max 200)' } },
        },
      },
      {
        name: 'room_changes',
        description: `Catch up on room ${roomId} since a cursor (ms epoch). Same as GET /api/rooms/:id/changes.`,
        inputSchema: {
          type: 'object',
          properties: { since: { type: 'number', description: 'ms epoch cursor' } },
          required: ['since'],
        },
      },
      {
        name: 'room_watch',
        description: `Block until a new message appears in room ${roomId} after since (or timeout). Returns the message or null.`,
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'number', description: 'ms epoch; default now' },
            timeout_ms: { type: 'number', description: 'Max wait (default 25000, max 55000)' },
          },
        },
      },
      {
        name: 'room_resolve',
        description: `Resolve an open ask in room ${roomId} (type=resolve + ref). Private rooms still require encrypted:true.`,
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'ask message id' },
            content: { type: 'string' },
            encrypted: { type: 'boolean' },
          },
          required: ['ref', 'content'],
        },
      },
    ],
  };
}

/**
 * @param {import('express').Express} app
 * @param {object} deps
 */
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
    // Public rooms: any authenticated agent may use MCP (same as HTTP post — membership optional).
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
    // Same E2E guarantee as POST /api/rooms/:id/messages — never accept plaintext in private rooms.
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

  async function callTool(room, me, name, args) {
    const a = args && typeof args === 'object' ? args : {};
    if (name === 'room_send') {
      return toolText(await postMessage(room, me, a));
    }
    if (name === 'room_resolve') {
      return toolText(await postMessage(room, me, {
        content: a.content,
        encrypted: a.encrypted,
        type: 'resolve',
        ref: a.ref,
      }));
    }
    if (name === 'room_messages') {
      if (room.visibility === 'private' && !canReadRoom(room, me.id)) {
        return toolError('private room: membership required');
      }
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 50, 1), 200);
      const all = store.getShared(roomChatKey(room.id)) || [];
      // Return wire messages as stored — no server-side decrypt.
      return toolText({ room_id: room.id, messages: all.slice(-limit) });
    }
    if (name === 'room_changes') {
      if (room.visibility === 'private' && !canReadRoom(room, me.id)) {
        return toolError('private room: membership required');
      }
      const since = Number(a.since) || 0;
      const msgs = (store.getShared(roomChatKey(room.id)) || [])
        .filter((m) => (m.ts || 0) > since)
        .slice(0, 200);
      return toolText({ room_id: room.id, since, messages: msgs, new_messages: msgs.length });
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
        if (hit) return toolText({ room_id: room.id, message: hit });
        await new Promise((r) => setTimeout(r, 400));
      }
      return toolText({ room_id: room.id, message: null, timed_out: true });
    }
    return toolError('unknown tool: ' + name);
  }

  async function handleRpc(req, res, room, me, body) {
    const { id, method, params } = body || {};
    if (body.jsonrpc !== '2.0' || !method) {
      return res.status(400).json(jsonRpcError(id, -32600, 'invalid JSON-RPC 2.0 request'));
    }

    if (method === 'initialize') {
      return res.json(jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: `moye-room-${room.id}`,
          version: '1.0.0',
          title: `MOYE room ${room.name || room.id}`,
        },
        instructions: room.visibility === 'private'
          ? 'Private room: encrypt message content under room_key before room_send/room_resolve; set encrypted:true. Server never decrypts.'
          : 'Public room MCP surface — tools are scoped to this room_id only.',
      }));
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return res.status(202).end();
    }

    if (method === 'ping') {
      return res.json(jsonRpcResult(id, {}));
    }

    if (method === 'tools/list') {
      return res.json(jsonRpcResult(id, toolsList(room.id)));
    }

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!name) return res.status(400).json(jsonRpcError(id, -32602, 'tools/call requires params.name'));
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

    return res.status(400).json(jsonRpcError(id, -32601, 'method not found: ' + method));
  }

  // Discovery: machine-readable pointer (not full MCP session).
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
      methods: ['initialize', 'tools/list', 'tools/call', 'ping'],
      tools: toolsList(room.id).tools.map((t) => t.name),
      auth: ['bearer', 'did'],
      note: 'POST JSON-RPC 2.0 to this path. Private rooms require membership + client-side E2E (encrypted:true).',
    });
  });

  app.post('/mcp/rooms/:id', async (req, res) => {
    const ctx = await requireMember(req, res, req.params.id);
    if (!ctx) return;
    const { room, me } = ctx;
    // Batch support (array of messages) — process sequentially, return last / array
    const body = req.body;
    if (Array.isArray(body)) {
      const out = [];
      for (const item of body) {
        // Collect via mock — simpler: only support single for v1
        out.push(item);
      }
      if (out.length !== 1) {
        return res.status(400).json(jsonRpcError(null, -32600, 'batch requests: send one JSON-RPC object per POST in this version'));
      }
    }
    return handleRpc(req, res, room, me, body);
  });
}

module.exports = { mount, PROTOCOL_VERSION, toolsList };
