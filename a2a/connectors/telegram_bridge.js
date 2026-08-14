'use strict';
/* Telegram bridge relay (ADR-0044). Long-polls the Telegram Bot API and, for each linked chat,
   holds an Agent.fromSession() that relays messages both ways:
     Telegram -> MOYE room:  sendRoomMessage() with the linked session key
     MOYE room -> Telegram:  watchRoom() push -> Telegram sendMessage

   This process never sees anyone's master private key -- only the short-lived, narrowly-scoped
   session key each user minted for themselves in telegram-connect.html (ADR-0043). It requires
   TELEGRAM_RELAY_SECRET to match what the MOYE server was started with (same trust tier as
   FED_SECRET -- this is an ops-operated process, not a public client), and TELEGRAM_BOT_TOKEN
   from @BotFather (dev cannot create this; an operator must obtain it).

   Run: TELEGRAM_BOT_TOKEN=... TELEGRAM_RELAY_SECRET=... MOYE_BASE_URL=... CONNECT_BASE_URL=... \
        node connectors/telegram_bridge.js
*/
const { Agent } = require('../sdk/node/moye-agent-sdk');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RELAY_SECRET = process.env.TELEGRAM_RELAY_SECRET;
const MOYE_BASE_URL = process.env.MOYE_BASE_URL || 'https://moye.ai/a2a';
const CONNECT_BASE_URL = process.env.CONNECT_BASE_URL || 'https://moye.ai/telegram-connect.html';
const POLL_INTERVAL_MS = Number(process.env.TELEGRAM_PAIRING_POLL_MS) || 4000;
const EXPIRY_WARNING_MS = 24 * 3600 * 1000; // warn in-chat when a session has under 24h left

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tg(method, body) {
  const r = await fetch(`${TG_API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || r.status}`);
  return data.result;
}

async function moye(path, { method = 'GET', body = null } = {}) {
  const r = await fetch(MOYE_BASE_URL.replace(/\/$/, '') + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Telegram-Relay-Secret': RELAY_SECRET },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) throw new Error(`MOYE ${path} failed (${r.status}): ${data.error || 'unknown'}`);
  return data;
}

// chat_id -> { agent, roomId, stop, sessionExpiresAt, warned }
const links = new Map();

function startLink({ telegram_chat_id, room_id, agent_id, master_did, session_did, session_private_key, session_expires_at }) {
  if (links.has(telegram_chat_id)) links.get(telegram_chat_id).stop();
  const agent = Agent.fromSession({ masterDid: master_did, agentId: agent_id, privateKey: session_private_key, baseUrl: MOYE_BASE_URL });
  const sub = agent.watchRoom(room_id, {
    onMessage: async (m) => {
      const text = m.decrypted || m.content;
      if (!text) return;
      try { await tg('sendMessage', { chat_id: telegram_chat_id, text: String(text).slice(0, 4000) }); }
      catch (e) { console.error(`[telegram-bridge] failed to deliver room message to chat ${telegram_chat_id}: ${e.message}`); }
    },
    onError: (e) => console.error(`[telegram-bridge] watchRoom error for chat ${telegram_chat_id}: ${e.message || e}`),
  });
  links.set(telegram_chat_id, { agent, roomId: room_id, session_did, stop: () => sub.stop(), sessionExpiresAt: session_expires_at, warned: false });
  console.log(`[telegram-bridge] linked chat ${telegram_chat_id} <-> room ${room_id} (agent ${agent_id})`);
}

async function handleIncomingText(chatId, text) {
  const startMatch = /^\/start(?:@\w+)?\s*(\S*)/.exec(text || '');
  if (startMatch) {
    const inviteCode = startMatch[1];
    if (!inviteCode) {
      await tg('sendMessage', { chat_id: chatId, text: 'Open this bot from a MOYE room\'s "Connect via Telegram" link or QR code -- this bot needs an invite code to know which room to bridge.' });
      return;
    }
    try {
      const r = await moye('/api/telegram/relay/start', { method: 'POST', body: { invite_code: inviteCode, telegram_chat_id: String(chatId) } });
      const connectUrl = `${CONNECT_BASE_URL}?pairing=${encodeURIComponent(r.pairing_code)}&room=${encodeURIComponent(r.room_id)}`;
      await tg('sendMessage', {
        chat_id: chatId,
        text: `Tap this link to finish connecting. It opens a normal MOYE page in your browser, generates your own real identity right there (your key never touches this bot), and links this chat when you're done:\n\n${connectUrl}\n\nThis link expires in 15 minutes.`,
      });
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: `Couldn't start pairing: ${e.message}. The invite link may have expired -- ask for a fresh one.` });
    }
    return;
  }

  const link = links.get(String(chatId));
  if (!link) {
    await tg('sendMessage', { chat_id: chatId, text: 'This chat isn\'t linked to a MOYE room yet. Use a "Connect via Telegram" link/QR from a MOYE room to get started.' });
    return;
  }
  if (link.sessionExpiresAt && link.sessionExpiresAt < Date.now()) {
    await tg('sendMessage', { chat_id: chatId, text: 'Your MOYE session for this chat expired. Reopen the room\'s Telegram QR/link to reconnect.' });
    return;
  }
  try {
    await link.agent.sendRoomMessage(link.roomId, text);
  } catch (e) {
    console.error(`[telegram-bridge] failed to post chat ${chatId}'s message into room ${link.roomId}: ${e.message}`);
    await tg('sendMessage', { chat_id: chatId, text: 'That message could not be delivered to the room. Try again shortly.' });
  }
}

async function checkExpiryWarnings() {
  const now = Date.now();
  for (const [chatId, link] of links) {
    if (!link.warned && link.sessionExpiresAt && link.sessionExpiresAt - now < EXPIRY_WARNING_MS && link.sessionExpiresAt > now) {
      link.warned = true;
      try {
        await tg('sendMessage', { chat_id: chatId, text: 'Your MOYE session for this chat expires within a day. Reopen the room\'s Telegram QR/link at any time to renew it before it does.' });
      } catch { /* best effort */ }
    }
  }
}

async function pollNewPairings() {
  try {
    const r = await moye('/api/telegram/relay/poll');
    for (const p of r.pairings) startLink(p);
  } catch (e) {
    console.error(`[telegram-bridge] pairing poll failed: ${e.message}`);
  }
}

async function pollTelegramUpdates() {
  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    } catch (e) {
      console.error(`[telegram-bridge] getUpdates failed: ${e.message}`);
      await sleep(3000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || !msg.chat || msg.text == null) continue;
      try { await handleIncomingText(msg.chat.id, msg.text); }
      catch (e) { console.error(`[telegram-bridge] error handling update ${u.update_id}: ${e.message}`); }
    }
  }
}

async function main() {
  if (!BOT_TOKEN) { console.error('[fatal] TELEGRAM_BOT_TOKEN is required (create a bot via @BotFather)'); process.exit(1); }
  if (!RELAY_SECRET) { console.error('[fatal] TELEGRAM_RELAY_SECRET is required and must match the MOYE server\'s env'); process.exit(1); }
  console.log(`[telegram-bridge] starting, MOYE_BASE_URL=${MOYE_BASE_URL}`);
  await pollNewPairings();
  setInterval(pollNewPairings, POLL_INTERVAL_MS);
  setInterval(checkExpiryWarnings, 3600 * 1000);
  await pollTelegramUpdates(); // never returns
}

module.exports = { handleIncomingText, startLink, pollNewPairings, checkExpiryWarnings, links, tg, moye };

if (require.main === module) {
  main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
}
