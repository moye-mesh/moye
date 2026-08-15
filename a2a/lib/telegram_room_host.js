'use strict';
/**
 * ADR-0045 hosted relay: after a member pastes their BotFather token in the room UI,
 * the node runs getUpdates in-process and posts as their session key.
 * One bot token ↔ one room (enforced by token_fingerprint UNIQUE).
 */
const { Agent } = require('../sdk/node/moye-agent-sdk');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `telegram ${method} ${r.status}`);
  return data.result;
}

/**
 * @param {object} opts
 * @param {() => object[]} opts.listBinds  decrypted bind rows
 * @param {string} opts.baseUrl
 */
function bindRev(b) {
  return [
    b.id, b.session_did, b.session_expires_at || 0,
    b.bot_token || '', b.room_secret || '', (b.allow_from || []).join(','),
  ].join('|');
}

function startTelegramRoomHost({ listBinds, baseUrl }) {
  const running = new Map(); // id -> { stop, rev }

  function sync() {
    let binds = [];
    try { binds = listBinds() || []; } catch (e) {
      console.error('[telegram-host] listBinds failed:', e.message);
      return;
    }
    const want = new Map(binds.map((b) => [b.id, b]));
    for (const [id, h] of running) {
      const b = want.get(id);
      if (!b || h.rev !== bindRev(b)) {
        try { h.stop(); } catch { /* ignore */ }
        running.delete(id);
        console.log(`[telegram-host] stopped ${id}`);
      }
    }
    for (const b of binds) {
      if (running.has(b.id)) continue;
      if (b.session_expires_at && b.session_expires_at < Date.now()) {
        console.warn(`[telegram-host] skip ${b.id}: session expired`);
        continue;
      }
      try {
        const rev = bindRev(b);
        const handle = spawnOne(b, baseUrl, () => {
          const cur = running.get(b.id);
          if (cur && cur.rev === rev) running.delete(b.id);
        });
        running.set(b.id, { ...handle, rev });
        console.log(`[telegram-host] started room=${b.room_id} agent=${b.agent_id} bot=@${b.bot_username || '?'}`);
      } catch (e) {
        console.error(`[telegram-host] failed to start ${b.id}:`, e.message);
      }
    }
  }

  sync();
  const timer = setInterval(sync, 15000);
  return {
    sync,
    stop() { clearInterval(timer); for (const h of running.values()) try { h.stop(); } catch {} running.clear(); },
    info() { return { running: running.size }; },
  };
}

function spawnOne(bind, baseUrl, onEnd) {
  let stopped = false;
  let offset = 0;
  const allowFrom = Array.isArray(bind.allow_from) ? bind.allow_from.map(String) : [];
  let allow = allowFrom.slice();
  const activeChats = new Set();

  const agent = Agent.fromSession({
    masterDid: bind.master_did,
    agentId: bind.agent_id,
    privateKey: bind.session_private_key,
    baseUrl,
    name: 'tg-host',
  });
  if (bind.room_secret) agent.rememberRoomSecret(bind.room_id, bind.room_secret);

  const sub = agent.watchRoom(bind.room_id, {
    onMessage: async (m) => {
      if (stopped) return;
      const text = m.decrypted || m.content;
      if (!text) return;
      for (const chatId of activeChats) {
        try {
          await tg(bind.bot_token, 'sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) });
        } catch (e) {
          console.error(`[telegram-host] deliver ${bind.id} -> ${chatId}:`, e.message);
        }
      }
    },
    onError: (e) => console.error(`[telegram-host] watchRoom ${bind.id}:`, e.message || e),
  });

  (async () => {
    while (!stopped) {
      try {
        const updates = await tg(bind.bot_token, 'getUpdates', {
          offset, timeout: 25, allowed_updates: ['message'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || !msg.chat || msg.text == null) continue;
          const chatId = String(msg.chat.id);
          const fromId = msg.from && msg.from.id != null ? String(msg.from.id) : chatId;
          if (!allow.length) {
            allow.push(fromId);
            console.log(`[telegram-host] ${bind.id} allowFrom locked to ${fromId}`);
          }
          if (!allow.includes(fromId) && !allow.includes(chatId)) {
            try {
              await tg(bind.bot_token, 'sendMessage', {
                chat_id: chatId,
                text: 'This bot is a private MOYE room channel for its owner. You are not on the allowlist.',
              });
            } catch { /* ignore */ }
            continue;
          }
          activeChats.add(chatId);
          const text = String(msg.text);
          if (/^\/start\b/i.test(text)) {
            try {
              await tg(bind.bot_token, 'sendMessage', {
                chat_id: chatId,
                text: `Connected to MOYE room ${bind.room_id}. Messages here go to the room as your linked identity.`,
              });
            } catch { /* ignore */ }
            continue;
          }
          try {
            await agent.sendRoomMessage(bind.room_id, text);
          } catch (e) {
            console.error(`[telegram-host] sendRoomMessage ${bind.id}:`, e.message);
            try {
              await tg(bind.bot_token, 'sendMessage', { chat_id: chatId, text: `Could not post to room: ${e.message}` });
            } catch { /* ignore */ }
          }
        }
      } catch (e) {
        if (!stopped) {
          console.error(`[telegram-host] getUpdates ${bind.id}:`, e.message);
          await sleep(3000);
        }
      }
    }
    try { sub.stop(); } catch { /* ignore */ }
    onEnd && onEnd();
  })();

  return {
    stop() { stopped = true; try { sub.stop(); } catch { /* ignore */ } },
  };
}

module.exports = { startTelegramRoomHost };
