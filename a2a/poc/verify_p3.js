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
  // Use the pre-existing ipfs_n2_bot to test p2p lookup for an ordinary agent (no p2p_addrs -> relay)
  console.log('=== 1) query p2p info for an ordinary agent (no p2p_addrs -> relay) ===');
  const p = await req('/api/agents/ipfs_n2_bot/p2p', 'GET');
  console.log('status=', p.status, '| deliver_via=', p.body && p.body.deliver_via);

  // Simulate an agent with p2p_addrs: register a new agent that includes p2p_addrs
  console.log('=== 2) register an agent with p2p_addrs (DID path, fake pubkey expected to 400, only verifying the field pipeline doesn\'t crash) ===');
  const reg = await req('/api/agents', 'POST', { name: 'p2pbot', pubkey: 'x', p2p_addrs: ['/ip4/1.2.3.4/tcp/4001/p2p/12D3KooX'] });
  console.log('status=', reg.status, '| (fake pubkey expected to 400, just needs to not crash)');

  // Verify /.well-known is still reachable (confirm nothing existing broke)
  console.log('=== 3) well-known still reachable ===');
  const w = await req('/.well-known/moye-net', 'GET');
  console.log('status=', w.status, '| protocol=', w.body && w.body.protocol);
})();
