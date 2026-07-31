'use strict';
// moye-net: self-sovereign DID identity (Ed25519)
//
//   did:moye:f1220<64 hex>      = multibase 'f' (base16) + multihash(sha2-256, 32 bytes) + digest
//
// At registration the agent submits its public key (Ed25519 PEM); the server only ever stores the
// public key and never holds the private key -- that's what makes it self-sovereign.
//
// ---- Why this shape (ADR-0017, 2026-07-25) ----
// The identifier used to be sha256(der) TRUNCATED to 32 hex = 128 bit. For sheer identity COUNT that
// was never the problem (even 10^12 agents collide with probability ~1/6.8e14). The problem is that
// truncating to n bits leaves only n/2 bits of COLLISION resistance -- 2^64 here, which is below
// modern standards, and a collision is genuinely exploitable because the DID is used as a primary key
// for credentials (vcKey), revocation (revoke:<did>) and login resolution (/api/agents/by-did).
//
// The digest is no longer truncated (2^128 collision resistance), and the identifier is now
// SELF-DESCRIBING: the multihash prefix states the algorithm and length, so moving to SHA-3, BLAKE3
// or a post-quantum hash later is a prefix change rather than another identifier migration.
//
// Changed as a clean break with no v1 compatibility: verified on 2026-07-25 that production held
// zero registered agents in SQLite, zero reputation, zero credentials and zero address attestations
// -- only throwaway test identities. There was nothing to preserve, and that window closes for good
// the moment real identities start accruing history.
const crypto = require('crypto');

const MULTIBASE_BASE16 = 'f';
const MULTIHASH_SHA2_256 = '1220'; // 0x12 = sha2-256, 0x20 = 32-byte digest

function pubKeyFingerprint(pubPem) {
  const der = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  return MULTIBASE_BASE16 + MULTIHASH_SHA2_256 + crypto.createHash('sha256').update(der).digest('hex');
}

function deriveDid(pubPem) {
  return 'did:moye:' + pubKeyFingerprint(pubPem);
}

// Format check only -- says nothing about whether the DID is registered or controlled by the caller.
// Deliberately accepts any multihash algorithm/length so a future hash change doesn't require
// touching every validation site; only the overall shape is pinned.
const DID_RE = /^did:moye:f[0-9a-f]{4,}$/;
function isValidDid(did) {
  if (typeof did !== 'string' || did.length > 256 || !DID_RE.test(did)) return false;
  const body = did.slice('did:moye:f'.length);
  if (body.length % 2 !== 0) return false;              // hex must be whole bytes
  const declaredLen = parseInt(body.slice(2, 4), 16);   // multihash length byte
  return body.length === 4 + declaredLen * 2;           // prefix(2) + len(2) + digest
}

// Sign: msg string -> base64
function sign(privatePem, msg) {
  const pk = crypto.createPrivateKey(privatePem);
  const sig = crypto.sign(null, Buffer.from(msg, 'utf8'), pk);
  return sig.toString('base64');
}

// Verify signature
function verify(pubPem, msg, sigB64) {
  try {
    const pk = crypto.createPublicKey(pubPem);
    return crypto.verify(null, Buffer.from(msg, 'utf8'), pk, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// Generate a new identity (returns {did, privateKey, publicKey}) -- used on the SDK/agent side
function generateIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  return { did: deriveDid(pub), privateKey: priv, publicKey: pub };
}

module.exports = { deriveDid, pubKeyFingerprint, isValidDid, sign, verify, generateIdentity };
