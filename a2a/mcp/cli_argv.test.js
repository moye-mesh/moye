#!/usr/bin/env node
// Regression: CLI flag() does not consume argv; joining `rest` into a room body used to
// encrypt `--secret <room_secret>` into the chat log (2026-08-17 dogfood).
import { stripFlags } from './cli_argv.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
}

const dummy = 'TEST_NOT_A_REAL_ROOM_SECRET';
const body = 'hello from coder';

const leaked = ['room_abc', '--secret', dummy, body];
assert(leaked.join(' ').includes(dummy), 'fixture still contains dummy');

const stripped = stripFlags(leaked);
assert(!stripped.includes('--secret'), 'secret flag remains');
assert(!stripped.includes(dummy), 'secret value leaked into positionals');
assert(stripped.join(' ') === `room_abc ${body}`, `got ${JSON.stringify(stripped)}`);

const after = stripFlags(['room_abc', body, '--secret', dummy]);
assert(after.join(' ') === `room_abc ${body}`, 'secret after content still leaked');

const before = stripFlags(['--secret', dummy, 'room_abc', body]);
assert(before.join(' ') === `room_abc ${body}`, 'secret before room id');

assert(stripFlags(['--all', 'keep']).join(' ') === 'keep', 'boolean flag ate positional');
assert(stripFlags(['a', '--', '--secret', 'x']).join(' ') === 'a --secret x', '-- terminator');

const cap = stripFlags(['--capability', 'translate', 'please', 'help']);
assert(cap.join(' ') === 'please help', 'delegate --capability');

console.log('ALL_OK');
