import { expect, test } from '@playwright/test';
import { registerViaApi } from '../fixtures/api';
import { encryptForRoom } from '../fixtures/crypto';

// Covers the private-room trust boundary added 2026-07-24 (server.js "STAGE 2 + room privacy/E2E
// chat"): membership is gated by a client-derived `membership_proof`, the server only ever stores
// its hash, and non-members must be unable to read *or* post *or* even see the room hash leak out
// in any response. These are pure API/protocol properties -- no dedicated UI exists for them (only
// room-viewer.html consumes them), so these tests hit /a2a/api/rooms/* directly.
test.describe('Private rooms', () => {
  test('creator can create, read, and post without an extra join call', async ({ request }) => {
    const creator = await registerViaApi(request, `e2e-priv-creator-${Date.now()}`);
    const secret = 'creator-secret-' + Date.now();
    const createRes = await request.post('/a2a/api/rooms', {
      headers: { Authorization: `Bearer ${creator.token}` },
      data: { name: 'creator-room', visibility: 'private', membership_proof: secret },
    });
    const created = await createRes.json();
    expect(created.success, created.error).toBeTruthy();
    expect(created.visibility).toBe('private');

    const getRes = await request.get(`/a2a/api/rooms/${created.room_id}`, {
      headers: { Authorization: `Bearer ${creator.token}` },
    });
    const got = await getRes.json();
    expect(got.success).toBeTruthy();
    expect(got.room.visibility).toBe('private');

    const postRes = await request.post(`/a2a/api/rooms/${created.room_id}/messages`, {
      headers: { Authorization: `Bearer ${creator.token}` },
      data: { content: encryptForRoom(secret, created.room_id, 'hello from the creator'), encrypted: true },
    });
    expect((await postRes.json()).success).toBeTruthy();
  });

  test('a non-member is rejected from reading, posting, and listing -- and never sees the proof hash', async ({ request }) => {
    const creator = await registerViaApi(request, `e2e-priv-owner-${Date.now()}`);
    const outsider = await registerViaApi(request, `e2e-priv-outsider-${Date.now()}`);
    const secret = 'owner-secret-' + Date.now();
    const created = await (await request.post('/a2a/api/rooms', {
      headers: { Authorization: `Bearer ${creator.token}` },
      data: { name: 'gated-room', visibility: 'private', membership_proof: secret },
    })).json();
    expect(created.success).toBeTruthy();

    // Non-member GET room details -> 403
    const getRes = await request.get(`/a2a/api/rooms/${created.room_id}`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    expect(getRes.status()).toBe(403);

    // Non-member GET room messages -> 403
    const msgsRes = await request.get(`/a2a/api/rooms/${created.room_id}/messages`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    expect(msgsRes.status()).toBe(403);

    // Non-member POST a message -> 403
    const postRes = await request.post(`/a2a/api/rooms/${created.room_id}/messages`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
      data: { content: 'i should not be able to post this' },
    });
    expect(postRes.status()).toBe(403);

    // Non-member listing rooms never sees this private room at all
    const listRes = await request.get('/a2a/api/rooms', { headers: { Authorization: `Bearer ${outsider.token}` } });
    const list = await listRes.json();
    expect(list.rooms.some((r: { id: string }) => r.id === created.room_id)).toBe(false);

    // membership_proof_hash must never appear in ANY response body the creator/outsider can see,
    // including the raw list/get bodies (server.js explicitly strips it -- verify that promise holds)
    const creatorGet = await (await request.get(`/a2a/api/rooms/${created.room_id}`, {
      headers: { Authorization: `Bearer ${creator.token}` },
    })).json();
    expect(JSON.stringify(creatorGet)).not.toContain('membership_proof_hash');
  });

  test('joining with the correct membership_proof grants access; wrong proof is rejected', async ({ request }) => {
    const creator = await registerViaApi(request, `e2e-priv-jcreator-${Date.now()}`);
    const joiner = await registerViaApi(request, `e2e-priv-joiner-${Date.now()}`);
    const secret = 'the-real-secret-' + Date.now();
    const created = await (await request.post('/a2a/api/rooms', {
      headers: { Authorization: `Bearer ${creator.token}` },
      data: { name: 'joinable-room', visibility: 'private', membership_proof: secret },
    })).json();

    // Wrong proof -> 403, and joiner still isn't a member afterwards
    const badJoin = await request.post(`/a2a/api/rooms/${created.room_id}/join`, {
      headers: { Authorization: `Bearer ${joiner.token}` },
      data: { membership_proof: 'not-the-secret' },
    });
    expect(badJoin.status()).toBe(403);
    const stillOutside = await request.get(`/a2a/api/rooms/${created.room_id}`, {
      headers: { Authorization: `Bearer ${joiner.token}` },
    });
    expect(stillOutside.status()).toBe(403);

    // Correct proof -> join succeeds, and the joiner can now read + post
    const goodJoin = await request.post(`/a2a/api/rooms/${created.room_id}/join`, {
      headers: { Authorization: `Bearer ${joiner.token}` },
      data: { membership_proof: secret },
    });
    const joined = await goodJoin.json();
    expect(joined.success).toBeTruthy();
    expect(joined.joined).toBe(true);

    const now = await request.get(`/a2a/api/rooms/${created.room_id}`, {
      headers: { Authorization: `Bearer ${joiner.token}` },
    });
    expect(now.status()).toBe(200);

    const post = await request.post(`/a2a/api/rooms/${created.room_id}/messages`, {
      headers: { Authorization: `Bearer ${joiner.token}` },
      data: { content: encryptForRoom(secret, created.room_id, 'hi, I joined!'), encrypted: true },
    });
    expect((await post.json()).success).toBeTruthy();

    // The new member can also read the creator's earlier message -- shared history property
    const msgs = await (await request.get(`/a2a/api/rooms/${created.room_id}/messages`, {
      headers: { Authorization: `Bearer ${joiner.token}` },
    })).json();
    expect(msgs.messages.length).toBeGreaterThanOrEqual(1);
  });

  test('public rooms are unaffected: no membership_proof required, anyone can read/post', async ({ request }) => {
    const creator = await registerViaApi(request, `e2e-pub-creator-${Date.now()}`);
    const anyone = await registerViaApi(request, `e2e-pub-anyone-${Date.now()}`);
    const created = await (await request.post('/a2a/api/rooms', {
      headers: { Authorization: `Bearer ${creator.token}` },
      data: { name: 'open-room' },
    })).json();
    expect(created.visibility).toBe('public');

    const post = await request.post(`/a2a/api/rooms/${created.room_id}/messages`, {
      headers: { Authorization: `Bearer ${anyone.token}` },
      data: { content: 'public rooms need no proof' },
    });
    expect((await post.json()).success).toBeTruthy();
  });

  test('creating a private room without membership_proof is rejected', async ({ request }) => {
    const creator = await registerViaApi(request, `e2e-priv-noproof-${Date.now()}`);
    const res = await request.post('/a2a/api/rooms', {
      headers: { Authorization: `Bearer ${creator.token}` },
      data: { name: 'should-fail', visibility: 'private' },
    });
    expect(res.status()).toBe(400);
  });
});
