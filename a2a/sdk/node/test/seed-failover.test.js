'use strict';
const http = require('http');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  Agent, DEFAULT_SEEDS, isLoopbackBase, isKnownPublicSeed,
} = require('../moye-agent-sdk.js');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

test('pickReachableBaseUrl skips a dead seed', async () => {
  const dead = await listen((req, res) => { res.writeHead(502); res.end('bad gateway'); });
  const live = await listen((req, res) => {
    if (req.url === '/health') return json(res, 200, { success: true, service: 'moye-a2a' });
    json(res, 404, { success: false, error: 'no' });
  });
  try {
    const url = await Agent.pickReachableBaseUrl([dead.base, live.base], { timeoutMs: 1000 });
    assert.equal(url, live.base);
  } finally {
    dead.server.close();
    live.server.close();
  }
});

test('ensureReachable uses bootstrap seeds from the live node', async () => {
  const peer = await listen((req, res) => {
    if (req.url === '/health') return json(res, 200, { success: true });
    json(res, 404, { success: false, error: 'no' });
  });
  const seed = await listen((req, res) => {
    if (req.url === '/health') return json(res, 200, { success: true });
    if (req.url === '/api/bootstrap/seeds') {
      return json(res, 200, { success: true, seeds: [{ id: 'peer', endpoint: peer.base }] });
    }
    json(res, 404, { success: false, error: 'no' });
  });
  try {
    const agent = new Agent({ name: 't', baseUrl: seed.base });
    const url = await agent.ensureReachable({ includeDefaults: false, timeoutMs: 1000, seeds: [seed.base] });
    assert.equal(url, seed.base);
    assert.ok(agent._seedList.includes(peer.base));
  } finally {
    seed.server.close();
    peer.server.close();
  }
});

test('_req failovers on 502 to the next seed', async () => {
  const live = await listen((req, res) => {
    if (req.url === '/health') return json(res, 200, { success: true });
    if (req.url === '/api/ledger/verify') return json(res, 200, { success: true, valid: true });
    json(res, 404, { success: false, error: 'no' });
  });
  const dead = await listen((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('nope');
  });
  try {
    const agent = new Agent({ name: 't', baseUrl: dead.base });
    agent._seedList = [dead.base, live.base];
    const r = await agent.ledgerVerify();
    assert.equal(r.valid, true);
    assert.equal(agent.baseUrl, live.base);
  } finally {
    dead.server.close();
    live.server.close();
  }
});

test('loopback URL is recognized and public seeds stay listed', () => {
  assert.equal(isLoopbackBase('http://127.0.0.1:9'), true);
  assert.equal(isLoopbackBase('https://moye.ai/a2a'), false);
  assert.equal(isKnownPublicSeed('https://moye.ai/a2a'), true);
  assert.equal(isKnownPublicSeed('https://example.com'), false);
  assert.ok(DEFAULT_SEEDS.includes('https://node2-origin.moye.ai'));
});

test('_req does not failover on home_unreachable 503', async () => {
  let hits = 0;
  const homeDown = await listen((req, res) => {
    hits++;
    json(res, 503, { success: false, error: 'home_unreachable', code: 'home_unreachable', home_node: 'node2', queued: true });
  });
  const live = await listen((req, res) => {
    if (req.url === '/health') return json(res, 200, { success: true });
    json(res, 200, { success: true, message_id: 'should-not-retry' });
  });
  try {
    const agent = new Agent({ name: 't', baseUrl: homeDown.base });
    agent.agentId = 'ag_from';
    agent.token = 'tok';
    agent._seedList = [homeDown.base, live.base];
    await assert.rejects(() => agent.send('ag_to', 'hi'), (err) => {
      assert.equal(err.message, 'home_unreachable');
      assert.equal(err.code, 'home_unreachable');
      assert.equal(err.home_node, 'node2');
      return true;
    });
    assert.equal(hits, 1);
    assert.equal(agent.baseUrl, homeDown.base);
  } finally {
    homeDown.server.close();
    live.server.close();
  }
});
