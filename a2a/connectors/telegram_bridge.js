'use strict';
/* DEPRECATED (ADR-0045): shared node-level Telegram bot bridge.
   Use connectors/telegram_room_bridge.js + room-telegram-bind/run instead
   (your own BotFather token ↔ one room, existing DID). See docs/adr/0045-telegram-own-bot-per-room.md.
*/
console.error('[deprecated] telegram_bridge.js is superseded by ADR-0045 telegram_room_bridge.js');
console.error('  Bind: node mcp/cli.js room-telegram-bind --room <id> --token <BotFatherToken>');
console.error('  Run:  node mcp/cli.js room-telegram-run --room <id>');
process.exit(1);
