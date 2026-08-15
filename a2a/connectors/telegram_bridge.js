'use strict';
/* DEPRECATED (ADR-0045): shared node-level Telegram bot bridge.
   Primary UX: paste your BotFather token in the room page (POST /api/rooms/:id/telegram-bot);
   the node hosts the relay. Optional CLI: connectors/telegram_room_bridge.js +
   room-telegram-bind/run. See docs/adr/0045-telegram-own-bot-per-room.md.
*/
console.error('[deprecated] telegram_bridge.js is superseded by ADR-0045 (paste token in /rooms)');
console.error('  Web:  room → Connect via Telegram → paste BotFather token');
console.error('  CLI:  node mcp/cli.js room-telegram-bind --room <id> --token <BotFatherToken>');
console.error('        node mcp/cli.js room-telegram-run --room <id>');
process.exit(1);
