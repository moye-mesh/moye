// Encrypted-at-rest room-secret vault for CLI / MCP (room-key platform P0).
// File beside identity; AES-256-GCM under HKDF(agent PKCS#8 DER, info="moye-room-vault-v1").
'use strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const VAULT_INFO = Buffer.from('moye-room-vault-v1');

export function resolveVaultFile(identityFile) {
  const dir = path.dirname(identityFile);
  const base = path.basename(identityFile);
  if (base === 'identity.json') return path.join(dir, 'room-secrets.json');
  const m = base.match(/^identity-(.+)\.json$/);
  if (m) return path.join(dir, `room-secrets-${m[1]}.json`);
  return path.join(dir, 'room-secrets.json');
}

function vaultKeyFromPrivPem(privPem) {
  const der = crypto.createPrivateKey(privPem).export({ type: 'pkcs8', format: 'der' });
  return Buffer.from(crypto.hkdfSync('sha256', der, Buffer.alloc(0), VAULT_INFO, 32));
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: Buffer.concat([ct, tag]).toString('base64'),
  };
}

function open(key, fileObj) {
  if (!fileObj || fileObj.v !== 1 || !fileObj.iv || !fileObj.ciphertext) {
    throw new Error('room vault: unsupported or corrupt file');
  }
  const iv = Buffer.from(fileObj.iv, 'base64');
  const ctTag = Buffer.from(fileObj.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(ctTag.subarray(ctTag.length - 16));
  const pt = Buffer.concat([decipher.update(ctTag.subarray(0, ctTag.length - 16)), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function emptyPlain() {
  return { v: 1, rooms: {} };
}

/** Disk-backed store for Agent.setRoomSecretStore(). */
export function createDiskRoomSecretStore(identityFile, privateKeyPem) {
  const vaultFile = resolveVaultFile(identityFile);
  const key = vaultKeyFromPrivPem(privateKeyPem);

  function readPlain() {
    if (!fs.existsSync(vaultFile)) return emptyPlain();
    try {
      const raw = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
      return open(key, raw);
    } catch (e) {
      throw new Error('room vault unreadable (wrong identity key or corrupt file): ' + (e.message || e));
    }
  }

  function writePlain(plain) {
    const dir = path.dirname(vaultFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(vaultFile, JSON.stringify(seal(key, plain), null, 2) + '\n', { mode: 0o600 });
  }

  return {
    vaultFile,
    list() {
      const plain = readPlain();
      const out = [];
      for (const [roomId, entry] of Object.entries(plain.rooms || {})) {
        for (const [ep, row] of Object.entries(entry.epochs || {})) {
          if (row && row.secret) out.push({ roomId, secret: row.secret, epoch: Number(ep) });
        }
      }
      return out;
    },
    put(roomId, secret, epoch = 1) {
      const plain = readPlain();
      if (!plain.rooms[roomId]) plain.rooms[roomId] = { epochs: {}, current_epoch: epoch };
      plain.rooms[roomId].epochs[String(epoch)] = { secret, added_at: Date.now() };
      plain.rooms[roomId].current_epoch = Math.max(Number(plain.rooms[roomId].current_epoch || 1), Number(epoch));
      writePlain(plain);
    },
    get(roomId, epoch = null) {
      const plain = readPlain();
      const entry = plain.rooms[roomId];
      if (!entry) return null;
      const ep = epoch != null ? epoch : (entry.current_epoch || 1);
      const row = entry.epochs && entry.epochs[String(ep)];
      return row ? row.secret : null;
    },
  };
}
