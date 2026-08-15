'use strict';
/**
 * ADR-0045: per-member Telegram room bridge.
 * One BotFather token ↔ one room. Uses an existing MOYE identity (no DID registration).
 *
 *   MOYE_IDENTITY_FILE=... node connectors/telegram_room_bridge.js --room room_xxx
 *   # or: node mcp/cli.js room-telegram-run --room room_xxx
 *
 * Optional: MOYE_ROOM_SECRET / --secret for private rooms.
 */
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');
const { getBindForRoom } = require('./telegram_room_bind');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function loadIdentity() {
  const file = process.env.MOYE_IDENTITY_FILE
    || path.join(require('os').homedir(), '.moye-mcp', 'identity.json');
  const identity = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  if (!identity.privateKey || !identity.agentId) {
    throw new Error(`identity file ${file} missing privateKey/agentId — register first`);
  }
  return { file, identity };
}

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description || r.status}`);
  return data.result;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const roomId = arg('--room', process.env.MOYE_TELEGRAM_ROOM);
  if (!roomId) {
    console.error('usage: node telegram_room_bridge.js --room <room_id> [--secret <s>] [--allow-from <tgUserId>]');
    process.exit(1);
  }
  const { bind } = getBindForRoom(roomId);
  if (!bind || !bind.botToken) {
    console.error(`[fatal] no bot bound for ${roomId} — run: room-telegram-bind --room ${roomId} --token <BotFatherToken>`);
    process.exit(1);
  }

  const { file: idFile, identity } = loadIdentity();
  const baseUrl = process.env.MOYE_BASE_URL || 'https://moye.ai/a2a';
  const agent = new Agent({ name: 'telegram-room', baseUrl });
  agent.fromPrivateKey(identity.privateKey);
  agent.agentId = identity.agentId;
  agent.token = identity.token || null;
  if (identity.encPrivateKey) {
    agent.setEncryptionKey(identity.encPrivateKey);
  }

  const secret = arg('--secret', process.env.MOYE_ROOM_SECRET);
  if (secret) agent.rememberRoomSecret(roomId, secret);

  let allowFrom = [...(bind.allowFrom || [])];
  const cliAllow = arg('--allow-from', null);
  if (cliAllow) allowFrom = cliAllow.split(',').map((s) => s.trim()).filter(Boolean);

  const me = await tg(bind.botToken, 'getMe', {});
  console.log(`[telegram-room] bot=@${me.username} room=${roomId} did_agent=${agent.agentId} identity=${idFile}`);
  if (!allowFrom.length) {
    console.log('[telegram-room] allowFrom empty — first human DM will be recorded as the sole allowed Telegram user id');
  }

  const activeChats = new Set();
  agent.watchRoom(roomId, {
    onMessage: async (m) => {
      const text = m.decrypted || m.content;
      if (!text) return;
      for (const chatId of activeChats) {
        try {
          await tg(bind.botToken, 'sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) });
        } catch (e) {
          console.error(`[telegram-room] deliver to ${chatId} failed: ${e.message}`);
        }
      }
    },
    onError: (e) => console.error(`[telegram-room] watchRoom: ${e.message || e}`),
  });

  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg(bind.botToken, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    } catch (e) {
      console.error(`[telegram-room] getUpdates: ${e.message}`);
      await sleep(3000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || !msg.chat || msg.text == null) continue;
      const chatId = String(msg.chat.id);
      const fromId = msg.from && msg.from.id != null ? String(msg.from.id) : chatId;

      if (!allowFrom.length) {
        allowFrom.push(fromId);
        console.log(`[telegram-room] allowFrom locked to Telegram user ${fromId}`);
      }
      if (!allowFrom.includes(fromId) && !allowFrom.includes(chatId)) {
        try {
          await tg(bind.botToken, 'sendMessage', {
            chat_id: chatId,
            text: 'This bot is a private MOYE room channel for its owner. You are not on the allowlist — no DID is created for you.',
          });
        } catch { /* ignore */ }
        continue;
      }

      activeChats.add(chatId);
      const text = String(msg.text);
      if (/^\/start\b/i.test(text)) {
        try {
          await tg(bind.botToken, 'sendMessage', {
            chat_id: chatId,
            text: `Linked to MOYE room ${roomId} as agent ${agent.agentId}. Messages you send here are posted to that room; room messages appear here.`,
          });
        } catch { /* ignore */ }
        continue;
      }
      try {
        await agent.sendRoomMessage(roomId, text);
      } catch (e) {
        console.error(`[telegram-room] sendRoomMessage: ${e.message}`);
        try {
          await tg(bind.botToken, 'sendMessage', { chat_id: chatId, text: `Could not post to room: ${e.message}` });
        } catch { /* ignore */ }
      }
    }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
}

module.exports = { main };
