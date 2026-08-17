'use strict';
// moye-net: SQLite persistence layer, replacing MySQL. Each NODE_ID gets its own .db file,
// naturally mirroring the old per-database isolation of seed1/moye_ai and node2/moye_node2.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const NODE_ID = process.env.NODE_ID || 'seed1';
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, `${NODE_ID}.db`);

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  home_node TEXT NOT NULL DEFAULT 'seed1',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT,
  to_agent TEXT,
  content TEXT,
  status TEXT DEFAULT 'pending',
  encrypted INTEGER NOT NULL DEFAULT 0,
  nonce TEXT,
  sender_sig TEXT,
  attachments TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS room_tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  task TEXT,
  assignee TEXT,
  result TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roomtasks_created ON room_tasks(created_at);

CREATE TABLE IF NOT EXISTS anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchors_chain ON anchors(chain);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  prev TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL,
  node TEXT NOT NULL DEFAULT 'seed1'
);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger(type);

CREATE TABLE IF NOT EXISTS federation_nodes (
  id TEXT PRIMARY KEY,
  name TEXT,
  endpoint TEXT,
  pubkey TEXT,
  created_at INTEGER NOT NULL,
  num_shards INTEGER,
  served_shards TEXT,
  features TEXT,
  protocol_version TEXT,
  role TEXT
);

-- Governance: federation node votes to revoke an agent, idempotent per (target, voter_node).
-- Also reused for seed-list endorsement votes (ADR-0006 D2/X2): target = 'seeds:<hash>' in that case,
-- same table/tally logic, no schema change needed -- votes are namespaced by target already.
CREATE TABLE IF NOT EXISTS governance_votes (
  target TEXT NOT NULL,
  voter_node TEXT NOT NULL,
  sig TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (target, voter_node)
);

-- ADR-0006 D2/X2: a proposed bootstrap seeds list, identified by a hash of its contents. Votes on it
-- (by federation node) live in governance_votes under target='seeds:<hash>', reusing the same
-- multi-sig tally the agent-revoke flow already has instead of inventing a second mechanism.
CREATE TABLE IF NOT EXISTS seed_proposals (
  hash TEXT PRIMARY KEY,
  seeds TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ADR-0010: A2A (Google Agent2Agent protocol) JSON-RPC invocation bridge. Tracks a task from
-- external A2A client submission through to the MOYE agent's own reported result -- MOYE's own
-- delivery stays async/pull (inbox), so this table is the state a JSON-RPC tasks/get poll reads.
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  message_id TEXT,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2atasks_agent ON a2a_tasks(agent_id);

CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  content TEXT,
  lang TEXT DEFAULT 'en',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visit_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total INTEGER NOT NULL DEFAULT 0,
  today_date TEXT NOT NULL,
  today_count INTEGER NOT NULL DEFAULT 0
);

-- Telegram bridge (ADR-0044): a room member mints a longer-lived invite; anyone who opens it in
-- Telegram gets their own real MOYE identity (or reuses one already signed in on their device) and
-- their own session key -- never a shared bot identity. See docs/adr/0044.
CREATE TABLE IF NOT EXISTS telegram_invites (
  invite_code TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- One row per (telegram_chat, room) link attempt. 'pending_web' is created the instant the bot
-- sees /start <invite_code> from a real Telegram chat (so telegram_chat_id is Telegram-authenticated
-- from the start, never a browser-supplied claim); 'active' once the browser step completes and a
-- verified live session-key VC (findLiveSessionKey) backs the submitted session_private_key.
CREATE TABLE IF NOT EXISTS telegram_pairings (
  pairing_code TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_web',
  agent_id TEXT,
  master_did TEXT,
  session_did TEXT,
  session_private_key TEXT,
  session_expires_at INTEGER,
  delivered_to_relay INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_telegram_pairings_relay ON telegram_pairings(status, delivered_to_relay);

-- ADR-0045 UX: member pastes own BotFather token in the room UI; node hosts the relay in-process.
-- bot_token / session_private_key / optional room_secret are stored encrypted (see server vault helpers).
CREATE TABLE IF NOT EXISTS telegram_room_bots (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  master_did TEXT NOT NULL,
  session_did TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL UNIQUE,
  bot_username TEXT,
  allow_from TEXT,
  vault_blob TEXT NOT NULL,
  session_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(room_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_room_bots_room ON telegram_room_bots(room_id);
`);

// Migration: the old database (created 2026-07-15 during the MySQL -> SQLite cutover) stored a
// plaintext token column, renamed to token_hash once hashed storage was hardened in later that same
// day. CREATE TABLE IF NOT EXISTS won't alter an existing table's schema, so this detects and
// migrates explicitly; freshly-created databases are unaffected (they already start with token_hash).
// The token column itself carries a UNIQUE constraint, and SQLite doesn't support dropping such a
// column directly, so this rebuilds via the standard "create new table -> copy data -> drop old
// table" pattern instead of ALTER TABLE DROP COLUMN.
{
  const cols = db.prepare("PRAGMA table_info(agents)").all().map(c => c.name);
  if (cols.includes('token') && !cols.includes('token_hash')) {
    const crypto = require('crypto');
    const rows = db.prepare('SELECT id, name, token, home_node, created_at FROM agents').all();
    db.exec('ALTER TABLE agents RENAME TO agents_migrating_old');
    db.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      home_node TEXT NOT NULL DEFAULT 'seed1',
      created_at INTEGER NOT NULL
    )`);
    const ins = db.prepare('INSERT INTO agents (id, name, token_hash, home_node, created_at) VALUES (?,?,?,?,?)');
    for (const r of rows) ins.run(r.id, r.name, crypto.createHash('sha256').update(r.token).digest('hex'), r.home_node, r.created_at);
    db.exec('DROP TABLE agents_migrating_old');
  }
}

// F3 (message signing): add the nullable sender_sig column to pre-existing message tables.
// CREATE TABLE IF NOT EXISTS won't alter an existing table, so add the column explicitly if absent.
// Nullable + no default -> safe and idempotent on a live node; old rows simply have NULL.
{
  const cols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!cols.includes('sender_sig')) db.exec('ALTER TABLE messages ADD COLUMN sender_sig TEXT');
  // N1 (ADR-0020): CID attachment metadata JSON; bytes live on IPFS, not in this column.
  if (!cols.includes('attachments')) db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
}

// ADR-0008 (directory sharding): add num_shards/served_shards to pre-existing federation_nodes
// tables, same pattern as above. Nullable -- a peer that hasn't announced its shard config yet
// (older server version, or sharding not in use) just has NULL, treated as "unknown" by callers.
{
  const cols = db.prepare("PRAGMA table_info(federation_nodes)").all().map(c => c.name);
  if (!cols.includes('num_shards')) db.exec('ALTER TABLE federation_nodes ADD COLUMN num_shards INTEGER');
  if (!cols.includes('served_shards')) db.exec('ALTER TABLE federation_nodes ADD COLUMN served_shards TEXT');
}

// features/protocol_version: added to the CREATE TABLE above (so a fresh database gets them for
// free), but that statement is a no-op against a pre-existing table (CREATE TABLE IF NOT EXISTS),
// so any node whose federation_nodes table predates this pair of columns never actually got them --
// upsertFederationNode's INSERT then fails outright with "no column named features" and the whole
// server refuses to start. Same nullable-migration pattern as num_shards/served_shards above.
{
  const cols = db.prepare("PRAGMA table_info(federation_nodes)").all().map(c => c.name);
  if (!cols.includes('features')) db.exec('ALTER TABLE federation_nodes ADD COLUMN features TEXT');
  if (!cols.includes('protocol_version')) db.exec('ALTER TABLE federation_nodes ADD COLUMN protocol_version TEXT');
}

{
  const cols = db.prepare("PRAGMA table_info(federation_nodes)").all().map(c => c.name);
  if (!cols.includes('role')) db.exec("ALTER TABLE federation_nodes ADD COLUMN role TEXT");
  db.exec("UPDATE federation_nodes SET role='write' WHERE role IS NULL OR role=''");
}

db.exec(`CREATE TABLE IF NOT EXISTS pending_deliver (
  id TEXT PRIMARY KEY,
  home_node TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
)`);

module.exports = db;
