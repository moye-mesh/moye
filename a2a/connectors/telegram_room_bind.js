'use strict';
/**
 * ADR-0045: local bind store for (bot token <-> one room).
 * Tokens stay on the user machine; never a node-wide TELEGRAM_BOT_TOKEN.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function defaultBindPath() {
  if (process.env.MOYE_TELEGRAM_BINDS_FILE) return process.env.MOYE_TELEGRAM_BINDS_FILE;
  if (process.env.MOYE_IDENTITY_FILE) {
    return path.join(path.dirname(process.env.MOYE_IDENTITY_FILE), 'telegram-room-binds.json');
  }
  return path.join(os.homedir(), '.moye-mcp', 'telegram-room-binds.json');
}

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token).trim()).digest('hex').slice(0, 16);
}

function loadBinds(filePath) {
  const file = filePath || defaultBindPath();
  if (!fs.existsSync(file)) return { file, binds: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, binds: raw.binds || {} };
}

function saveBinds(file, binds) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, binds }, null, 2), { mode: 0o600 });
}

/**
 * @returns {{ ok: true, bind } | { ok: false, error: string }}
 */
function bindRoom({ roomId, botToken, allowFrom = [], botUsername = null }) {
  const token = String(botToken || '').trim();
  const room = String(roomId || '').trim();
  if (!room || !token) return { ok: false, error: 'roomId and botToken required' };
  if (!token.includes(':')) return { ok: false, error: 'botToken does not look like a BotFather token (expected id:secret)' };

  const { file, binds } = loadBinds();
  const fp = tokenFingerprint(token);

  for (const [id, b] of Object.entries(binds)) {
    if (b.roomId === room && id !== fp) {
      return { ok: false, error: `room ${room} already has a different bot bound; unbind first` };
    }
    if (id === fp && b.roomId !== room) {
      return { ok: false, error: `this bot token is already bound to ${b.roomId} (1 bot ↔ 1 room); unbind that room first` };
    }
  }

  const allow = (Array.isArray(allowFrom) ? allowFrom : String(allowFrom || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);

  const bind = {
    roomId: room,
    botToken: token,
    botUsername: botUsername || null,
    allowFrom: allow,
    tokenFingerprint: fp,
    boundAt: Date.now(),
  };
  binds[fp] = bind;
  saveBinds(file, binds);
  return { ok: true, bind: { ...bind, botToken: '[stored]', file } };
}

function unbindRoom(roomId) {
  const { file, binds } = loadBinds();
  const room = String(roomId || '').trim();
  let removed = null;
  for (const [id, b] of Object.entries(binds)) {
    if (b.roomId === room) {
      removed = b;
      delete binds[id];
    }
  }
  if (!removed) return { ok: false, error: `no bind for room ${room}` };
  saveBinds(file, binds);
  return { ok: true, roomId: room, file };
}

function getBindForRoom(roomId) {
  const { file, binds } = loadBinds();
  const room = String(roomId || '').trim();
  for (const b of Object.values(binds)) {
    if (b.roomId === room) return { file, bind: b };
  }
  return { file, bind: null };
}

function listBinds() {
  const { file, binds } = loadBinds();
  return {
    file,
    binds: Object.values(binds).map((b) => ({
      roomId: b.roomId,
      tokenFingerprint: b.tokenFingerprint,
      botUsername: b.botUsername,
      allowFrom: b.allowFrom || [],
      boundAt: b.boundAt,
    })),
  };
}

module.exports = {
  defaultBindPath,
  tokenFingerprint,
  loadBinds,
  bindRoom,
  unbindRoom,
  getBindForRoom,
  listBinds,
};
