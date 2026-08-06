#!/usr/bin/env node
'use strict';
// Writes a bridged room message into mission/inbox (used by ops-room-listen.sh).
// Mirrors coder-inbox-write.js -- ops's claude CLI isn't authenticated for headless -p yet
// (checked 2026-08-05, still "Not logged in"), so this listens + captures to a file instead of
// trying to spawn a new session. Next interactive ops turn checks the inbox to catch up.
const fs = require('fs');
const path = require('path');

const inbox = path.join(__dirname, '..', 'docs', 'mission', 'inbox');
fs.mkdirSync(inbox, { recursive: true });

let obj;
try {
  obj = JSON.parse(process.env.MOYE_MSG_JSON || '{}');
} catch {
  obj = { text: process.env.MOYE_MSG_TEXT || '', parse_error: true };
}
obj._received_at = Date.now();
obj._source = 'room';

fs.writeFileSync(path.join(inbox, 'ops-last.json'), JSON.stringify(obj, null, 2) + '\n');
fs.appendFileSync(path.join(inbox, 'ops.log'), JSON.stringify(obj) + '\n');
process.stdout.write('INBOX_WRITTEN ' + (obj.id || '') + '\n');
