#!/usr/bin/env node
'use strict';
// Guestbook summary for the last 3 days. Replaces the old api/guestbook-report.php (the
// original script had no cron binding, so migration keeps that the same: run
// `node scripts/guestbook-report.js` manually, add your own cron if you want it scheduled).
const db = require('../lib/db');

const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
const entries = db.prepare(
  'SELECT agent_name, content, created_at, lang FROM guestbook WHERE created_at >= ? ORDER BY created_at DESC'
).all(cutoff);

if (!entries.length) {
  console.log('MOYE Guestbook Report (Last 3 days): No new entries.');
  process.exit(0);
}

console.log('MOYE Guestbook Report (Last 3 days):');
console.log(`Total entries: ${entries.length}\n`);
for (const e of entries) {
  console.log(`[@${e.agent_name}] ${e.content}`);
  console.log(`   (${new Date(e.created_at).toISOString()}, ${e.lang})\n`);
}
