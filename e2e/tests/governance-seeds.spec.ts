import { expect, test } from '@playwright/test';
import { generateIdentity, Identity } from '../fixtures/crypto';
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';

function seedsHash(seeds: unknown): string {
  return createHash('sha256').update(JSON.stringify(seeds)).digest('hex').slice(0, 16);
}

// Covers ADR-0006 D2/X2 (server.js's "multi-sig seeds-list governance"): a bootstrap seeds list only
// becomes trustworthy once endorsed by a majority of KNOWN FEDERATION NODES (not agents) -- these
// tests register test-controlled federation-node identities (via POST /api/federation/nodes, which
// only needs FED_SECRET, not a real node) so we can sign proposals/votes as if we were real peers,
// then verify the majority-threshold math actually gates `endorsed`.
//
// The e2e harness never sets FED_SECRET, so server.js falls back to its public default
// ('moye-fed-shared-secret') -- that's fine here (ALLOW_DEFAULT_FED_SECRET=1 is what let the harness
// even boot, see harness/serve.mjs), but this is exactly why a real deployment must never leave
// FED_SECRET unset (see server.js's fail-fast + a2a/docs/DEPLOY.md).
const FED_SECRET = 'moye-fed-shared-secret';

function signRaw(identity: Identity, message: string): string {
  return edSign(null, Buffer.from(message), createPrivateKey(identity.privateKeyPem)).toString('base64');
}

async function registerFederationNode(request: import('@playwright/test').APIRequestContext, id: string, identity: Identity) {
  const res = await request.post('/a2a/api/federation/nodes', {
    data: { id, endpoint: `http://${id}.example`, pubkey: identity.publicKeyPem, secret: FED_SECRET },
  });
  expect((await res.json()).success).toBeTruthy();
}

test.describe('Multi-sig seeds-list governance', () => {
  test('a proposal only becomes endorsed once votes reach the majority-of-known-nodes threshold', async ({ request }) => {
    const nodeA = generateIdentity();
    const nodeB = generateIdentity();
    const idA = `e2e-node-a-${Date.now()}`;
    const idB = `e2e-node-b-${Date.now()}`;
    await registerFederationNode(request, idA, nodeA);
    await registerFederationNode(request, idB, nodeB);
    // totalNodes = 2 known peers + this node itself = 3 -> threshold = floor(3/2)+1 = 2

    const seeds = [{ id: 'seed-x', endpoint: 'https://x.example' }, { id: 'seed-y', endpoint: 'https://y.example' }];

    // First proposal+vote (from nodeA) is below threshold -- not yet endorsed
    const proposeRes = await request.post('/a2a/api/governance/seeds/propose', { data: {} }); // sanity: bad request first
    expect(proposeRes.status()).toBe(400);

    const hashProbe = await (await request.post('/a2a/api/governance/seeds/propose', {
      data: { seeds, voter_node: idA, sig: 'not-even-close-to-valid' },
    })).json();
    expect(hashProbe.success).toBeFalsy(); // invalid signature must be rejected, never silently accepted

    const hash = seedsHash(seeds);
    const sigA = signRaw(nodeA, `seeds-propose:${hash}:${idA}`);
    const propose = await (await request.post('/a2a/api/governance/seeds/propose', {
      data: { seeds, voter_node: idA, sig: sigA },
    })).json();
    expect(propose.success).toBeTruthy();
    expect(propose.votes).toBe(1);
    expect(propose.threshold).toBe(2);
    expect(propose.endorsed).toBe(false);

    const midState = await (await request.get(`/a2a/api/governance/seeds/${propose.hash}`)).json();
    expect(midState.votes).toBe(1);
    expect(midState.endorsed).toBe(false);

    // Second vote (from nodeB) reaches the threshold -> endorsed flips to true
    const sigB = signRaw(nodeB, `seeds-propose:${propose.hash}:${idB}`);
    const vote = await (await request.post('/a2a/api/governance/seeds/vote', {
      data: { hash: propose.hash, voter_node: idB, sig: sigB },
    })).json();
    expect(vote.success).toBeTruthy();
    expect(vote.votes).toBe(2);
    expect(vote.endorsed).toBe(true);

    const finalState = await (await request.get(`/a2a/api/governance/seeds/${propose.hash}`)).json();
    expect(finalState.endorsed).toBe(true);
    expect(finalState.seeds).toEqual(seeds);
  });

  test('voting with an invalid signature is rejected and does not count', async ({ request }) => {
    const nodeC = generateIdentity();
    const idC = `e2e-node-c-${Date.now()}`;
    await registerFederationNode(request, idC, nodeC);
    const seeds = [{ id: 'seed-z', endpoint: 'https://z.example' }];
    const hash = seedsHash(seeds);
    const validSig = signRaw(nodeC, `seeds-propose:${hash}:${idC}`);
    const propose = await (await request.post('/a2a/api/governance/seeds/propose', {
      data: { seeds, voter_node: idC, sig: validSig },
    })).json();
    expect(propose.success).toBeTruthy();

    // Someone else tries to vote AS nodeC without holding its key -- forged signature must fail,
    // not silently increment the tally.
    const forged = await request.post('/a2a/api/governance/seeds/vote', {
      data: { hash: propose.hash, voter_node: idC, sig: 'forged-signature-value' },
    });
    expect(forged.status()).toBe(403);
    const state = await (await request.get(`/a2a/api/governance/seeds/${propose.hash}`)).json();
    expect(state.votes).toBe(1); // unchanged
  });

  test('voting for a hash that was never proposed is rejected', async ({ request }) => {
    const res = await request.post('/a2a/api/governance/seeds/vote', {
      data: { hash: 'deadbeefdeadbeef', voter_node: 'nobody', sig: 'whatever' },
    });
    expect(res.status()).toBe(404);
  });
});
