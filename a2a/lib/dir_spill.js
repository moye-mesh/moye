'use strict';
// ADR-0012 S2 / P2-1: durable directory spill for ipfs_store.
// Hot objects stay in the in-memory LRU; every write also lands in SQLite so a cold
// get (or process restart) does not require the full directory to fit in RAM.
// Callers of ipfs_store keep the same get/put/list/_raw surface.
const db = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS dir_agents (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dir_rooms (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dir_shared (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dir_meta (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
`);

const putAgentStmt = db.prepare('INSERT INTO dir_agents(id, body, updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at');
const getAgentStmt = db.prepare('SELECT body FROM dir_agents WHERE id=?');
const delAgentStmt = db.prepare('DELETE FROM dir_agents WHERE id=?');
const allAgentIdsStmt = db.prepare('SELECT id FROM dir_agents');
const allAgentsStmt = db.prepare('SELECT id, body FROM dir_agents');

const putRoomStmt = db.prepare('INSERT INTO dir_rooms(id, body, updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at');
const getRoomStmt = db.prepare('SELECT body FROM dir_rooms WHERE id=?');
const delRoomStmt = db.prepare('DELETE FROM dir_rooms WHERE id=?');
const allRoomIdsStmt = db.prepare('SELECT id FROM dir_rooms');
const allRoomsStmt = db.prepare('SELECT id, body FROM dir_rooms');

const putSharedStmt = db.prepare('INSERT INTO dir_shared(key, body, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at');
const getSharedStmt = db.prepare('SELECT body FROM dir_shared WHERE key=?');
const delSharedStmt = db.prepare('DELETE FROM dir_shared WHERE key=?');
const allSharedStmt = db.prepare('SELECT key, body FROM dir_shared');

const putMetaStmt = db.prepare('INSERT INTO dir_meta(key, body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body');
const getMetaStmt = db.prepare('SELECT body FROM dir_meta WHERE key=?');

function parse(row) {
  if (!row || row.body == null) return null;
  try { return JSON.parse(row.body); } catch { return null; }
}

function putAgent(id, obj) {
  putAgentStmt.run(id, JSON.stringify(obj), Date.now());
}
function getAgent(id) { return parse(getAgentStmt.get(id)); }
function delAgent(id) { delAgentStmt.run(id); }
function allAgentIds() { return allAgentIdsStmt.all().map((r) => r.id); }
function allAgents() {
  const out = {};
  for (const r of allAgentsStmt.all()) {
    const v = parse(r);
    if (v) out[r.id] = v;
  }
  return out;
}

function putRoom(id, obj) {
  putRoomStmt.run(id, JSON.stringify(obj), Date.now());
}
function getRoom(id) { return parse(getRoomStmt.get(id)); }
function delRoom(id) { delRoomStmt.run(id); }
function allRoomIds() { return allRoomIdsStmt.all().map((r) => r.id); }
function allRooms() {
  const out = {};
  for (const r of allRoomsStmt.all()) {
    const v = parse(r);
    if (v) out[r.id] = v;
  }
  return out;
}

function putShared(key, obj) {
  putSharedStmt.run(key, JSON.stringify(obj), Date.now());
}
function getShared(key) { return parse(getSharedStmt.get(key)); }
function delShared(key) { delSharedStmt.run(key); }
function allShared() {
  const out = {};
  for (const r of allSharedStmt.all()) {
    const v = parse(r);
    if (v) out[r.key] = v;
  }
  return out;
}

function putMeta(key, obj) { putMetaStmt.run(key, JSON.stringify(obj)); }
function getMeta(key) { return parse(getMetaStmt.get(key)); }

function agentCount() { return db.prepare('SELECT COUNT(*) AS n FROM dir_agents').get().n; }
function roomCount() { return db.prepare('SELECT COUNT(*) AS n FROM dir_rooms').get().n; }
function sharedCount() { return db.prepare('SELECT COUNT(*) AS n FROM dir_shared').get().n; }

module.exports = {
  putAgent, getAgent, delAgent, allAgentIds, allAgents,
  putRoom, getRoom, delRoom, allRoomIds, allRooms,
  putShared, getShared, delShared, allShared,
  putMeta, getMeta,
  agentCount, roomCount, sharedCount,
};
