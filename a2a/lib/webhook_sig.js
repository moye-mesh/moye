'use strict';
/**
 * ADR-0038 M9: node-signed webhook pushes.
 * Signs {event, id, from_agent, to_agent, content_hash, attachments_hash, ts}
 * plus room_id when the push is a room_message. Inbox `event: message` omits room_id
 * so existing DM signatures stay valid.
 */
const crypto = require('crypto');
const didlib = require('./did');
const { stableStringify } = require('./agent_profile');

function contentHash(content) {
  if (content === undefined || content === null) return null;
  return crypto.createHash('sha256').update(String(content)).digest('hex');
}

/** Same treatment as contentHash, for the attachments array (fixes ADR-0038 follow-up: the
 *  signature originally covered content but not attachments, so an in-flight attacker on an
 *  unencrypted http:// webhook_url could strip/alter attachments without breaking X-Moye-Sig). */
function attachmentsHash(attachments) {
  if (attachments === undefined || attachments === null) return null;
  const arr = Array.isArray(attachments) ? attachments : [attachments];
  if (!arr.length) return null;
  return crypto.createHash('sha256').update(stableStringify(arr)).digest('hex');
}

function webhookSignPayload(payload) {
  const fields = {
    event: payload.event || null,
    id: payload.id || null,
    from_agent: payload.from_agent || null,
    to_agent: payload.to_agent || null,
    content_hash: Object.prototype.hasOwnProperty.call(payload, 'content_hash')
      ? payload.content_hash
      : contentHash(payload.content),
    attachments_hash: Object.prototype.hasOwnProperty.call(payload, 'attachments_hash')
      ? payload.attachments_hash
      : attachmentsHash(payload.attachments),
    ts: payload.ts || null,
  };
  // Room pushes only. Omitted on inbox `event: message` so existing DM signatures stay valid.
  if (payload.room_id) fields.room_id = payload.room_id;
  return fields;
}

function signWebhook(nodeSignFn, payload) {
  const fields = webhookSignPayload(payload);
  return { fields, sig: nodeSignFn(stableStringify(fields)) };
}

function verifyWebhook(nodePubPem, payload, sigB64) {
  if (!nodePubPem || !sigB64) return false;
  const fields = webhookSignPayload(payload);
  // A real wire delivery includes BOTH the raw content/attachments AND their hashes (deliverWebhook
  // spreads ...payload, which has the raw fields, then adds content_hash/attachments_hash on top).
  // Checking the signature alone is not enough: webhookSignPayload prefers an explicit hash field
  // when present, so an attacker who rewrites the raw `attachments` in transit while leaving the
  // (now stale) `attachments_hash` untouched would still pass a signature-only check -- the
  // signature covers the hash value, not the raw bytes, and the stale hash is still the one that
  // was originally signed.
  //
  // Gating this on "both fields present" was itself incomplete: an attacker who simply DELETES the
  // `attachments` field (rather than rewriting it) leaves `attachments_hash` untouched and the
  // hasOwnProperty check false, so the cross-check was silently skipped and the stripped payload
  // still verified. Fixed by keying off whether the signed hash is non-null, not whether the raw
  // field happens to still be present: if `fields.attachments_hash` says attachments were signed,
  // the raw field must actually be there and match -- "missing" is a mismatch, not an exemption.
  if (fields.content_hash != null
    && (!Object.prototype.hasOwnProperty.call(payload, 'content')
      || contentHash(payload.content) !== fields.content_hash)) return false;
  if (fields.attachments_hash != null
    && (!Object.prototype.hasOwnProperty.call(payload, 'attachments')
      || attachmentsHash(payload.attachments) !== fields.attachments_hash)) return false;
  return didlib.verify(nodePubPem, stableStringify(fields), sigB64);
}

module.exports = {
  contentHash,
  attachmentsHash,
  webhookSignPayload,
  signWebhook,
  verifyWebhook,
};
