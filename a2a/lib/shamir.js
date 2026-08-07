'use strict';
/**
 * Minimal Shamir secret sharing over GF(256). Used for BIP-39 mnemonic social recovery
 * (ADR-0014 §6b / P4-3): default 3 shares, threshold = floor(n/2)+1 → 2-of-3.
 * English-only; no external deps.
 */

const crypto = require('crypto');

const LOG = new Uint8Array(256);
const EXP = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  EXP[255] = EXP[0];
  LOG[0] = 0;
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error('gf division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

/** Evaluate polynomial coeffs[0] + coeffs[1]*x + ... at x in GF(256). */
function evalPoly(coeffs, x) {
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    y = gfMul(y, x) ^ coeffs[i];
  }
  return y;
}

/**
 * Split secret bytes into n shares; any `threshold` reconstruct.
 * @returns {{ index: number, data: Buffer }[]}
 */
/**
 * Short digest of the secret, carried on every share of one split so combine() can tell
 * "these shares belong together and reconstructed correctly" from "you mixed up two share
 * sets and got plausible-looking garbage". Plain Shamir has no integrity check at all, and
 * silently returning a wrong key during a recovery ceremony is the worst possible failure
 * mode -- the holder cannot tell recovery went wrong.
 *
 * This is a mistake-detector, not a MAC: a truncated hash of the secret is inherently a
 * (very weak) oracle for guessing the secret, so it stays short and is only meaningful
 * against accidental mismatch, never against an attacker who already holds shares.
 */
function tagFor(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

/**
 * Split secret bytes into n shares; any `threshold` reconstruct.
 * @returns {{ index: number, data: Buffer, tag: string }[]}
 */
function split(secret, n = 3, threshold = null) {
  const buf = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
  if (!buf.length) throw new Error('empty secret');
  if (!Number.isInteger(n) || n < 2 || n > 255) throw new Error('n must be 2..255');
  const t = threshold == null ? Math.floor(n / 2) + 1 : threshold;
  if (!Number.isInteger(t) || t < 2 || t > n) throw new Error('invalid threshold');
  const tag = tagFor(buf);
  const shares = Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    data: Buffer.alloc(buf.length),
    tag,
  }));
  for (let bi = 0; bi < buf.length; bi++) {
    const coeffs = Buffer.alloc(t);
    coeffs[0] = buf[bi];
    for (let c = 1; c < t; c++) coeffs[c] = crypto.randomBytes(1)[0];
    for (let s = 0; s < n; s++) {
      shares[s].data[bi] = evalPoly(coeffs, shares[s].index);
    }
  }
  return shares;
}

/** Lagrange interpolation at x=0 for points (xs[i], ys[i]) in GF(256). */
function interpolate(xs, ys) {
  let secret = 0;
  for (let i = 0; i < xs.length; i++) {
    let num = 1;
    let den = 1;
    for (let j = 0; j < xs.length; j++) {
      if (i === j) continue;
      num = gfMul(num, xs[j]);
      den = gfMul(den, xs[j] ^ xs[i]);
    }
    secret ^= gfMul(ys[i], gfDiv(num, den));
  }
  return secret;
}

/**
 * Combine any `threshold` shares back to the secret.
 * @param {{ index: number, data: Buffer|string }[]} shares
 */
function combine(shares) {
  if (!Array.isArray(shares) || shares.length < 2) throw new Error('need at least 2 shares');
  const parsed = shares.map((s) => ({
    index: Number(s.index),
    data: Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data, typeof s.data === 'string' && /^[0-9a-f]+$/i.test(s.data) ? 'hex' : 'base64'),
  }));
  const len = parsed[0].data.length;
  if (!parsed.every((s) => s.data.length === len && s.index >= 1 && s.index <= 255)) {
    throw new Error('malformed shares');
  }
  // Shares carrying different tags provably come from different splits -- reject before
  // doing the math, so the caller gets a clear cause instead of a wrong secret.
  const tags = shares.map((s) => s.tag).filter((t) => typeof t === 'string' && t);
  if (tags.length > 1 && new Set(tags).size > 1) {
    throw new Error('shares are from different splits (tag mismatch)');
  }
  const out = Buffer.alloc(len);
  const xs = parsed.map((s) => s.index);
  for (let bi = 0; bi < len; bi++) {
    const ys = parsed.map((s) => s.data[bi]);
    out[bi] = interpolate(xs, ys);
  }
  // Untagged shares (older splits) still work, but when a tag is present it must match the
  // reconstruction -- this is what catches a mixed-up set that happens to share a tag field.
  if (tags.length && tagFor(out) !== tags[0]) {
    throw new Error('reconstruction failed integrity check (wrong or mixed shares)');
  }
  return out;
}

/** Default MOYE recovery: 3 shares, threshold floor(3/2)+1 = 2. */
function split2of3(secret) {
  return split(secret, 3, 2);
}

module.exports = { split, combine, split2of3, gfMul, gfDiv };
