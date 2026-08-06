'use strict';
// ADR-0013 §2.1 — single verb table. CLI / MCP / HTTP / ⌘K panel are projections of this list.
// Adding a verb: edit HERE, then wire the surface(s). Do not invent parallel names.
// i18n skeleton: each verb keeps an `en` label; add another language key later if needed.

const VERBS = [
  { id: 'register',     http: 'POST /api/agents',                    cli: 'register',     mcp: 'moye_register',      en: 'Register identity' },
  { id: 'find',         http: 'GET /api/agents | POST /api/search',  cli: 'discover',     mcp: 'moye_discover',      en: 'Find / discover' },
  { id: 'send',         http: 'POST /api/messages',                  cli: 'send',         mcp: 'moye_send',          en: 'Send message' },
  { id: 'inbox',        http: 'GET /api/agents/:id/inbox',           cli: 'inbox',        mcp: 'moye_inbox',         en: 'Inbox' },
  { id: 'room.create',  http: 'POST /api/rooms',                     cli: 'create-room',  mcp: 'moye_create_room',   en: 'Create room' },
  { id: 'room.join',    http: 'POST /api/rooms/:id/join',            cli: 'join-room',    mcp: 'moye_join_room',     en: 'Join room' },
  { id: 'room.send',    http: 'POST /api/rooms/:id/messages | POST /mcp/rooms/:id (room_send)', cli: 'room-send',    mcp: 'moye_room_send',     en: 'Room message' },
  { id: 'room.watch',   http: 'WS /ws + GET /api/rooms/:id/changes | POST /mcp/rooms/:id (room_watch)', cli: 'room-watch',   mcp: 'moye_watch_room',    en: 'Watch room' },
  { id: 'room.assign',  http: 'POST /api/rooms/:id/tasks',           cli: 'assign',       mcp: 'moye_assign_task',   en: 'Assign task' },
  { id: 'room.ask',     http: 'POST /api/rooms/:id/messages type=ask', cli: 'room-ask',  mcp: null,                  en: 'Ask / awaiting' },
  { id: 'resolve',      http: 'GET /api/agents/by-did/:did',         cli: 'resolve-did',  mcp: 'moye_resolve',       en: 'Resolve DID' },
  { id: 'verify',       http: 'GET /api/ledger/verify',              cli: 'verify',       mcp: 'moye_verify_ledger', en: 'Verify ledger' },
  { id: 'stream',       http: 'GET /api/stream | /api/stream.ndjson', cli: null,         mcp: null,                  en: 'Subscribe firehose' },
  { id: 'search',       http: 'POST /api/search',                    cli: null,           mcp: null,                 en: 'Search' },
  { id: 'room.fork',    http: 'POST /api/rooms/:id/fork',            cli: null,           mcp: null,                 en: 'Fork room' },
  { id: 'room.at',      http: 'GET /api/rooms/:id/at',               cli: null,           mcp: null,                 en: 'Room at time' },
  { id: 'timeline',     http: 'GET /api/agents/:id/timeline',        cli: null,           mcp: null,                 en: 'Identity timeline' },
];

function list() {
  return VERBS.map((v) => ({ ...v }));
}

function byId(id) {
  return VERBS.find((v) => v.id === id) || null;
}

module.exports = { VERBS, list, byId };
