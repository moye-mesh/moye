'use strict';
/**
 * P4-4 (ADR-0014 §6c): DNS TXT verification for `_moye.<domain>` containing the agent DID.
 * Injectable resolver for tests — default is dns.promises.resolveTxt.
 */
const dns = require('dns').promises;

let resolveTxtImpl = defaultResolveTxt;

function defaultResolveTxt(hostname) {
  // Test hook: DOMAIN_VERIFY_MOCK_JSON='{"example.com":"did:moye:..."}' maps domain → DID
  // (looked up as _moye.<domain>). estimated: test-only; not used in production.
  const raw = process.env.DOMAIN_VERIFY_MOCK_JSON;
  if (raw) {
    try {
      const map = JSON.parse(raw);
      const domain = hostname.startsWith('_moye.') ? hostname.slice('_moye.'.length) : hostname;
      if (Object.prototype.hasOwnProperty.call(map, domain)) {
        const v = map[domain];
        if (v == null) {
          const err = new Error('ENOTFOUND');
          err.code = 'ENOTFOUND';
          return Promise.reject(err);
        }
        return Promise.resolve([[String(v)]]);
      }
    } catch { /* fall through to real DNS */ }
  }
  return dns.resolveTxt(hostname);
}

function setResolveTxt(fn) {
  resolveTxtImpl = typeof fn === 'function' ? fn : defaultResolveTxt;
}

function resetResolveTxt() {
  resolveTxtImpl = defaultResolveTxt;
}

function normalizeDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!d || d.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d)) return null;
  if (d.includes('..') || d.startsWith('.') || d.endsWith('.')) return null;
  return d;
}

function flattenTxt(records) {
  const out = [];
  for (const chunk of records || []) {
    if (Array.isArray(chunk)) out.push(chunk.join(''));
    else if (typeof chunk === 'string') out.push(chunk);
  }
  return out;
}

/**
 * Check `_moye.<domain>` TXT for an exact DID match (or `did=<did>` / `moye-did=<did>`).
 * @returns {{ ok: boolean, domain: string|null, host: string|null, records: string[], error?: string }}
 */
async function verifyDomainDid(domain, did) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, domain: null, host: null, records: [], error: 'invalid domain' };
  if (typeof did !== 'string' || !did.startsWith('did:moye:')) {
    return { ok: false, domain: d, host: null, records: [], error: 'did required' };
  }
  const host = '_moye.' + d;
  let records = [];
  try {
    records = flattenTxt(await resolveTxtImpl(host));
  } catch (e) {
    return { ok: false, domain: d, host, records: [], error: 'DNS lookup failed: ' + (e && e.code || e.message || e) };
  }
  const hit = records.some((r) => {
    const t = String(r).trim();
    if (t === did) return true;
    if (t === 'did=' + did || t === 'moye-did=' + did) return true;
    // Allow whitespace-separated multi-value TXT
    return t.split(/\s+/).includes(did);
  });
  return { ok: hit, domain: d, host, records, error: hit ? undefined : 'DID not found in _moye TXT' };
}

function verifiedDisplayName(agentName, domain) {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const local = String(agentName || 'agent').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'agent';
  return local + '@' + d;
}

module.exports = {
  setResolveTxt,
  resetResolveTxt,
  normalizeDomain,
  verifyDomainDid,
  verifiedDisplayName,
};
