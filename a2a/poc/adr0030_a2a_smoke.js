'use strict';
// ADR-0030 / M1: A2A bridge completion — 8-state lifecycle + tasks/resubscribe SSE + Agent Card.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3155;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function collectSse(urlPath, { untilState, timeoutMs = 4000, trigger } = {}) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(BASE + urlPath, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        // Parse simple SSE: event + data lines
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const block of parts) {
          const lines = block.split('\n');
          let ev = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const j = JSON.parse(data);
            events.push({ event: ev, data: j });
            const st = j.status && j.status.state;
            if (untilState && st === untilState) {
              req.destroy();
              resolve({ status: res.statusCode, events });
            }
          } catch { /* */ }
        }
      });
    });
    req.on('error', () => resolve({ status: 0, events }));
    if (trigger) setTimeout(trigger, 120);
    setTimeout(() => { req.destroy(); resolve({ status: 0, events }); }, timeoutMs);
  });
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'adr0030-a2a',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'adr0030-a2a-smoke.db'),
      ENABLE_FIREHOSE: '1',
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

    const agent = new Agent({ name: 'm1-worker', capabilities: ['echo'], baseUrl: BASE });
    agent.generateIdentity();
    await agent.register();

    const cardRes = await fetch(BASE + `/api/agents/${agent.agentId}/agent-card`);
    const card = await cardRes.json();
    assert(card.capabilities && card.capabilities.streaming === true, 'Agent Card streaming should be true');
    console.log('CARD_STREAMING_OK');

    const sendRes = await fetch(BASE + `/api/agents/${agent.agentId}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/send',
        params: { message: { parts: [{ type: 'text', text: 'need help' }] } },
      }),
    });
    const sendBody = await sendRes.json();
    const taskId = sendBody.result && sendBody.result.id;
    assert(taskId, 'message/send missing task id: ' + JSON.stringify(sendBody));
    assert(sendBody.result.streamUrl, 'streamUrl missing on submit');
    console.log('SUBMIT_OK', taskId);

    const streamPath = `/api/agents/${agent.agentId}/a2a/stream?task_id=${encodeURIComponent(taskId)}`;

    async function a2aResult(state, parts) {
      const payload = { task_id: taskId, state, parts, ts: Date.now() };
      const res = await fetch(BASE + `/api/agents/${agent.agentId}/a2a-result`, {
        method: 'POST',
        headers: agent._headers(agent._didHeaders(payload)),
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok || j.success === false) throw new Error(state + ': ' + JSON.stringify(j));
      return j;
    }

    const sse = await collectSse(streamPath, {
      untilState: 'completed',
      timeoutMs: 5000,
      trigger: async () => {
        await a2aResult('working', [{ type: 'text', text: 'started' }]);
        await a2aResult('input_required', [{ type: 'text', text: 'need more' }]);
        await a2aResult('completed', [{ type: 'text', text: 'done' }]);
      },
    });
    const states = sse.events.filter((e) => e.event === 'task').map((e) => e.data.status && e.data.status.state);
    assert(states.includes('working') || states.includes('input_required') || states.includes('completed'),
      'SSE missed task events: ' + JSON.stringify(states));
    assert(states.includes('completed'), 'SSE never saw completed: ' + JSON.stringify(states));
    console.log('SSE_LIFECYCLE_OK', states.join('->'));

    // rejected path (distinct from failed)
    const send2 = await fetch(BASE + `/api/agents/${agent.agentId}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'message/send',
        params: { message: { parts: [{ type: 'text', text: 'nope' }] } },
      }),
    });
    const t2 = (await send2.json()).result.id;
    {
      const payload = { task_id: t2, state: 'rejected', parts: [{ type: 'text', text: 'not for me' }], ts: Date.now() };
      const res = await fetch(BASE + `/api/agents/${agent.agentId}/a2a-result`, {
        method: 'POST',
        headers: agent._headers(agent._didHeaders(payload)),
        body: JSON.stringify(payload),
      });
      const rej = await res.json();
      assert(res.ok && rej.state === 'rejected', 'rejected failed: ' + JSON.stringify(rej));
    }
    const get2 = await fetch(BASE + `/api/agents/${agent.agentId}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: t2 } }),
    });
    const g2 = await get2.json();
    assert(g2.result.status.state === 'rejected', 'tasks/get rejected');
    console.log('REJECTED_OK');

    // terminal lock
    {
      const payload = { task_id: t2, state: 'completed', parts: [], ts: Date.now() };
      const again = await fetch(BASE + `/api/agents/${agent.agentId}/a2a-result`, {
        method: 'POST',
        headers: agent._headers(agent._didHeaders(payload)),
        body: JSON.stringify(payload),
      });
      const j = await again.json();
      assert(!again.ok || j.success === false, 'terminal state should reject further updates');
    }
    console.log('TERMINAL_LOCK_OK');

    // tasks/resubscribe returns streamUrl without Accept
    const rs = await fetch(BASE + `/api/agents/${agent.agentId}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tasks/resubscribe', params: { id: taskId } }),
    });
    const rsBody = await rs.json();
    assert(rsBody.result && rsBody.result.streamUrl, 'resubscribe streamUrl missing');
    console.log('RESUBSCRIBE_URL_OK');

    console.log('ALL_OK');
  } finally {
    try { child.kill(); } catch { /* */ }
  }
})().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
