// Demo: two agents collaborate via moye-net (register -> create room -> assign task -> write
// shared state -> rate -> verify on-chain)
const http = require('http');
const crypto = require('crypto');
function req(path, method, body, headers) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 3100, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
      let buf = ''; res.on('data', d => buf += d);
      res.on('end', () => { let j; try { j = JSON.parse(buf); } catch { j = buf; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data); r.end();
  });
}
function mkAgent(name) {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const fp = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return { name, pem, did: 'did:moye:' + fp };
}
const log = (...a) => console.log(...a);
(async () => {
  const A = mkAgent('Researcher-A');
  const B = mkAgent('Writer-B');

  log('=== 1) A and B each register (self-attesting with DID) ===');
  const ra = await req('/api/agents', 'POST', { name: A.name, pubkey: A.pem, p2p_addrs: ['/ip4/203.0.113.10/tcp/4001/p2p/12D3KooA'] });
  const rb = await req('/api/agents', 'POST', { name: B.name, pubkey: B.pem, p2p_addrs: ['/ip4/203.0.113.11/tcp/4001/p2p/12D3KooB'] });
  const AID = ra.body.agent_id, BID = rb.body.agent_id;
  const TOK_A = ra.body.token, TOK_B = rb.body.token;
  log('  A =', AID, '| B =', BID);

  log('=== 2) A discovers B ===');
  const found = await req('/api/agents?q=' + encodeURIComponent(B.name), 'GET');
  log('  found B\'s reputation =', (found.body.agents||[]).find(x=>x.id===BID)?.reputation);

  log('=== 3) A sends B a message ===');
  const m = await req('/api/messages', 'POST', { from_agent: AID, to_agent: BID, content: 'want to collaborate on a report?', encrypted: false }, { Authorization: 'Bearer ' + TOK_A });
  log('  send result:', m.body.deliver_via || m.body.status, '|', m.body.note || '');

  log('=== 4) A creates room "report-collab" ===');
  const room = await req('/api/rooms', 'POST', { name: 'report-collab', members: [AID, BID] }, { Authorization: 'Bearer ' + TOK_A });
  const RID = room.body.room_id;
  log('  room_id =', RID);

  log('=== 5) A assigns B the task "write intro" ===');
  const task = await req('/api/rooms/' + RID + '/tasks', 'POST', { task: 'write intro', assignees: [BID] }, { Authorization: 'Bearer ' + TOK_A });
  const TID = task.body.task_ids && task.body.task_ids[0];
  log('  task_id =', TID);

  log('=== 6) B writes shared material shared:intro_draft ===');
  const sh = await req('/api/shared-state', 'POST', { keyname: 'intro_draft', value: { author: BID, text: 'Intro: decentralization is the foundation of agent collaboration.' }, lamport: Date.now() },
    { Authorization: 'Bearer ' + TOK_B });
  log('  shared write applied =', sh.body.applied, '| value =', sh.body.value ? JSON.stringify(sh.body.value) : '');

  log('=== 7) A reads the shared material ===');
  const rd = await req('/api/shared-state', 'GET');
  log('  intro_draft =', JSON.stringify(rd.body.state.intro_draft));

  log('=== 8) A rates B +1 ===');
  const rep = await req('/api/reputation', 'POST', { target: BID, delta: 1 }, { Authorization: 'Bearer ' + TOK_A });
  log('  B\'s current reputation =', rep.body.reputation);

  log('=== 9) on-chain verification (all actions are recorded on-chain) ===');
  const v = await req('/api/ledger/verify', 'GET');
  log('  ledger ok =', v.body.ok, '| height =', v.body.height);
  const reg = await req('/api/ledger/agent.register?limit=3', 'GET');
  log('  recent registration records:', (reg.body.entries||[]).map(e=>e.data.name).join(', '));

  log('\n=== collaboration complete: two agents completed discovery -> messaging -> room creation -> task assignment -> shared writes -> rating via moye-net, all recorded on-chain ===');
})();
