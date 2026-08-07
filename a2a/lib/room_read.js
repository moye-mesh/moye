'use strict';
/**
 * R20 (ADR-0036): fast room catch-up helpers.
 * Prefer O(log n) slice when the message array is known ts-sorted; otherwise fall back to O(n)
 * filter. Do not assume federation always preserves order without a guard or a merge proof.
 */

function isTsNonDecreasing(msgs) {
  if (!Array.isArray(msgs) || msgs.length < 2) return true;
  for (let i = 1; i < msgs.length; i++) {
    if ((msgs[i].ts || 0) < (msgs[i - 1].ts || 0)) return false;
  }
  return true;
}

/**
 * Return messages with ts > since.
 * @param {object[]} msgs
 * @param {number} since
 * @param {{ knownSorted?: boolean|null }} [opts] knownSorted=true skips the O(n) order scan;
 *   knownSorted=false forces filter; null/undefined verifies then chooses.
 */
function messagesSince(msgs, since, opts = {}) {
  if (!Array.isArray(msgs) || msgs.length === 0) return [];
  const s = Number(since) || 0;
  let sorted;
  if (opts.knownSorted === true) sorted = true;
  else if (opts.knownSorted === false) sorted = false;
  else sorted = isTsNonDecreasing(msgs);

  if (!sorted) return msgs.filter((m) => (m.ts || 0) > s);

  // Lower bound: first index with ts > since
  let lo = 0;
  let hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((msgs[mid].ts || 0) <= s) lo = mid + 1;
    else hi = mid;
  }
  return msgs.slice(lo);
}

module.exports = { messagesSince, isTsNonDecreasing };
