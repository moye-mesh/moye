'use strict';
// moye-net: this node's own Ed25519 identity, used to sign federation governance votes
// (distinct from an agent's DID identity). The private key is generated on first startup and
// persisted to a local file, then reused thereafter; each node has its own independent identity.
const fs = require('fs');
const path = require('path');
const didlib = require('./did');

const NODE_ID = process.env.NODE_ID || 'seed1';
const DATA_DIR = path.join(__dirname, '..', 'data');
const IDENTITY_FILE = path.join(DATA_DIR, `${NODE_ID}-node-identity.pem`);

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let privateKey;
  if (fs.existsSync(IDENTITY_FILE)) {
    privateKey = fs.readFileSync(IDENTITY_FILE, 'utf8');
  } else {
    const identity = didlib.generateIdentity();
    privateKey = identity.privateKey;
    // mode 0600: this node's private key file -- other users on the same host shouldn't be able to read it
    fs.writeFileSync(IDENTITY_FILE, privateKey, { mode: 0o600 });
  }
  const publicKey = require('crypto').createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const did = didlib.deriveDid(publicKey);
  return { nodeId: NODE_ID, did, privateKey, publicKey };
}

const identity = load();

function sign(msg) { return didlib.sign(identity.privateKey, msg); }

module.exports = {
  nodeId: identity.nodeId,
  did: identity.did,
  publicKey: identity.publicKey,
  sign,
};
