'use strict';
// dev's independent adversarial verification of ADR-0038 (M8-M11).
// Coder's smoke proves the happy path. These probe what would let each feature silently fail:
//   M8: does a tampered stored record actually fail verification, not just an unsigned one?
//   M9: does a tampered webhook payload actually fail signature verification?
//   M10: is the pre-filled agent_id the CALLER's real identity, not a template literal?
//   M11: does a non-member actually get refused reading a private room's resources?
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { Agent } = require('../sdk/node/moye-agent-sdk');
const agentProfile = require('../lib/agent_profile');
const webhookSig = require('../lib/webhook_sig');

const PORT = 3191;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function mcpCall(agent, roomId, method, params) {
  const rpc = { jsonrpc: '2.0', id: 1, method, params };
  const res = await fetch(`${BASE}/mcp/rooms/${roomId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...agent._headers(agent._didHeaders(rpc)) },
    body: JSON.stringify(rpc),
  });
  return res.json();
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'adr0038-verify',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'adr0038-verify.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* not up */ }
      await sleep(100);
      if (i === 59) throw new Error('boot failed: ' + boot.slice(-400));
    }

    // ---------- M8: Agent Card field signing ----------
    const owner = new Agent({ name: 'adr38-owner', capabilities: ['x'], baseUrl: BASE });
    owner.generateIdentity();
    await owner.register();

    const rec1 = await (await fetch(`${BASE}/api/agents/${owner.agentId}`)).json();
    const verifiedOk = Agent.verifyAgentProfile(rec1.agent);
    assert(verifiedOk === true, 'untampered profile must verify true, got ' + verifiedOk);
    console.log('OK  M8: untampered profile verifies true');

    // Simulate a compromised/malicious node silently rewriting capabilities post-registration --
    // exactly the attack M8 exists to catch. Signature must still be the ORIGINAL one.
    const tampered = { ...rec1.agent, capabilities: ['totally-different-claimed-capability'] };
    const verifiedTampered = agentProfile.verifyProfile(tampered.pubkey, {
      name: tampered.name, description: tampered.description, capabilities: tampered.capabilities,
      endpoint: tampered.endpoint, webhook_url: tampered.webhook_url || null,
    }, tampered.profile_sig);
    assert(verifiedTampered === false,
      'SECURITY: a tampered capabilities field still verified as true');
    console.log('OK  M8: tampering capabilities after the fact breaks verification');

    // A record with no signature at all must report "unknown", never a false "verified".
    const unsigned = { ...rec1.agent, profile_sig: null };
    assert(Agent.verifyAgentProfile(unsigned) === null,
      'an unsigned record should verify as null (unknown), not true or false');
    console.log('OK  M8: unsigned record reports null, not a false positive');

    // Registration itself must reject an invalid profile_sig rather than silently storing it.
    const badBody = {
      name: 'adr38-bad-sig', description: '', capabilities: [], endpoint: '',
      pubkey: owner._pubkeyPem(), profile_sig: 'AAAA' + 'B'.repeat(80),
    };
    const badReg = await fetch(`${BASE}/api/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(badBody),
    });
    assert(badReg.status === 400, 'registration with an invalid profile_sig should be rejected, got ' + badReg.status);
    console.log('OK  M8: registration rejects an invalid profile_sig outright');

    // ---------- M9: webhook signing ----------
    // Real API: signWebhook(nodeSignFn, payload) -> {fields, sig}; verifyWebhook(pubPem, payload, sig).
    const didlib = require('../lib/did');
    const nodeKeys = crypto.generateKeyPairSync('ed25519');
    const nodePrivPem = nodeKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pubPem = nodeKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const payload = { event: 'message', id: 'rmsg_test', from_agent: 'ag_a', to_agent: 'ag_b', content: 'hi', ts: Date.now() };
    const { fields, sig } = webhookSig.signWebhook((msg) => didlib.sign(nodePrivPem, msg), payload);
    // Realistic wire shape (raw fields + hashes together, matching deliverWebhook), not the bare
    // `fields` object -- a hash-only payload with no raw `content` is indistinguishable from an
    // attacker who stripped `content` and kept the stale hash (see the round-2 gap below), so
    // `verifyWebhook` now correctly rejects it. Testing against `fields` alone would silently pass
    // the exact shape the round-2 fix exists to catch.
    const wire = { ...payload, content_hash: fields.content_hash, attachments_hash: fields.attachments_hash };
    assert(webhookSig.verifyWebhook(pubPem, wire, sig) === true,
      'genuine webhook signature failed to verify');
    console.log('OK  M9: genuine webhook payload verifies');

    const tamperedWire = { ...wire, to_agent: 'ag_attacker' };
    assert(webhookSig.verifyWebhook(pubPem, tamperedWire, sig) === false,
      'SECURITY: a tampered webhook payload still verified against the original signature');
    console.log('OK  M9: tampering the payload after signing breaks verification');

    // content_hash must actually bind to the content -- swapping content but keeping content_hash
    // stale would defeat the point of hashing it in.
    const swappedContent = { ...fields, content_hash: webhookSig.contentHash('totally different content') };
    assert(webhookSig.verifyWebhook(pubPem, swappedContent, sig) === false,
      'SECURITY: swapping content_hash after signing still verified');
    console.log('OK  M9: content_hash is bound by the signature, not swappable');

    // Fast-follow fix (round 2): the first fix (attachments_hash added to the signed fields) was
    // real but INCOMPLETE, and my own first test of it was misleading -- it never constructed the
    // actual wire shape, so it never caught the gap it claimed to close. Build the wire body
    // EXACTLY the way deliverWebhook() really does: `{ ...payload, content_hash, attachments_hash }`
    // -- i.e. raw content/attachments AND their hashes both present. That combination is what lets
    // webhookSignPayload() silently prefer the (possibly stale) hash over recomputing from the raw
    // field, which is the actual exploit: an on-path attacker rewrites `attachments` in transit but
    // has no way to produce a new valid `attachments_hash`, so they just leave the original one
    // sitting there -- and a signature-only check has nothing more to say about it.
    const withAttachments = {
      event: 'message', id: 'rmsg_att', from_agent: 'ag_a', to_agent: 'ag_b',
      content: 'see attached', attachments: [{ cid: 'bafy-real-cid', name: 'real.txt' }], ts: Date.now(),
    };
    const signedAtt = webhookSig.signWebhook((msg) => didlib.sign(nodePrivPem, msg), withAttachments);
    const realisticWire = {
      ...withAttachments,
      content_hash: signedAtt.fields.content_hash,
      attachments_hash: signedAtt.fields.attachments_hash,
    };
    assert(webhookSig.verifyWebhook(pubPem, realisticWire, signedAtt.sig) === true,
      'genuine wire-shaped payload with attachments failed to verify');
    console.log('OK  M9: attachments_hash is present and the genuine wire body verifies');

    // The actual exploit: raw `attachments` rewritten, `attachments_hash` left stale-but-original.
    const staleHashAttack = { ...realisticWire, attachments: [{ cid: 'bafy-ATTACKER-cid', name: 'real.txt' }] };
    assert(webhookSig.verifyWebhook(pubPem, staleHashAttack, signedAtt.sig) === false,
      'SECURITY: rewriting attachments while leaving the original attachments_hash still verified -- '
      + 'this is the exact gap the first fast-follow attempt failed to actually close');
    console.log('OK  M9: raw-field tampering with a stale-but-signed hash is now rejected (round 2 fix)');

    // Same exploit shape against `content`, to confirm the cross-check isn't attachments-only.
    const staleContentAttack = { ...realisticWire, content: 'attacker replaced content' };
    assert(webhookSig.verifyWebhook(pubPem, staleContentAttack, signedAtt.sig) === false,
      'SECURITY: rewriting content while leaving the original content_hash still verified');
    console.log('OK  M9: the same stale-hash attack against content is also rejected');

    // ops review (round 3): the round-2 cross-check was gated on "both the raw field AND its hash
    // are present" (hasOwnProperty on both). That's an incomplete gate -- an attacker who DELETES
    // `attachments` in transit (rather than rewriting it) leaves `attachments_hash` present and
    // the raw field simply absent, so hasOwnProperty(payload,'attachments') is false and the
    // cross-check was silently skipped entirely; signature verification still passed because
    // `fields.attachments_hash` was untouched. Reproduced against the real wire shape and confirmed
    // it slipped through before this fix. Now gated on whether the SIGNED hash is non-null, not on
    // whether the raw field happens to still be there.
    const deletedAttachments = { ...realisticWire };
    delete deletedAttachments.attachments;
    assert(webhookSig.verifyWebhook(pubPem, deletedAttachments, signedAtt.sig) === false,
      'SECURITY: deleting attachments outright (not just rewriting) while leaving attachments_hash '
      + 'still verified -- the hasOwnProperty-gated cross-check missed this');
    console.log('OK  M9: deleting attachments entirely (not just rewriting) is also rejected (round 3 fix)');

    const deletedContent = { ...wire };
    delete deletedContent.content;
    assert(webhookSig.verifyWebhook(pubPem, deletedContent, sig) === false,
      'SECURITY: deleting content outright while leaving content_hash still verified');
    console.log('OK  M9: deleting content entirely is also rejected (round 3 fix)');

    // ops review (round 3): this used to assert canonical-fields-only (no raw content/attachments
    // at all) verifies as true, on the theory that "nothing to cross-check" should be harmless.
    // It isn't: `signedAtt.fields` and "an attacker deleted attachments/content and left the hash"
    // (the round-3 attack above) are the SAME wire shape -- a receiver cannot tell them apart, so
    // supporting one means silently accepting the other. Checked every real caller: deliverWebhook
    // (server.js) always sends `{ ...payload, content_hash, attachments_hash }`, i.e. raw fields
    // are always present in a genuine push. A hash-only body isn't a real delivery shape, so there
    // is no legitimate case this costs -- rejecting it is a pure security win.
    assert(webhookSig.verifyWebhook(pubPem, signedAtt.fields, signedAtt.sig) === false,
      'a canonical-fields-only payload (indistinguishable from a stripped-field attack) should not verify');
    console.log('OK  M9: canonical-fields-only (no raw fields at all) is now rejected too (round 3 fix)');

    // ---------- M10: prompts pre-fill the CALLER's real identity ----------
    const worker = new Agent({ name: 'adr38-worker', capabilities: ['x'], baseUrl: BASE });
    worker.generateIdentity();
    await worker.register();
    const room = await owner.createRoom('adr38-room');
    await worker.joinRoom(room.room_id);

    const promptRes = await mcpCall(worker, room.room_id, 'prompts/get', { name: 'room_listen' });
    const promptText = JSON.stringify(promptRes);
    assert(promptText.includes(worker.agentId),
      "M10: prompts/get did not pre-fill the CALLER's real agent_id");
    assert(!promptText.includes(owner.agentId) || worker.agentId === owner.agentId,
      'M10: prompt pre-filled the wrong identity (owner instead of caller)');
    assert(!/your_agent_id|<agent_id>|\{\{.*agent.*\}\}/i.test(promptText),
      'M10: prompt still contains an unfilled placeholder instead of a real id');
    console.log('OK  M10: prompts/get pre-fills the CALLING agent\'s real identity, not a template');

    // Fast-follow fix: the listening prompt must recommend room_catchup / agent catchup, not just
    // the older two-round-trip changes+awaiting pattern -- that was the whole point of building R21.
    assert(promptText.includes('catchup'),
      'FAST-FOLLOW REGRESSION: the served room_listen prompt does not mention catchup at all');
    console.log('OK  room_listen prompt recommends catchup (fast-follow fixed)');

    // ---------- M11: private-room resource access control ----------
    const priv = await owner.createRoom('adr38-private', { visibility: 'private' });
    const key = owner._roomKey(priv.secret, priv.room_id);
    const cipher = owner._encryptForRoom(key, 'private resource content');
    await owner.sendRoomMessage(priv.room_id, cipher, { encrypted: true });

    const stranger = new Agent({ name: 'adr38-stranger', capabilities: ['x'], baseUrl: BASE });
    stranger.generateIdentity();
    await stranger.register();

    const strangerList = await mcpCall(stranger, priv.room_id, 'resources/list', {});
    const strangerListBlob = JSON.stringify(strangerList);
    const strangerListDenied = strangerListBlob.includes('error')
      || (strangerList.result && strangerList.result.isError);
    assert(strangerListDenied,
      'SECURITY: a non-member listed resources in a private room: ' + strangerListBlob.slice(0, 200));
    console.log('OK  M11: non-member resources/list on a private room is refused');

    const historyUri = `moye://room/${priv.room_id}/history`;
    const strangerRead = await mcpCall(stranger, priv.room_id, 'resources/read', { uri: historyUri });
    const strangerReadBlob = JSON.stringify(strangerRead);
    const strangerReadDenied = strangerReadBlob.includes('error')
      || (strangerRead.result && strangerRead.result.isError);
    assert(strangerReadDenied,
      'SECURITY: a non-member read private room history via resources/read: ' + strangerReadBlob.slice(0, 200));
    assert(!strangerReadBlob.includes('private resource content'),
      'SECURITY: plaintext leaked to a non-member through resources/read');
    console.log('OK  M11: non-member resources/read on a private room is refused, no content leak');

    // The owner (a real member) must still be able to read it -- refusal shouldn't be blanket.
    const ownerRead = await mcpCall(owner, priv.room_id, 'resources/read', { uri: historyUri });
    const ownerReadBlob = JSON.stringify(ownerRead);
    const ownerReadOk = !ownerReadBlob.includes('"isError":true') && !ownerReadBlob.includes('"error"');
    assert(ownerReadOk, 'member (owner) was wrongly refused resources/read: ' + ownerReadBlob.slice(0, 200));
    console.log('OK  M11: member CAN read private room resources (refusal is not blanket)');

    console.log('\nADR0038_ADVERSARIAL_ALL_OK');
  } catch (e) {
    console.error('\nFAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
})();
