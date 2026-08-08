'use strict';
/**
 * ADR-0038 M8: agent profile field signing.
 * DID signs name/description/capabilities/endpoint/webhook_url at registration;
 * clients re-verify against the agent's pubkey on GET /api/agents/:id.
 */
const didlib = require('./did');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** Canonical bytes the agent DID signs / verifies. */
function profilePayload({ name, description, capabilities, endpoint, webhook_url }) {
  return {
    name: name || '',
    description: description || '',
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    endpoint: endpoint || '',
    webhook_url: webhook_url || null,
  };
}

function profileCanon(fields) {
  return stableStringify(profilePayload(fields));
}

function signProfile(privatePem, fields) {
  return didlib.sign(privatePem, profileCanon(fields));
}

function verifyProfile(pubPem, fields, sigB64) {
  if (!pubPem || !sigB64) return false;
  return didlib.verify(pubPem, profileCanon(fields), sigB64);
}

module.exports = {
  stableStringify,
  profilePayload,
  profileCanon,
  signProfile,
  verifyProfile,
};
