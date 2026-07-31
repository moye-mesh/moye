'use strict';
// SLIP-0010 hierarchical deterministic key derivation for Ed25519 (ADR-0022 T2 / ADR-0020 N2).
// Ed25519 cannot use BIP32 public derivation — only hardened child keys are defined.
//
// Paths used by MOYE (purpose coin-type style, all hardened):
//   m/10086'/0'     root identity key
//   m/10086'/1'/i'  session / delegated instance i
//   m/10086'/2'/i'  room / encryption purpose i
// (10086 = "moye" numeric tag; not an official SLIP registered coin type.)

const crypto = require('crypto');
const didlib = require('./did');

const ED25519_SEED_KEY = Buffer.from('ed25519 seed', 'utf8');
const HARDENED = 0x80000000;

function hmacSha512(key, data) {
  return crypto.createHmac('sha512', key).update(data).digest();
}

function masterFromSeed(seed) {
  const s = Buffer.isBuffer(seed) ? seed : Buffer.from(seed, typeof seed === 'string' && /^[0-9a-f]+$/i.test(seed) ? 'hex' : 'utf8');
  if (s.length < 16) throw new Error('seed too short (need >= 16 bytes)');
  const I = hmacSha512(ED25519_SEED_KEY, s);
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

function deriveHardened(parentKey, parentChain, index) {
  if (index >= HARDENED) throw new Error('index already hardened; pass unhardened index 0..2^31-1');
  const data = Buffer.alloc(1 + 32 + 4);
  data[0] = 0x00;
  parentKey.copy(data, 1);
  data.writeUInt32BE(index + HARDENED, 33);
  const I = hmacSha512(parentChain, data);
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

/** Parse path like "m/10086'/0'" or "m/10086'/1'/3'" → [10086, 0] or [10086, 1, 3] (unhardened indices). */
function parsePath(path) {
  if (typeof path !== 'string' || !path.startsWith('m')) throw new Error('path must start with m');
  const parts = path.split('/').slice(1);
  return parts.map((p) => {
    const hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
    const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
    if (!Number.isFinite(n) || n < 0 || n >= HARDENED) throw new Error('bad path segment: ' + p);
    if (!hardened) throw new Error('SLIP-0010 Ed25519 requires hardened segments (append \'): ' + p);
    return n;
  });
}

/**
 * Derive an Ed25519 keypair from seed + path.
 * @returns {{ privateKeyPem, publicKeyPem, did, path, rawPrivateKey: Buffer }}
 */
function derive(seed, path) {
  const indices = parsePath(path);
  let { key, chainCode } = masterFromSeed(seed);
  for (const idx of indices) {
    ({ key, chainCode } = deriveHardened(key, chainCode, idx));
  }
  // Node crypto: createPrivateKey from raw 32-byte Ed25519 seed (PKCS8 wrapping).
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
    key,
  ]);
  const privateKeyPem = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  const did = didlib.deriveDid(publicKeyPem);
  return { privateKeyPem, publicKeyPem, did, path, rawPrivateKey: Buffer.from(key) };
}

/** Convenience: root identity at m/10086'/0' */
function deriveIdentity(seed) {
  return derive(seed, "m/10086'/0'");
}

/** Convenience: delegated instance i at m/10086'/1'/i' */
function deriveInstance(seed, i) {
  if (!Number.isInteger(i) || i < 0) throw new Error('instance index must be a non-negative integer');
  return derive(seed, `m/10086'/1'/${i}'`);
}

module.exports = {
  derive, deriveIdentity, deriveInstance, parsePath, masterFromSeed,
  MOYE_PURPOSE: 10086,
  PATHS: {
    identity: "m/10086'/0'",
    instance: (i) => `m/10086'/1'/${i}'`,
    room: (i) => `m/10086'/2'/${i}'`,
  },
};
