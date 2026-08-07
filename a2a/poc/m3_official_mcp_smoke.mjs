/**
 * M3 smoke with official @modelcontextprotocol/sdk Streamable HTTP client.
 * Run: node poc/m3_official_mcp_smoke.mjs
 */
import { spawn } from 'child_process';
import http from 'http';
import { generateKeyPairSync } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SMOKE_PORT || 3156);
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* */ }
        resolve({ status: res.statusCode, json: j, body: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function register(name) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const r = await req('POST', '/api/agents', {
    name, capabilities: ['test'], pubkey: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  if (!r.json?.agent_id) throw new Error('register failed: ' + r.body);
  return r.json;
}

let fails = 0;
function check(name, cond) {
  console.log(cond ? 'OK' : 'FAIL', name);
  if (!cond) fails++;
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    ALLOW_DEFAULT_FED_SECRET: '1',
    NODE_ID: 'm3-official-' + Date.now(),
    PORT: String(PORT),
    DB_FILE: path.join(__dirname, '..', 'data', 'smoke-m3-official-' + Date.now() + '.db'),
    IPFS_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = false;
child.stdout.on('data', (d) => { if (d.toString().includes(`on :${PORT}`)) ready = true; });
for (let i = 0; i < 100 && !ready; i++) await sleep(50);
if (!ready) { console.error('server failed'); child.kill(); process.exit(1); }

try {
  const a = await register('m3a-' + Date.now());
  const b = await register('m3b-' + Date.now());
  const room = await req('POST', '/api/rooms', { name: 'm3-official', visibility: 'public' }, {
    Authorization: 'Bearer ' + a.token,
  });
  const roomId = room.json.room_id;
  await req('POST', `/api/rooms/${roomId}/join`, { ts: Date.now() }, { Authorization: 'Bearer ' + b.token });

  const ask = await req('POST', `/api/rooms/${roomId}/messages`, {
    content: 'official mcp please answer', type: 'ask', awaiting: b.agent_id, ts: Date.now(),
  }, { Authorization: 'Bearer ' + a.token });
  check('ask', !!ask.json?.message_id);

  const url = new URL(`/mcp/rooms/${roomId}`, BASE);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer ' + b.token } },
  });
  const client = new Client({ name: 'm3-official-smoke', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  check('listTools', Array.isArray(tools.tools) && tools.tools.some((t) => t.name === 'room_awaiting'));

  const call = await client.callTool({ name: 'room_awaiting', arguments: {} });
  const isInputRequired = call?.resultType === 'input_required'
    || (call?.content && JSON.stringify(call).includes('input_required'))
    || (Array.isArray(call?.inputRequests) && call.inputRequests.length > 0)
    || (call?.structuredContent && call.structuredContent.resultType === 'input_required');
  // Official SDK may strip unknown fields — also accept content text carrying moye_ask_id
  const text = JSON.stringify(call);
  check('MRTR or ask surfaced', isInputRequired || text.includes(ask.json.message_id) || text.includes('moye_ask_id'));

  await client.callTool({
    name: 'room_awaiting',
    arguments: {
      inputResponses: { [ask.json.message_id]: { content: 'answered via official sdk' } },
    },
  });
  const open = await req('GET', `/api/rooms/${roomId}/awaiting/${b.agent_id}`);
  const still = (open.json?.awaiting || []).some((m) => m.id === ask.json.message_id);
  check('resolved', !still);

  await client.close().catch(() => {});
} catch (e) {
  console.error('official MCP path error:', e);
  fails++;
} finally {
  child.kill('SIGTERM');
  try { child.kill('SIGKILL'); } catch { /* */ }
}

console.log(fails ? 'SOME_FAIL ' + fails : 'ALL_PASS');
process.exit(fails ? 1 : 0);
