'use strict';
/**
 * R21 (ADR-0037): cross-room catchup for a waking agent — one response with room deltas,
 * open asks (with R22 deadline fields), overdue subset, and an explicit next_cursor.
 */
const roomAwaiting = require('./room_awaiting');
const roomRead = require('./room_read');

/**
 * @param {object} opts
 * @param {object} opts.agent - directory agent record
 * @param {number} opts.since - ms cursor (exclusive lower bound on message ts)
 * @param {function} opts.listRooms
 * @param {function} opts.isRoomMember
 * @param {function} opts.getShared
 * @param {function} opts.roomChatKey
 * @param {function} [opts.getSharedMaterialMeta]
 * @param {function} opts.materializeRoomAwaiting
 * @param {number} [opts.now]
 * @param {number} [opts.perRoomLimit]
 */
function buildCatchup(opts) {
  const {
    agent,
    since: sinceIn,
    listRooms,
    isRoomMember,
    getShared,
    roomChatKey,
    getSharedMaterialMeta,
    materializeRoomAwaiting,
    now = Date.now(),
    perRoomLimit = 200,
  } = opts;
  const since = Number(sinceIn) || 0;
  const rooms_delta = [];
  let messageCount = 0;
  // Rooms that fit entirely within perRoomLimit don't constrain next_cursor at all -- only a
  // TRUNCATED room (more backlog than the cap) does, and only up to what it actually delivered.
  // Letting every room with any activity constrain the cursor (an earlier version of this) was
  // too conservative: two rooms with different-timestamped messages would pin the cursor to
  // whichever fired first and re-deliver the other on the very next call. Mixing "no room
  // truncated" (advance to the true max, like a plain changes-since) with "some room truncated"
  // (advance only as far as the slowest truncated room) keeps both properties: never skip a
  // message that was truncated out, never manufacture a duplicate when nothing was truncated.
  let maxDelivered = since;
  let minTruncatedAdvance = null;

  for (const room of listRooms() || []) {
    if (!isRoomMember(room, agent.id)) continue;
    const all = getShared(roomChatKey(room.id)) || [];
    const meta = typeof getSharedMaterialMeta === 'function' ? getSharedMaterialMeta(all) : null;
    const msgs = roomRead.messagesSince(all, since, {
      knownSorted: meta && meta.tsSorted === true ? true : null,
    });
    if (!msgs.length) continue;
    // Oldest-unread-first, capped at perRoomLimit -- a busy room drains over several calls
    // instead of the client silently losing whatever didn't fit in one response.
    const sliced = msgs.slice(0, Math.max(1, perRoomLimit));
    const lastDelivered = sliced[sliced.length - 1].ts || since;
    if (lastDelivered > maxDelivered) maxDelivered = lastDelivered;
    if (sliced.length < msgs.length) {
      // Truncated: this room still has more waiting past `lastDelivered`.
      minTruncatedAdvance = minTruncatedAdvance == null
        ? lastDelivered : Math.min(minTruncatedAdvance, lastDelivered);
    }
    messageCount += sliced.length;
    rooms_delta.push({
      room_id: room.id,
      room_name: room.name || null,
      new_messages: sliced.length,
      messages: sliced,
    });
  }

  let nextCursor = minTruncatedAdvance != null ? minTruncatedAdvance : maxDelivered;

  const awaiting = [];
  for (const room of listRooms() || []) {
    if (room.visibility === 'private' && !isRoomMember(room, agent.id)) continue;
    // Public rooms: only include if member (catchup is "rooms I am in")
    if (!isRoomMember(room, agent.id)) continue;
    for (const m of materializeRoomAwaiting(room.id)) {
      if (
        roomAwaiting.askConcernsAgent(m, agent.id, agent, room)
        || roomAwaiting.askConcernsAgent(m, agent.did, agent, room)
      ) {
        const ask = roomAwaiting.annotateDeadline(m, now);
        awaiting.push({
          room_id: room.id,
          room_name: room.name || null,
          ask,
        });
      }
    }
  }

  const overdue = awaiting.filter((item) => item.ask && item.ask.overdue === true);

  // Explicit next cursor — never omit. If nothing new, echo since so the client does not guess.
  if (nextCursor < since) nextCursor = since;

  return {
    agent_id: agent.id,
    did: agent.did || null,
    since,
    as_of: now,
    next_cursor: nextCursor,
    rooms_delta,
    new_message_count: messageCount,
    awaiting,
    overdue,
    overdue_count: overdue.length,
    note: 'Pass next_cursor as since= on the next catchup. overdue/due_in_ms are read-time only (R22).',
  };
}

module.exports = { buildCatchup };
