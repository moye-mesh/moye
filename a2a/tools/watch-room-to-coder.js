#!/usr/bin/env node
'use strict';
/**
 * watch-room-to-coder — exit-on-wake inbound watcher (dogfood room).
 * Logic lives in lib/room-watch-core.js (shared with ops; see rmsg_db25d30e5997).
 */
require('./lib/room-watch-core').createRoomWatch({
  role: 'coder',
  wakePrefix: 'AGENT_LOOP_WAKE_room_coder',
  matchRegex: process.env.CODER_MATCH_REGEX || 'coder|@coder|To: coder|ag_a8b63e5a8359',
  identityFile: 'coder-bridge-identity.json',
  cursorFile: 'room-watch-cursor.txt',
  baselineFile: 'room-inbound-baseline.sha',
  ptrFile: 'latest-room-to-coder.md',
  lastJsonFile: 'coder-last.json',
  ptrPrefix: 'room-to-coder',
  armHint: 'When done, re-arm: bash a2a/tools/arm-room-to-coder-watch.sh (notify pattern ^AGENT_LOOP_WAKE_room_coder). ptr={ptr}',
});
