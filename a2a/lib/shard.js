'use strict';
// ADR-0008: consistent-hash directory sharding. The actual bottleneck to "serve an unbounded number
// of agents" isn't message throughput (already node-local, effectively sharded by home_node), it's
// the agent/room DIRECTORY -- today every federation node holds a full in-memory copy and republishes
// a full manifest on every single write (see ipfs_store.js), so total directory capacity is capped
// by the WEAKEST node's memory, and adding nodes increases availability but not capacity at all.
//
// This module gives any node/id a deterministic shard assignment. NUM_SHARDS defaults to 1 (sharding
// disabled -- every id maps to shard 0, exactly today's "everyone holds everything" behavior; nothing
// changes for the current 3-node deployment unless an operator opts in). Set NUM_SHARDS higher and
// SERVED_SHARDS to a subset to let a node deliberately hold only a slice of the global directory --
// see ipfs_store.js's merge-time filtering, which is where this actually takes effect.
const crypto = require('crypto');

const NUM_SHARDS = Math.max(1, parseInt(process.env.NUM_SHARDS || '1', 10));

function shardOf(id, numShards = NUM_SHARDS) {
  if (numShards <= 1) return 0;
  // sha256 rather than a fast non-crypto hash -- this only runs per write/lookup, not per byte of a
  // large payload, so the cost is negligible, and it avoids any hash-flooding weirdness with
  // adversarial ids skewing shard distribution (agent ids are also crypto.randomBytes-derived
  // already, so distribution would likely be fine either way, but no reason not to be consistent).
  const digest = crypto.createHash('sha256').update(String(id)).digest();
  // first 4 bytes as an unsigned 32-bit int, modulo numShards
  const n = digest.readUInt32BE(0);
  return n % numShards;
}

// Parses SERVED_SHARDS env format: "" or "all" = every shard (default, matches NUM_SHARDS=1 always
// serving shard 0); "0-15" or "0,3,7-9" = explicit ranges/list. Returns a Set<number> or null (null
// means "all shards", represented this way so isResponsible() can short-circuit without building a
// potentially huge Set when NUM_SHARDS is large and this node serves everything).
function parseServedShards(spec, numShards = NUM_SHARDS) {
  const s = (spec || '').trim();
  if (!s || s.toLowerCase() === 'all') return null;
  const out = new Set();
  for (const part of s.split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      const lo = Math.max(0, parseInt(m[1], 10)), hi = Math.min(numShards - 1, parseInt(m[2], 10));
      for (let i = lo; i <= hi; i++) out.add(i);
    } else {
      const n = parseInt(part, 10);
      if (Number.isFinite(n) && n >= 0 && n < numShards) out.add(n);
    }
  }
  return out;
}

const SERVED_SHARDS = parseServedShards(process.env.SERVED_SHARDS, NUM_SHARDS); // null = all

function isResponsibleFor(id) {
  if (SERVED_SHARDS === null) return true; // this node serves every shard (default / NUM_SHARDS=1)
  return SERVED_SHARDS.has(shardOf(id));
}

function servedShardsList() {
  if (SERVED_SHARDS === null) return NUM_SHARDS <= 1 ? [0] : 'all';
  return [...SERVED_SHARDS].sort((a, b) => a - b);
}

// --- P2-3 routing policy (env-tunable estimates; NOT validated at 10^5) ---
// SHARD_ROUTE_MODE: '307' (default) | 'proxy' | 'hint' (legacy 404+hint only)
const ROUTE_MODE = (process.env.SHARD_ROUTE_MODE || '307').toLowerCase();
// How long a proxy forward may wait on the peer (ms). estimated, no real load data as of 2026-08-06
const FORWARD_TIMEOUT_MS = Math.max(500, parseInt(process.env.SHARD_FORWARD_TIMEOUT_MS || '3000', 10));
// Max redirect/proxy hops to avoid loops. estimated, no real load data as of 2026-08-06
const FORWARD_MAX_HOPS = Math.max(1, parseInt(process.env.SHARD_FORWARD_MAX_HOPS || '1', 10));
// Cap distinct peers to fan out list/search queries across. estimated, no real load data as of 2026-08-06
const QUERY_FANOUT_MAX = Math.max(1, parseInt(process.env.SHARD_QUERY_FANOUT_MAX || '8', 10));
// When 1, also announce/lookup shard:<n> via DHT providers (ADR-0008 gap). Off by default.
const ENABLE_SHARD_DHT = process.env.ENABLE_SHARD_DHT === '1';

module.exports = {
  NUM_SHARDS, shardOf, parseServedShards, isResponsibleFor, servedShardsList,
  ROUTE_MODE, FORWARD_TIMEOUT_MS, FORWARD_MAX_HOPS, QUERY_FANOUT_MAX, ENABLE_SHARD_DHT,
};
