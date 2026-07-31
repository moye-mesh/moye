const http = require('http');
const crypto = require('crypto');
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
  // Generates a valid Ed25519 keypair, derives a DID (same algorithm as didlib: did:moye:<first N chars of sha256 fingerprint>)
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const fp = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  const did = 'did:moye:' + fp;
  console.log('DID =', did);

  console.log('=== A) register an agent with p2p_addrs ===');
  const reg = await req('/api/agents', 'POST', {
    name: 'p2pbot', pubkey: pem, p2p_addrs: ['/ip4/203.0.113.9/tcp/4001/p2p/12D3KooXabc']
  });
  console.log('status=', reg.status, '| agent_id=', reg.body && reg.body.agent_id);
  const aid = reg.body && reg.body.agent_id;

  console.log('=== B) query this agent\'s p2p info -> expect deliver_via=p2p ===');
  const p = await req('/api/agents/' + aid + '/p2p', 'GET');
  console.log('status=', p.status, '| deliver_via=', p.body && p.body.deliver_via, '| addrs=', (p.body && p.body.p2p_addrs || []).length);

  console.log('=== C) send this agent a message -> expect deliver_via=p2p (no relay through this node) ===');
  // Sends using a simple token identity (only verifying the routing branch; a fake token would
  // 401, but that branch runs after auth, so use the token returned by the real registration)
  const send = await req('/api/messages', 'POST', {
    from_agent: aid, to_agent: aid, content: 'hi', encrypted: false
  }, { 'Authorization': 'Bearer ' + (reg.body && reg.body.token) });
  console.log('status=', send.status, '| deliver_via=', send.body && send.body.deliver_via, '| note=', send.body && send.body.note);
})();
