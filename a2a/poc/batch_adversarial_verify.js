'use strict';
// dev's independent adversarial verification of the 2026-08-07 batch.
// Coder's smokes prove the happy paths work. These probe what they did not:
// can the guarantees be broken by someone actively trying?
const { spawn } = require('child_process');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');
const shamir = require('../lib/shamir');
const mnemonicLib = require('../lib/mnemonic');

const PORT = 3171;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function signedPost(agent, urlPath, bodyObj) {
  const body = { ...bodyObj };
  const headers = { 'Content-Type': 'application/json', ...agent._headers(agent._didHeaders(body)) };
  const res = await fetch(BASE + urlPath, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, json };
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ALLOW_DEFAULT_FED_SECRET: '1',
      NODE_ID: 'adversarial-verify',
      PORT: String(PORT),
      DB_FILE: path.join(__dirname, '..', 'data', 'adversarial-verify.db'),
      RECOVERY_VETO_MS: '60000',
      DOMAIN_VERIFY_MOCK_JSON: JSON.stringify({ 'legit.example': 'PLACEHOLDER' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* not up yet */ }
      await sleep(100);
      if (i === 59) throw new Error('boot failed: ' + boot.slice(-400));
    }

    // ---------- Shamir: does the threshold actually hold, and do bad shares fail loudly? ----------
    const secret = Buffer.from('this-is-a-32-byte-secret-value!!');
    const shares = shamir.split2of3(secret);
    assert(shares.length === 3, 'expected 3 shares');

    // 1 share must not reconstruct.
    let oneShareWorked = false;
    try { shamir.combine([shares[0]]); oneShareWorked = true; } catch { /* expected */ }
    assert(!oneShareWorked, 'SECURITY: a single share reconstructed the secret');
    console.log('OK  shamir: 1 share cannot reconstruct');

    // Any 2 of 3 must reconstruct exactly.
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const got = Buffer.from(shamir.combine([shares[a], shares[b]]));
      assert(got.equals(secret), `shares ${a}+${b} failed to reconstruct`);
    }
    console.log('OK  shamir: every 2-of-3 pair reconstructs exactly');

    // Shares from a DIFFERENT split must NOT silently yield a plausible-looking wrong secret.
    // Silently returning a wrong key mid-recovery is the worst failure mode here: the holder
    // has no way to tell it went wrong. dev added a share tag + reconstruction integrity check
    // to lib/shamir.js for exactly this; assert it actually fires.
    const otherShares = shamir.split2of3(Buffer.from('a-completely-different-secret!!!'));
    let mixedSilentlyWrong = false;
    try {
      const mixed = Buffer.from(shamir.combine([shares[0], otherShares[1]]));
      mixedSilentlyWrong = !mixed.equals(secret);
    } catch { /* rejecting is the correct behavior */ }
    assert(!mixedSilentlyWrong, 'SECURITY: mismatched shares silently returned a wrong secret');
    console.log('OK  shamir: mismatched shares are rejected, not silently mis-reconstructed');

    // ---------- Mnemonic: determinism must be real, not incidental ----------
    const m1 = mnemonicLib.generateMnemonic();
    assert(m1.split(/\s+/).length === 24, 'expected 24 words');
    const d1 = mnemonicLib.deriveFromMnemonic(m1);
    const d2 = mnemonicLib.deriveFromMnemonic(m1);
    assert(d1.did === d2.did, 'same mnemonic produced different DIDs');
    const d3 = mnemonicLib.deriveFromMnemonic(mnemonicLib.generateMnemonic());
    assert(d3.did !== d1.did, 'two different mnemonics produced the SAME DID');
    // A passphrase must change the derived identity (otherwise it is decorative).
    const d4 = mnemonicLib.deriveFromMnemonic(m1, 'passphrase');
    assert(d4.did !== d1.did, 'SECURITY: passphrase did not affect derivation');
    console.log('OK  mnemonic: deterministic, distinct per phrase, passphrase actually binds');

    // ---------- Set up two unrelated agents + a room ----------
    const owner = new Agent({ name: 'adv-owner', capabilities: ['x'], baseUrl: BASE });
    owner.generateIdentity(); await owner.register();
    const stranger = new Agent({ name: 'adv-stranger', capabilities: ['x'], baseUrl: BASE });
    stranger.generateIdentity(); await stranger.register();
    const room = await owner.createRoom('adv-room');
    await owner.sendRoomMessage(room.room_id, 'a message worth consolidating');

    // ---------- R16: a non-member must not be able to consolidate someone else's room ----------
    const strangerConsolidate = await signedPost(stranger, `/api/rooms/${room.room_id}/consolidate`, {
      summary: 'hostile consolidation by a non-member',
    });
    assert(strangerConsolidate.status === 403,
      `SECURITY: non-member consolidated a room (status ${strangerConsolidate.status})`);
    console.log('OK  R16: non-member cannot consolidate (403)');

    // A member can.
    const ownerConsolidate = await signedPost(owner, `/api/rooms/${room.room_id}/consolidate`, {
      summary: 'legitimate consolidation',
    });
    assert(ownerConsolidate.status === 200, 'member consolidation failed: ' + ownerConsolidate.status);
    console.log('OK  R16: member can consolidate');

    // ---------- P4-4: domain verification must require a real DID match ----------
    // Mock DNS maps legit.example -> PLACEHOLDER, which is nobody's DID.
    const spoofed = await signedPost(owner, `/api/agents/${owner.agentId}/domain-verify`, {
      domain: 'legit.example',
    });
    const spoofOk = spoofed.status === 200 && spoofed.json && spoofed.json.verified === true;
    assert(!spoofOk, 'SECURITY: domain verified despite the TXT record holding a different DID');
    console.log('OK  P4-4: domain not verified when TXT DID does not match the caller');

    // ---------- P4-3: recovery veto window and ownership ----------
    const init = await signedPost(owner, `/api/agents/${owner.agentId}/recovery/initiate`, {
      new_did: 'did:moye:f1220' + 'a'.repeat(64),
    });
    assert(init.status === 200, 'recovery initiate failed: ' + init.status);

    // Completing inside the veto window must be refused.
    const early = await signedPost(owner, `/api/agents/${owner.agentId}/recovery/complete`, {});
    assert(early.status !== 200,
      'SECURITY: recovery completed inside the veto window (status ' + early.status + ')');
    console.log('OK  P4-3: recovery cannot complete inside the veto window');

    // A stranger must not be able to drive someone else's recovery. The endpoints key off the
    // authenticated caller, so a stranger hitting the owner's URL must not touch the owner's record.
    const hostileVeto = await signedPost(stranger, `/api/agents/${owner.agentId}/recovery/veto`, {});
    const hostileComplete = await signedPost(stranger, `/api/agents/${owner.agentId}/recovery/complete`, {});
    assert(hostileVeto.status !== 200 && hostileComplete.status !== 200,
      `SECURITY: a stranger acted on another agent's recovery (veto ${hostileVeto.status}, complete ${hostileComplete.status})`);
    // And the owner's recovery must still be pending, i.e. genuinely untouched.
    const stillPending = await signedPost(owner, `/api/agents/${owner.agentId}/recovery/veto`, {});
    assert(stillPending.status === 200,
      "owner's own recovery was no longer vetoable — a stranger may have altered it");
    console.log("OK  P4-3: a stranger cannot veto or complete another agent's recovery");

    // ---------- R17: pinning must default OFF and never expose plaintext ----------
    const priv = await owner.createRoom('adv-private', { visibility: 'private' });
    const key = owner._roomKey(priv.secret, priv.room_id);
    const cipher = owner._encryptForRoom(key, 'top secret plaintext');
    await owner.sendRoomMessage(priv.room_id, cipher, { encrypted: true });

    // listPinnedCids() returns an object keyed by room id, not an array.
    const before = owner.listPinnedCids();
    assert(before && typeof before === 'object' && !Array.isArray(before), 'unexpected listPinnedCids shape');
    assert(Object.keys(before).length === 0,
      'SECURITY: pinning was active before any opt-in (default must be OFF)');
    console.log('OK  R17: pinning defaults to OFF (nothing tracked before opt-in)');

    // The opt-in gate must be enforced, not merely advisory.
    let pinnedWithoutOptIn = false;
    try { await owner.pinRoomCiphertext(priv.room_id); pinnedWithoutOptIn = true; } catch { /* expected */ }
    assert(!pinnedWithoutOptIn, 'SECURITY: pinning ran without an explicit opt-in');
    console.log('OK  R17: pinning refuses to run without explicit opt-in');

    // After opting in it must be visible, and turning it off must actually clear it.
    owner.enableRoomPinning(priv.room_id);
    assert(owner.listPinnedCids()[priv.room_id],
      'opt-in did not become visible via listPinnedCids');
    owner.enableRoomPinning(priv.room_id, { on: false });
    assert(!owner.listPinnedCids()[priv.room_id],
      'SECURITY: disabling pinning left the room still tracked');
    console.log('OK  R17: opt-in is visible and opt-out actually clears it');
    // Whatever the room exposes for pins must never contain the plaintext.
    const pinsRes = await fetch(`${BASE}/api/rooms/${priv.room_id}/pins`,
      { headers: owner._headers(owner._didHeadersForGet(`/api/rooms/${priv.room_id}/pins`)) });
    const pinsText = await pinsRes.text();
    assert(!pinsText.includes('top secret plaintext'),
      'SECURITY: plaintext leaked through the pins endpoint');
    console.log('OK  R17: pins surface contains no plaintext');

    console.log('\nADVERSARIAL_ALL_OK');
  } catch (e) {
    console.error('\nFAIL', e.message || e);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
})();
