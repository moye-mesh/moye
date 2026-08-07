'use strict';
/**
 * ADR-0027 D1/D3 (R10/R12): room ask/resolve materialization.
 *
 * - Single-string `awaiting`: any resolve closes (legacy, unchanged).
 * - Array `awaiting`: N-of-M with N=M — each target's resolve marks that target done;
 *   ask stays open until every target has resolved (same per-voter tally shape as seeds multisig).
 * - `awaiting_capability`: at query time, room members with that capability are eligible;
 *   first resolve from an eligible agent closes the ask (claim-style).
 * - Capability may be used alone or alongside explicit awaiting id(s); when capability is set,
 *   close semantics are first-wins among the eligible set (explicit targets ∪ capable members).
 */
const schema = require('./schema');

function normalizeAwaitingList(awaiting) {
  if (awaiting == null || awaiting === '') return [];
  if (typeof awaiting === 'string') return [awaiting];
  if (Array.isArray(awaiting)) {
    return awaiting.filter((x) => typeof x === 'string' && x.length > 0);
  }
  return null; // invalid shape
}

function agentMatchesAwaiting(who, agent) {
  if (!who || !agent) return false;
  return who === agent.id || who === agent.did || (agent.did && who === agent.did);
}

function agentHasCapability(agent, capName) {
  if (!agent || !capName) return false;
  return (agent.capabilities || []).some((c) => schema.capName(c) === capName);
}

function resolveFromMatchesWho(resolveMsg, who, getAgent) {
  if (!resolveMsg || !who) return false;
  if (resolveMsg.from_agent === who) return true;
  const from = getAgent(resolveMsg.from_agent);
  return agentMatchesAwaiting(who, from);
}

function roomMemberAgents(room, getAgent) {
  const ids = new Set([room.creator, ...(room.member_ids || [])].filter(Boolean));
  const out = [];
  for (const id of ids) {
    const a = getAgent(id);
    if (a) out.push(a);
  }
  return out;
}

function eligibleForCapabilityAsk(ask, room, getAgent) {
  const targets = normalizeAwaitingList(ask.awaiting) || [];
  const byId = new Map(); // agent.id → agent
  for (const t of targets) {
    // Prefer resolving t as agent id; also accept did-only markers as opaque strings.
    const a = getAgent(t) || null;
    if (a) byId.set(a.id, a);
    else byId.set(t, { id: t, did: t.startsWith('did:') ? t : null, capabilities: [] });
  }
  if (ask.awaiting_capability && room) {
    for (const a of roomMemberAgents(room, getAgent)) {
      if (agentHasCapability(a, ask.awaiting_capability)) byId.set(a.id, a);
    }
  }
  return [...byId.values()];
}

function resolveIsEligible(resolveMsg, ask, room, getAgent) {
  const from = getAgent(resolveMsg.from_agent);
  if (!from) return false;
  if (ask.awaiting_capability) {
    const eligible = eligibleForCapabilityAsk(ask, room, getAgent);
    return eligible.some((a) => a.id === from.id || agentMatchesAwaiting(a.id, from) || agentMatchesAwaiting(a.did, from));
  }
  const targets = normalizeAwaitingList(ask.awaiting) || [];
  if (Array.isArray(ask.awaiting)) {
    return targets.some((t) => resolveFromMatchesWho(resolveMsg, t, getAgent));
  }
  // Legacy single-string: any resolve counts (caller may short-circuit).
  return true;
}

/**
 * @returns {object[]} open ask messages (enriched for multi-target)
 */
function materializeRoomAwaiting(roomId, { getRoom, getShared, roomChatKey, getAgent }) {
  const room = getRoom(roomId);
  const msgs = getShared(roomChatKey(roomId)) || [];
  const asks = new Map();
  const resolvesByRef = new Map();

  for (const m of msgs) {
    if (m.type === 'ask' && (m.awaiting != null || m.awaiting_capability)) {
      asks.set(m.id, m);
    }
    if (m.type === 'resolve' && m.ref) {
      if (!resolvesByRef.has(m.ref)) resolvesByRef.set(m.ref, []);
      resolvesByRef.get(m.ref).push(m);
    }
  }

  const open = [];
  for (const ask of asks.values()) {
    const resolves = resolvesByRef.get(ask.id) || [];
    const targets = normalizeAwaitingList(ask.awaiting);
    if (targets === null) continue; // malformed awaiting — skip

    if (ask.awaiting_capability) {
      const hit = resolves.some((r) => resolveIsEligible(r, ask, room, getAgent));
      if (!hit) {
        open.push({
          ...ask,
          awaiting_mode: 'capability-first',
          awaiting_capability: ask.awaiting_capability,
        });
      }
      continue;
    }

    if (Array.isArray(ask.awaiting)) {
      // N-of-M with N = M (all targets).
      const resolvedTargets = [];
      const remaining = [];
      for (const t of targets) {
        if (resolves.some((r) => resolveFromMatchesWho(r, t, getAgent))) resolvedTargets.push(t);
        else remaining.push(t);
      }
      const total = targets.length;
      const votes = resolvedTargets.length;
      const threshold = total; // all-must-confirm; same tally fields as seeds (votes/threshold)
      if (votes < threshold) {
        open.push({
          ...ask,
          awaiting_mode: 'n-of-m',
          awaiting_total: total,
          awaiting_threshold: threshold,
          resolved_count: votes,
          resolved_targets: resolvedTargets,
          awaiting_remaining: remaining,
        });
      }
      continue;
    }

    // Single string (or absent list with only legacy awaiting string path): any resolve closes.
    if (resolves.length === 0) open.push({ ...ask, awaiting_mode: 'single' });
  }
  return open;
}

/** True if this open ask still concerns `who` (agent id or did) / `agent`. */
function askConcernsAgent(ask, who, agent, room) {
  if (!ask) return false;
  // Prefer enriched awaiting_remaining when present (multi-target partial).
  if (Array.isArray(ask.awaiting_remaining)) {
    return ask.awaiting_remaining.some((t) => t === who || agentMatchesAwaiting(t, agent));
  }
  if (ask.awaiting_capability && room && agent) {
    const targets = normalizeAwaitingList(ask.awaiting) || [];
    if (targets.some((t) => t === who || agentMatchesAwaiting(t, agent))) return true;
    const member = room.creator === agent.id
      || (Array.isArray(room.member_ids) && room.member_ids.includes(agent.id));
    return member && agentHasCapability(agent, ask.awaiting_capability);
  }
  const targets = normalizeAwaitingList(ask.awaiting) || [];
  return targets.some((t) => t === who || agentMatchesAwaiting(t, agent));
}

/**
 * R22 (ADR-0037): read-time deadline fields from ask.by (ms epoch). No scheduler.
 * overdue / due_in_ms are null-ish when by is absent; overdue is boolean when by is set.
 */
function annotateDeadline(ask, nowMs = Date.now()) {
  if (!ask || typeof ask !== 'object') return ask;
  const byRaw = ask.by;
  if (byRaw == null || byRaw === '') {
    return { ...ask, overdue: false, due_in_ms: null };
  }
  const by = Number(byRaw);
  if (!Number.isFinite(by) || by <= 0) {
    return { ...ask, overdue: false, due_in_ms: null };
  }
  const due_in_ms = Math.floor(by) - Number(nowMs);
  return { ...ask, by: Math.floor(by), overdue: due_in_ms < 0, due_in_ms };
}

function annotateDeadlines(asks, nowMs = Date.now()) {
  if (!Array.isArray(asks)) return [];
  return asks.map((a) => annotateDeadline(a, nowMs));
}

/**
 * Validate ask body fields. Returns { ok, error, awaiting, awaiting_capability } or { ok:false, error, status }.
 */
function normalizeAskTargets(awaitingWho, awaitingCapability) {
  let awaiting = null;
  if (awaitingWho !== undefined && awaitingWho !== null) {
    if (typeof awaitingWho === 'string') {
      if (!awaitingWho) return { ok: false, status: 400, error: 'awaiting must be a non-empty string or string[]' };
      awaiting = awaitingWho;
    } else if (Array.isArray(awaitingWho)) {
      const list = normalizeAwaitingList(awaitingWho);
      if (!list || list.length === 0) {
        return { ok: false, status: 400, error: 'awaiting array must contain at least one agent id or did' };
      }
      if (list.length !== awaitingWho.length) {
        return { ok: false, status: 400, error: 'awaiting array entries must be non-empty strings' };
      }
      awaiting = list;
    } else {
      return { ok: false, status: 400, error: 'awaiting must be a string or string[]' };
    }
  }

  let cap = null;
  if (awaitingCapability !== undefined && awaitingCapability !== null) {
    if (typeof awaitingCapability !== 'string' || !awaitingCapability || awaitingCapability.length > 128) {
      return { ok: false, status: 400, error: 'awaiting_capability must be a non-empty string ≤128 chars' };
    }
    cap = awaitingCapability;
  }

  if (awaiting == null && !cap) {
    return { ok: false, status: 400, error: 'ask requires awaiting (string|string[]) and/or awaiting_capability' };
  }
  return { ok: true, awaiting, awaiting_capability: cap };
}

module.exports = {
  normalizeAwaitingList,
  agentMatchesAwaiting,
  agentHasCapability,
  materializeRoomAwaiting,
  askConcernsAgent,
  annotateDeadline,
  annotateDeadlines,
  normalizeAskTargets,
  eligibleForCapabilityAsk,
};
