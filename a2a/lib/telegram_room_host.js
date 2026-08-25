'use strict';
/**
 * ADR-0045 hosted relay: after a member pastes their BotFather token in the room UI,
 * the node runs getUpdates in-process and posts as their session key.
 * One bot token ↔ one room (enforced by token_fingerprint UNIQUE).
 *
 * Room → Telegram delivery must NOT rely on /ws alone: fanoutRoomMessage only runs on the
 * node that accepted the POST. Federated CRDT merges do not re-fanout, so a reply posted via
 * origin/another peer never reaches this host's WebSocket. Poll changes?since= (catchup) as
 * the reliable path; keep watchRoom as a same-node low-latency hint.
 */
const { Agent } = require('../sdk/node/moye-agent-sdk');

// Overridable so this relay can be exercised end to end against a stand-in Telegram API. Without
// it the whole path is untestable without a real BotFather token, which is why it had never been
// run. Default is the real endpoint, so production behaviour is unchanged.
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const POLL_MS = Math.max(1000, parseInt(process.env.TELEGRAM_ROOM_POLL_MS || '2000', 10));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tg(token, method, body) {
  const r = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
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
  // Survive bind rev churn / respawn within this process (DM chat_id ≈ tg user id).
  const chatMemory = new Map(); // bind.id -> Set<chatId>

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
        const handle = spawnOne(b, baseUrl, chatMemory, () => {
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

function textForTelegram(m) {
  if (!m) return '';
  if (m.decrypted != null && m.decrypted !== '') return String(m.decrypted);
  // Never push raw ciphertext into Telegram — looks like "nothing useful arrived".
  if (m.encrypted) return '';
  return m.content != null ? String(m.content) : '';
}

function spawnOne(bind, baseUrl, chatMemory, onEnd) {
  let stopped = false;
  let offset = 0;
  const allowFrom = Array.isArray(bind.allow_from) ? bind.allow_from.map(String) : [];
  let allow = allowFrom.slice();
  const activeChats = chatMemory.get(bind.id) || new Set();
  for (const id of allow) activeChats.add(String(id));
  chatMemory.set(bind.id, activeChats);

  const seen = new Set();
  let cursor = Date.now(); // only forward new room traffic after this host start

  const agent = Agent.fromSession({
    masterDid: bind.master_did,
    agentId: bind.agent_id,
    privateKey: bind.session_private_key,
    baseUrl,
    name: 'tg-host',
  });
  if (bind.room_secret) agent.rememberRoomSecret(bind.room_id, bind.room_secret);

  async function deliverToChats(m) {
    if (stopped || !m || !m.id) return;
    if (seen.has(m.id)) return;
    // User already sees their own TG→room text in the bot chat.
    if (m.from_agent && m.from_agent === bind.agent_id) {
      seen.add(m.id);
      if ((m.ts || 0) > cursor) cursor = m.ts;
      return;
    }
    const text = textForTelegram(m);
    if (!text) {
      seen.add(m.id);
      if ((m.ts || 0) > cursor) cursor = m.ts;
      return;
    }
    if (!activeChats.size) return; // keep unseen so a later first DM can still get backlog? no — drop
    seen.add(m.id);
    if ((m.ts || 0) > cursor) cursor = m.ts;
    if (seen.size > 5000) {
      const drop = [...seen].slice(0, seen.size - 4000);
      for (const id of drop) seen.delete(id);
    }
    const body = String(text).slice(0, 4000);
    for (const chatId of activeChats) {
      try {
        await tg(bind.bot_token, 'sendMessage', { chat_id: chatId, text: body });
      } catch (e) {
        console.error(`[telegram-host] deliver ${bind.id} -> ${chatId}:`, e.message);
      }
    }
  }

  // Best-effort same-node push; federation-safe path is the poll loop below.
  const sub = agent.watchRoom(bind.room_id, {
    since: cursor,
    onMessage: (m) => { deliverToChats(m).catch(() => {}); },
    onError: (e) => console.error(`[telegram-host] watchRoom ${bind.id}:`, e.message || e),
  });

  (async function pollRoom() {
    while (!stopped) {
      try {
        if (activeChats.size) {
          const r = await agent.roomChanges(bind.room_id, cursor);
          const msgs = (r.messages || []).slice().sort(
            (a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)),
          );
          for (const m of msgs) await deliverToChats(m);
        }
      } catch (e) {
        if (!stopped) console.error(`[telegram-host] roomChanges ${bind.id}:`, e.message || e);
      }
      await sleep(POLL_MS);
    }
  })();

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
                text: `Connected to MOYE room ${bind.room_id}. Messages here go to the room as your linked identity. Room replies are polled onto this chat (catchup), not WS-only.`,
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

module.exports = { startTelegramRoomHost, textForTelegram };
