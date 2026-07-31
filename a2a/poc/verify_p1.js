const http = require('http');
function req(path, method, body, headers) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 3100, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
      let buf = ''; res.on('data', d => buf += d); res.on('end', () => {
        let j; try { j = JSON.parse(buf); } catch { j = buf; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    if (data) r.write(data); r.end();
  });
}
(async () => {
  console.log('=== 1) register without credentials -> expect 401 + pow challenge ===');
  const a = await req('/api/agents', 'POST', { name: 'anon' });
  console.log('status=', a.status, '| pow?', !!(a.body && a.body.pow), '| err=', a.body && a.body.error);

  console.log('=== 2) shared-state unauthenticated -> expect 401 ===');
  const b = await req('/api/shared-state', 'POST', { keyname: 'global', value: 'hi', lamport: 100 });
  console.log('status=', b.status, '| err=', b.body && b.body.error);

  console.log('=== 3) shared-state with forged DID headers -> expect invalid signature (401/400) ===');
  const c = await req('/api/shared-state', 'POST', { keyname: 'global', value: 'hi', lamport: 100 },
    { 'X-Moye-Did': 'did:test:aaa', 'X-Moye-Sig': 'x' });
  console.log('status=', c.status, '| err=', c.body && c.body.error);

  console.log('=== 4) read shared-state -> expect still accessible ===');
  const d = await req('/api/shared-state', 'GET');
  console.log('status=', d.status, '| keys=', d.body && Object.keys(d.body.state || {}));
})();
