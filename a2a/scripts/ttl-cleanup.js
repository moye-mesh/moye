#!/usr/bin/env node
'use strict';
// MOYE A2A message TTL cleanup: deletes messages and completed room tasks older than RETENTION_DAYS
const db = require('../lib/db');
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);
const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

const m = db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
const t = db.prepare("DELETE FROM room_tasks WHERE status='done' AND created_at < ?").run(cutoff);
console.log(`[ttl] removed ${m.changes} messages, ${t.changes} done tasks (retention=${RETENTION_DAYS}d)`);
