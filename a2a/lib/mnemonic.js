'use strict';
/**
 * P4-3 (ADR-0014 §6b): BIP-39 English mnemonic → deterministic Ed25519 via SLIP-0010.
 * NEW identities only — existing randomly generated keys cannot be retrofitted to a mnemonic.
 */
const bip39 = require('bip39');
const slip = require('./slip0010');
const shamir = require('./shamir');

const PATH = "m/10086'/0'";
const EXISTING_IDENTITY_NOTE =
  'Mnemonic derivation applies to NEW identities only. Existing randomly generated keys cannot be retrofitted to a BIP-39 mnemonic.';

function generateMnemonic(strength = 256) {
  // 256-bit entropy → 24 English words
  return bip39.generateMnemonic(strength);
}

function mnemonicToSeed(mnemonic, passphrase = '') {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('invalid BIP-39 mnemonic');
  return bip39.mnemonicToSeedSync(mnemonic, passphrase);
}

/** Derive Ed25519 PKCS8 PEM + DID from a 24-word mnemonic (deterministic). */
function deriveFromMnemonic(mnemonic, passphrase = '') {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const derived = slip.derive(seed, PATH);
  return {
    mnemonic,
    path: PATH,
    privateKeyPem: derived.privateKeyPem,
    publicKeyPem: derived.publicKeyPem,
    did: derived.did,
    note: EXISTING_IDENTITY_NOTE,
  };
}

/**
 * Split the mnemonic UTF-8 string into Shamir 2-of-3 shares (hex data).
 * Guardians each hold one share; any two reconstruct the mnemonic.
 */
function splitMnemonic(mnemonic, n = 3) {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('invalid BIP-39 mnemonic');
  const threshold = Math.floor(n / 2) + 1;
  const shares = shamir.split(Buffer.from(mnemonic, 'utf8'), n, threshold);
  return {
    n,
    threshold,
    shares: shares.map((s) => ({ index: s.index, data: s.data.toString('hex') })),
    note: EXISTING_IDENTITY_NOTE,
  };
}

function combineMnemonic(shares) {
  const buf = shamir.combine(shares);
  const mnemonic = buf.toString('utf8');
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('combined shares did not yield a valid mnemonic');
  return mnemonic;
}

module.exports = {
  generateMnemonic,
  mnemonicToSeed,
  deriveFromMnemonic,
  splitMnemonic,
  combineMnemonic,
  EXISTING_IDENTITY_NOTE,
  PATH,
};
