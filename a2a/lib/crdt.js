'use strict';
// Rich CRDT merge laws (F4). Self-contained, no Automerge. Each value carries a `crdt` tag; values
// WITHOUT a tag are never routed here -- callers keep using the existing LWW path unchanged, so
// existing shared state is entirely unaffected. All laws are commutative/associative/idempotent so
// nodes converge regardless of message order.
//
// Value shapes:
//   gcounter : { crdt:'gcounter', p:{ [writer]: n } }                 read = sum(p)
//   pncounter: { crdt:'pncounter', p:{...}, n:{...} }                 read = sum(p) - sum(n)
//   orset    : { crdt:'orset', adds:{ [tag]: elem }, removes:[tag] }  members = adds whose tag not removed
//   rga      : { crdt:'rga', nodes:[ {id, after, elem, deleted} ] }   ordered, tombstoned list

function mergeCounter(a, b, field) {
  const out = {};
  for (const src of [a && a[field], b && b[field]]) {
    if (!src) continue;
    for (const [w, n] of Object.entries(src)) out[w] = Math.max(out[w] || 0, Number(n) || 0);
  }
  return out;
}
function merge(type, cur, incoming) {
  switch (type) {
    case 'gcounter':
      return { crdt: 'gcounter', p: mergeCounter(cur, incoming, 'p') };
    case 'pncounter':
      return { crdt: 'pncounter', p: mergeCounter(cur, incoming, 'p'), n: mergeCounter(cur, incoming, 'n') };
    case 'orset': {
      const adds = { ...(cur && cur.adds), ...(incoming && incoming.adds) };
      const removes = Array.from(new Set([...(cur && cur.removes || []), ...(incoming && incoming.removes || [])]));
      return { crdt: 'orset', adds, removes };
    }
    case 'rga': {
      // union nodes by id; a node is deleted if either side tombstoned it;
      // order by (elem.ts, id) so random newId() hex ids don't scramble chat chronology
      const byId = new Map();
      for (const src of [cur && cur.nodes, incoming && incoming.nodes]) {
        if (!Array.isArray(src)) continue;
        for (const nd of src) {
          const prev = byId.get(nd.id);
          byId.set(nd.id, prev ? { ...prev, deleted: prev.deleted || nd.deleted } : { ...nd });
        }
      }
      const nodes = [...byId.values()].sort((x, y) => {
        const tx = (x.elem && x.elem.ts) || 0;
        const ty = (y.elem && y.elem.ts) || 0;
        if (tx !== ty) return tx - ty;
        return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
      });
      return { crdt: 'rga', nodes };
    }
    default:
      return null; // unknown type -> caller falls back to LWW
  }
}
// Materialize a CRDT value to its readable form (what GET /api/shared-state should surface).
function read(value) {
  if (!value || typeof value !== 'object') return value;
  switch (value.crdt) {
    case 'gcounter': return Object.values(value.p || {}).reduce((s, n) => s + (Number(n) || 0), 0);
    case 'pncounter': {
      const sum = o => Object.values(o || {}).reduce((s, n) => s + (Number(n) || 0), 0);
      return sum(value.p) - sum(value.n);
    }
    case 'orset': {
      const removed = new Set(value.removes || []);
      return Object.entries(value.adds || {}).filter(([tag]) => !removed.has(tag)).map(([, el]) => el);
    }
    case 'rga': return (value.nodes || []).filter(n => !n.deleted).map(n => n.elem);
    default: return value;
  }
}
const KNOWN = new Set(['gcounter', 'pncounter', 'orset', 'rga']);
function isCrdt(value) { return !!(value && typeof value === 'object' && KNOWN.has(value.crdt)); }
module.exports = { merge, read, isCrdt, KNOWN };
