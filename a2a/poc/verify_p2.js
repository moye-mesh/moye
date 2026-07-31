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
  console.log('=== 1) reputation vote (forged DID headers, expect 401) ===');
  const a = await req('/api/reputation', 'POST', { target: 'ag_xxx', delta: 1 },
    { 'X-Moye-Did': 'did:test:aaa', 'X-Moye-Sig': 'x' });
  console.log('status=', a.status, '| err=', a.body && a.body.error);

  console.log('=== 2) discovery endpoint should include reputation/revoked fields ===');
  const b = await req('/api/agents', 'GET');
  const ag = (b.body.agents || [])[0];
  console.log('status=', b.status, '| sample agent fields:', ag ? Object.keys(ag).join(',') : '(no agent)');

  console.log('=== 3) Arweave anchoring (no wallet, expect a clear 502 error, no fake success) ===');
  const c = await req('/api/ledger/anchor', 'POST', { chain: 'arweave' });
  console.log('status=', c.status, '| err=', c.body && c.body.error);

  console.log('=== 4) IPFS anchoring (free, should still succeed) ===');
  const d = await req('/api/ledger/anchor', 'POST', { chain: 'ipfs' });
  console.log('status=', d.status, '| chain=', d.body && d.body.chain, '| cid=', (d.body && d.body.cid || '').slice(0,12));
})();
