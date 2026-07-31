import { APIRequestContext, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

/** Solves the server's registration PoW challenge (see solvePow() in directory.html). */
function solvePow(prefix: string, difficulty: number): string {
  const target = '0'.repeat(difficulty);
  for (let n = 0; ; n++) {
    const nonce = n.toString(16);
    if (createHash('sha256').update(prefix + nonce).digest('hex').startsWith(target)) return nonce;
  }
}

/**
 * Registers an agent directly via the API, for tests that need a peer agent to exist but
 * aren't testing the registration UI itself. Mirrors submitRegister()'s PoW retry in
 * directory.html: an unauthenticated POST gets a 401 + pow challenge, solve it and resend.
 */
export async function registerViaApi(request: APIRequestContext, name: string) {
  let res = await request.post('/a2a/api/agents', { data: { name } });
  let body = await res.json();
  if (!body.success && body.pow) {
    const nonce = solvePow(body.pow.prefix, body.pow.difficulty);
    res = await request.post('/a2a/api/agents', { data: { name, pow: nonce, pow_prefix: body.pow.prefix } });
    body = await res.json();
  }
  expect(body.success, `registerViaApi(${name}) failed: ${body.error}`).toBeTruthy();
  return body as { agent_id: string; token: string; did: string | null };
}
