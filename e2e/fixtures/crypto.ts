import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as edSign, hkdfSync, randomBytes, createCipheriv } from 'node:crypto';
import { APIRequestContext, expect } from '@playwright/test';

/** A locally-generated DID identity, mirroring lib/did.js / the SDKs' generateIdentity(). */
export interface Identity {
  did: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * did:moye:f1220<full sha256 hex of SPKI DER> -- must match lib/did.js::pubKeyFingerprint exactly.
 * 'f' = multibase base16, '1220' = multihash prefix (0x12 sha2-256, 0x20 = 32-byte digest), followed
 * by the FULL (untruncated) digest -- see ADR-0017 (local-only), which moved off the old truncated
 * 32-hex-char format for stronger collision resistance.
 */
function deriveDid(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return 'did:moye:f1220' + createHash('sha256').update(der).digest('hex');
}

export function generateIdentity(): Identity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { did: deriveDid(publicKeyPem), privateKeyPem, publicKeyPem };
}

/** PureEdDSA sign (no pre-hash) -- matches lib/did.js::sign / crypto.sign(null, ...) in the SDKs. */
function rawSign(privateKeyPem: string, message: string): string {
  return edSign(null, Buffer.from(message), createPrivateKey(privateKeyPem)).toString('base64');
}

/**
 * DID-signed write: injects `ts` into the payload (server requires it -- the e2e harness runs
 * with strict replay protection, no ALLOW_UNSIGNED_TS), signs JSON.stringify(payload), and returns
 * the exact body to send + the X-Moye-Did/X-Moye-Sig headers for it. Caller must send this exact
 * `body` string as the request body (not re-serialize the object), so bytes match what was signed.
 */
export function didAuth(identity: Identity, payload: Record<string, unknown>): { body: string; headers: Record<string, string> } {
  const withTs = { ...payload, ts: payload.ts ?? Date.now() };
  const body = JSON.stringify(withTs);
  const sig = rawSign(identity.privateKeyPem, body);
  return { body, headers: { 'X-Moye-Did': identity.did, 'X-Moye-Sig': sig, 'Content-Type': 'application/json' } };
}

/** Deterministic JSON (recursively sorted keys) -- matches server.js's stableStringify, used for VCs. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Signs a VC payload (minus `sig`) the way an issuer would -- matches server.js's vcSigningPayload. */
export function signCredential(issuer: Identity, vcWithoutSig: Record<string, unknown>): string {
  return rawSign(issuer.privateKeyPem, stableStringify(vcWithoutSig));
}

/**
 * Registers a fresh agent via DID self-attestation (no PoW needed -- providing `pubkey` is its own
 * admission path per POST /api/agents). Returns the identity plus the assigned agent_id.
 */
export async function registerWithDid(request: APIRequestContext, name: string): Promise<Identity & { agent_id: string }> {
  const identity = generateIdentity();
  const res = await request.post('/a2a/api/agents', { data: { name, pubkey: identity.publicKeyPem } });
  const body = await res.json();
  expect(body.success, `registerWithDid(${name}) failed: ${body.error}`).toBeTruthy();
  expect(body.did, 'server-derived DID should match the locally-derived one').toBe(identity.did);
  return { ...identity, agent_id: body.agent_id };
}

/**
 * Encrypts a private-room message the way the browser/SDK client does (ADR-0018/ADR-0025), so
 * tests can post to `visibility: 'private'` rooms without tripping the server's R6 plaintext
 * rejection (server.js: `private room messages must set encrypted:true`). Key derivation must
 * match moye-identity.js::roomKey() / moye-agent-sdk.js exactly -- verified byte-compatible
 * against a real client's ciphertext during ADR-0018 SS10 room dogfooding.
 */
export function encryptForRoom(secret: string, roomId: string, plaintext: string): string {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from(roomId), Buffer.from('moye-room-e2e'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final(), cipher.getAuthTag()]);
  return iv.toString('base64') + ',' + ct.toString('base64');
}
