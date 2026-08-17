'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Worker origin helpers', async () => {
  const { parseOrigins, shouldFailoverStatus, DEFAULT_ORIGINS } = await import('../worker.js');
  assert.deepEqual(
    parseOrigins('https://origin.moye.ai/', 'https://node2-origin.moye.ai, https://origin.moye.ai, https://node3-origin.moye.ai'),
    ['https://origin.moye.ai', 'https://node2-origin.moye.ai', 'https://node3-origin.moye.ai'],
  );
  assert.deepEqual(parseOrigins('', ''), DEFAULT_ORIGINS);
  assert.equal(shouldFailoverStatus(502), true);
  assert.equal(shouldFailoverStatus(521), true);
  assert.equal(shouldFailoverStatus(200), false);
  assert.equal(shouldFailoverStatus(404), false);
});

test('Worker does not hop origin on application home_unreachable 503', async () => {
  const { shouldFailoverResponse } = await import('../worker.js');
  const app503 = new Response(JSON.stringify({ success: false, error: 'home_unreachable', code: 'home_unreachable' }), { status: 503 });
  assert.equal(await shouldFailoverResponse(app503), false);
  const gw503 = new Response('error', { status: 503 });
  assert.equal(await shouldFailoverResponse(gw503), true);
  const gw502 = new Response('bad gateway', { status: 502 });
  assert.equal(await shouldFailoverResponse(gw502), true);
  const ok = new Response('ok', { status: 200 });
  assert.equal(await shouldFailoverResponse(ok), false);
});
