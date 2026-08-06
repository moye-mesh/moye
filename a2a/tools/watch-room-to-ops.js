#!/usr/bin/env node
'use strict';
/**
 * watch-room-to-ops — exit-on-wake inbound watcher (dogfood room), ops variant.
 * Logic lives in lib/room-watch-core.js (shared with coder; see rmsg_db25d30e5997).
 */
require('./lib/room-watch-core').createRoomWatch({
  role: 'ops',
  wakePrefix: 'AGENT_LOOP_WAKE_room_ops',
  matchRegex: process.env.OPS_MATCH_REGEX || 'ops|@ops|To: ops|ag_4068975f2404',
  identityFile: 'ops-bridge-identity.json',
  cursorFile: 'room-watch-cursor-ops.txt',
  baselineFile: 'room-inbound-baseline-ops.sha',
  ptrFile: 'latest-room-to-ops.md',
  lastJsonFile: 'ops-last.json',
  ptrPrefix: 'room-to-ops',
  armHint: 'When done, re-arm: bash a2a/tools/arm-room-to-ops-watch.sh (wake prefix AGENT_LOOP_WAKE_room_ops). ptr={ptr}',
});
