'use strict';
// ADR-0031 / M2: room-as-MCP-server — Streamable HTTP initialize/tools + private E2E gate.
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3156;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function mcp(agent, roomId, method, params, id = 1) {
  const body = { jsonrpc: '2.0', id, method };
  if (params !== undefined) body.params = params;
  const headers = {
    'Content-Type': 'application/json',
    ...agent._headers(agent._didHeaders(body)),
  };
  const res = await fetch(`${BASE}/mcp/rooms/${roomId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

function parseTool(rpc) {
  assert(rpc.result && Array.isArray(rpc.result.content), 'tools/call missing content');
  const t = rpc.result.content[0] && rpc.result.content[0].text;
  assert(t, 'empty tool text');
  if (rpc.result.isError) return { error: t };
  try { return { data: JSON.parse(t) }; } catch { return { data: t }; }
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'adr0031-room-mcp',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'adr0031-room-mcp-smoke.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* */ }
      await sleep(100);
      if (i === 49) throw new Error('boot failed: ' + boot.slice(-400));
    }

    const agent = new Agent({ name: 'm2-mcp', capabilities: ['room'], baseUrl: BASE });
    agent.generateIdentity();
    await agent.register();

    // Feature + discovery surface
    const net = await (await fetch(BASE + '/.well-known/moye-net')).json();
    assert((net.features || []).includes('room-mcp'), 'feature room-mcp missing');
    assert(net.join && net.join.room_mcp, 'join.room_mcp missing');

    // --- Public room ---
    const pub = await agent.createRoom('m2-public');
    const pubId = pub.room_id;

    const disco = await (await fetch(BASE + `/mcp/rooms/${pubId}`, {
      headers: agent._headers(agent._didHeadersForGet(`/mcp/rooms/${pubId}`)),
    })).json();
    assert(disco.transport === 'streamable-http', 'discovery transport');
    assert((disco.tools || []).includes('room_send'), 'discovery tools');

    let r = await mcp(agent, pubId, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'adr0031-smoke', version: '0.0.1' },
    });
    assert(r.status === 200 && r.json.result, 'initialize failed: ' + JSON.stringify(r.json));
    assert(r.json.result.protocolVersion, 'protocolVersion');
    assert(r.json.result.serverInfo && r.json.result.serverInfo.name.includes(pubId), 'serverInfo.name');

    r = await mcp(agent, pubId, 'tools/list', {}, 2);
    const names = (r.json.result.tools || []).map((t) => t.name).sort();
    // The ADR-0031 baseline set must all still be present. `room_awaiting` was added later by
    // M3 (ADR-0033 §3) to expose outstanding asks as MCP MRTR, so this asserts the baseline is
    // intact rather than pinning an exact list -- but it still fails loudly if the surface grows
    // beyond the room verb table, which ADR-0031 §2.2 deliberately scopes it to.
    const baseline = ['room_changes', 'room_messages', 'room_resolve', 'room_send', 'room_watch'];
    const allowed = new Set([...baseline, 'room_awaiting', 'room_catchup']);
    for (const want of baseline) {
      assert(names.includes(want), `tools/list missing ${want}: ` + names.join(','));
    }
    const unexpected = names.filter((n) => !allowed.has(n));
    assert(unexpected.length === 0, 'unexpected tools beyond the room verb table: ' + unexpected.join(','));

    r = await mcp(agent, pubId, 'tools/call', {
      name: 'room_send',
      arguments: { content: 'hello-from-mcp' },
    }, 3);
    let out = parseTool(r.json);
    assert(out.data && out.data.message_id, 'room_send id: ' + JSON.stringify(out));
    const mid = out.data.message_id;

    r = await mcp(agent, pubId, 'tools/call', {
      name: 'room_messages',
      arguments: { limit: 10 },
    }, 4);
    out = parseTool(r.json);
    assert((out.data.messages || []).some((m) => m.id === mid && m.content === 'hello-from-mcp'), 'messages roundtrip');

    r = await mcp(agent, pubId, 'tools/call', {
      name: 'room_changes',
      arguments: { since: 0 },
    }, 5);
    out = parseTool(r.json);
    assert(out.data.new_messages >= 1, 'changes');

    // ask + resolve via MCP
    r = await mcp(agent, pubId, 'tools/call', {
      name: 'room_send',
      arguments: { content: 'need-answer', type: 'ask', awaiting: agent.agentId },
    }, 6);
    out = parseTool(r.json);
    const askId = out.data.message_id;
    r = await mcp(agent, pubId, 'tools/call', {
      name: 'room_resolve',
      arguments: { ref: askId, content: 'here-is-answer' },
    }, 7);
    out = parseTool(r.json);
    assert(out.data && out.data.message_id, 'resolve');

    // room_watch: post then wait
    const sinceWatch = Date.now();
    setTimeout(async () => {
      await mcp(agent, pubId, 'tools/call', {
        name: 'room_send',
        arguments: { content: 'watch-ping' },
      }, 90).catch(() => {});
    }, 200);
    r = await mcp(agent, pubId, 'tools/call', {
      name: 'room_watch',
      arguments: { since: sinceWatch, timeout_ms: 5000 },
    }, 8);
    out = parseTool(r.json);
    assert(out.data && out.data.message && out.data.message.content === 'watch-ping', 'watch: ' + JSON.stringify(out));

    // --- Private room: plaintext rejected; ciphertext stored undecrypted ---
    const priv = await agent.createRoom('m2-private', { visibility: 'private' });
    const privId = priv.room_id;
    assert(priv.secret, 'private secret');

    r = await mcp(agent, privId, 'tools/call', {
      name: 'room_send',
      arguments: { content: 'this-is-plaintext', encrypted: false },
    }, 10);
    out = parseTool(r.json);
    assert(out.error && /encrypted:true/.test(out.error), 'plaintext must fail: ' + JSON.stringify(out));

    // Encrypt via SDK helpers (same room_key as HTTP path)
    const key = agent._roomKey(priv.secret, privId);
    const cipher = agent._encryptForRoom(key, 'secret-hello');
    r = await mcp(agent, privId, 'tools/call', {
      name: 'room_send',
      arguments: { content: cipher, encrypted: true },
    }, 11);
    out = parseTool(r.json);
    assert(out.data && out.data.message_id && out.data.encrypted === true, 'cipher send');

    r = await mcp(agent, privId, 'tools/call', {
      name: 'room_messages',
      arguments: { limit: 5 },
    }, 12);
    out = parseTool(r.json);
    const stored = (out.data.messages || []).find((m) => m.content === cipher);
    assert(stored && stored.encrypted === true, 'stored ciphertext');
    assert(!(out.data.messages || []).some((m) => m.content === 'secret-hello'), 'server must not store plaintext');
    // Client-side decrypt still works with room_key
    const plain = agent._decryptFromRoom(key, stored.content);
    assert(plain === 'secret-hello', 'client decrypt');

    // Non-member cannot use private MCP
    const stranger = new Agent({ name: 'm2-stranger', capabilities: [], baseUrl: BASE });
    stranger.generateIdentity();
    await stranger.register();
    r = await mcp(stranger, privId, 'tools/list', {}, 13);
    assert(r.status === 403, 'stranger tools/list should 403, got ' + r.status);

    console.log('ALL_OK');
  } catch (e) {
    console.error('FAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { child.kill('SIGKILL'); } catch { /* */ }
  }
})();
