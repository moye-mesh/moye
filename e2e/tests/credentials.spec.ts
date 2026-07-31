import { expect, test } from '@playwright/test';
import { didAuth, registerWithDid, signCredential, stableStringify } from '../fixtures/crypto';

// Covers ADR-0005 direction 2 (Verifiable Credentials, server.js's "F2" section): the whole point is
// that the server refuses to store a credential it can't independently verify, so `credential_count`
// never counts forgeries -- these tests exercise exactly that boundary, plus the issuer-identity
// binding (you can only issue in your OWN name, never impersonate another issuer while authenticated
// as yourself).
test.describe('Verifiable Credentials', () => {
  test('a validly-signed credential is accepted and counted', async ({ request }) => {
    const issuer = await registerWithDid(request, `e2e-vc-issuer-${Date.now()}`);
    const subject = await registerWithDid(request, `e2e-vc-subject-${Date.now()}`);
    const vcCore = { type: 'moye/vc', issuer: issuer.did, subject: subject.did, claim: { capability: 'translate', level: 'verified' }, issued_at: Date.now() };
    const sig = signCredential(issuer, vcCore);
    const vc = { ...vcCore, sig };

    const { body, headers } = didAuth(issuer, { credential: vc });
    const res = await request.post('/a2a/api/credentials', { headers, data: body });
    const json = await res.json();
    expect(json.success, json.error).toBeTruthy();
    expect(json.credential_count).toBe(1);

    const list = await (await request.get(`/a2a/api/agents/${subject.agent_id}/credentials`)).json();
    expect(list.credentials).toHaveLength(1);
    expect(list.credentials[0].verified).toBe(true);
    expect(list.credentials[0].issuer).toBe(issuer.did);
  });

  test('a forged signature is rejected and never counted', async ({ request }) => {
    const issuer = await registerWithDid(request, `e2e-vc-forger-${Date.now()}`);
    const impostor = await registerWithDid(request, `e2e-vc-impostor-${Date.now()}`); // has its own valid key
    const subject = await registerWithDid(request, `e2e-vc-forged-subject-${Date.now()}`);
    const vcCore = { type: 'moye/vc', issuer: issuer.did, subject: subject.did, claim: { capability: 'translate' }, issued_at: Date.now() };
    // Sign with the WRONG key (impostor's), claiming to be `issuer` -- this is the forgery attempt.
    const forgedSig = signCredential(impostor, vcCore);
    const vc = { ...vcCore, sig: forgedSig };

    // Authenticate the write itself as `issuer` (so the 403 "issuer must match authenticated agent"
    // check doesn't short-circuit before we even reach signature verification) -- the forgery must be
    // caught by vcVerify's didlib.verify() against issuer's real pubkey, not by the auth-identity check.
    const { body, headers } = didAuth(issuer, { credential: vc });
    const res = await request.post('/a2a/api/credentials', { headers, data: body });
    expect(res.status()).toBe(400);

    const list = await (await request.get(`/a2a/api/agents/${subject.agent_id}/credentials`)).json();
    expect(list.credentials).toHaveLength(0);
  });

  test('cannot issue a credential in someone else\'s name (issuer/authenticated-identity mismatch)', async ({ request }) => {
    const realIssuer = await registerWithDid(request, `e2e-vc-real-${Date.now()}`);
    const attacker = await registerWithDid(request, `e2e-vc-attacker-${Date.now()}`);
    const subject = await registerWithDid(request, `e2e-vc-mismatch-subject-${Date.now()}`);
    // Attacker crafts a VC claiming to be issued by realIssuer, but signs it with their OWN key
    // (the only key they have) and authenticates the HTTP request as themselves.
    const vcCore = { type: 'moye/vc', issuer: realIssuer.did, subject: subject.did, claim: { capability: 'translate' }, issued_at: Date.now() };
    const sig = signCredential(attacker, vcCore);
    const vc = { ...vcCore, sig };
    const { body, headers } = didAuth(attacker, { credential: vc });
    const res = await request.post('/a2a/api/credentials', { headers, data: body });
    expect(res.status()).toBe(403); // "credential.issuer must match the authenticated agent DID"
  });

  test('issuing to an unknown subject DID fails', async ({ request }) => {
    const issuer = await registerWithDid(request, `e2e-vc-unknownsubj-${Date.now()}`);
    const fakeSubjectDid = 'did:moye:' + '0'.repeat(32);
    const vcCore = { type: 'moye/vc', issuer: issuer.did, subject: fakeSubjectDid, claim: { capability: 'x' }, issued_at: Date.now() };
    const sig = signCredential(issuer, vcCore);
    const { body, headers } = didAuth(issuer, { credential: { ...vcCore, sig } });
    const res = await request.post('/a2a/api/credentials', { headers, data: body });
    expect(res.status()).toBe(404);
  });

  test('resubmitting the identical credential does not double-count (OR-Set dedupe by signature)', async ({ request }) => {
    const issuer = await registerWithDid(request, `e2e-vc-dedupe-issuer-${Date.now()}`);
    const subject = await registerWithDid(request, `e2e-vc-dedupe-subject-${Date.now()}`);
    const vcCore = { type: 'moye/vc', issuer: issuer.did, subject: subject.did, claim: { capability: 'dedupe-test' }, issued_at: Date.now() };
    const sig = signCredential(issuer, vcCore);
    const vc = { ...vcCore, sig };

    for (let i = 0; i < 2; i++) {
      const { body, headers } = didAuth(issuer, { credential: vc });
      const res = await request.post('/a2a/api/credentials', { headers, data: body });
      expect((await res.json()).success).toBeTruthy();
    }
    const list = await (await request.get(`/a2a/api/agents/${subject.agent_id}/credentials`)).json();
    expect(list.credentials).toHaveLength(1);
  });

  test('sanity: stableStringify produces the exact canonical form the server expects', () => {
    // Guards the test helper itself against silently drifting from server.js's algorithm -- if this
    // ever fails, every other test in this file would start failing for the wrong reason (signature
    // mismatch instead of a real protocol bug), so make the assumption explicit and separately checked.
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });
});
