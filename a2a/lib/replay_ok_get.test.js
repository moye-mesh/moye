'use strict';
/**
 * Unit-level check for GET-auth idempotent replay (mirrors server.js replayOk).
 * Full authAgent needs a live node; this locks the policy the watcher depends on.
 */
function replayOk(sig, body, opts = {}) {
  const REPLAY_WINDOW_MS = 5 * 60 * 1000;
  const seenSigs = replayOk._map || (replayOk._map = new Map());
  const now = Date.now();
  const ts = Number(body && body.ts);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return false;
  if (seenSigs.has(sig)) {
    if (opts.idempotent) {
      const exp = seenSigs.get(sig);
      return Number.isFinite(exp) && exp >= now;
    }
    return false;
  }
  seenSigs.set(sig, ts + REPLAY_WINDOW_MS);
  return true;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ts = Date.now();
assert(replayOk('sigA', { ts }, { idempotent: true }) === true, 'first spend');
assert(replayOk('sigA', { ts }, { idempotent: true }) === true, 'GET retry allowed');
assert(replayOk('sigB', { ts }) === true, 'POST first');
assert(replayOk('sigB', { ts }) === false, 'POST replay denied');

console.log('ALL_OK replayOk_idempotent_get');
