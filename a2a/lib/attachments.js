'use strict';
// N1 (ADR-0020 / ADR-0021): attachment metadata on messages / room messages.
// Server stores CID + metadata only — never the bytes. Clients upload/pin elsewhere.

const MAX_ATTACHMENTS = 16;
const MAX_NAME_LEN = 256;
// CIDv0 (Qm…) or CIDv1 multibase (bafy…, bafk…, etc.). Deliberately permissive on charset;
// the IPFS daemon is the final authority when someone cats the CID.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{10,})$/;

function normalizeAttachments(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    const err = new Error('attachments must be an array');
    err.status = 400;
    throw err;
  }
  if (raw.length === 0) return null;
  if (raw.length > MAX_ATTACHMENTS) {
    const err = new Error(`attachments: at most ${MAX_ATTACHMENTS}`);
    err.status = 413;
    throw err;
  }
  return raw.map((a, i) => {
    if (!a || typeof a !== 'object') {
      const err = new Error(`attachments[${i}]: object required`);
      err.status = 400;
      throw err;
    }
    const cid = (a.cid || '').toString().trim();
    if (!cid || !CID_RE.test(cid)) {
      const err = new Error(`attachments[${i}]: invalid cid`);
      err.status = 400;
      throw err;
    }
    const name = a.name != null ? String(a.name).slice(0, MAX_NAME_LEN) : null;
    const size = a.size != null ? Number(a.size) : null;
    if (size != null && (!Number.isFinite(size) || size < 0)) {
      const err = new Error(`attachments[${i}]: invalid size`);
      err.status = 400;
      throw err;
    }
    const media_type = a.media_type != null ? String(a.media_type).slice(0, 128) : null;
    const sha256 = a.sha256 != null ? String(a.sha256).toLowerCase() : null;
    if (sha256 != null && !/^[0-9a-f]{64}$/.test(sha256)) {
      const err = new Error(`attachments[${i}]: sha256 must be 64 hex chars`);
      err.status = 400;
      throw err;
    }
    // Private-room / E2E: client encrypts bytes before upload; mark so receivers know to decrypt.
    const encrypted = !!a.encrypted;
    return { cid, name, size, media_type, sha256, encrypted };
  });
}

module.exports = { normalizeAttachments, MAX_ATTACHMENTS, CID_RE };
