// Shared identity bootstrap for server.js (the MCP stdio server), cli.js, and setup.js. Split out
// so setup.js can register + configure MCP hosts without booting a stdio transport that blocks
// waiting for a JSON-RPC client.
// ESM (matches this package's "type":"module"); the SDK itself is CommonJS, bridged via createRequire.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { createDiskRoomSecretStore } from './room-vault.js';

const require = createRequire(import.meta.url);
// Prefers the sibling copy in the full monorepo (../sdk/node/); falls back to the vendored copy
// (./vendor/) that ships when only the mcp/ directory is downloaded standalone (see install.sh /
// GET /mcp-dist) -- the repo layout that copy assumes doesn't exist in that case. See vendor/README.md.
let Agent;
try { ({ Agent } = require('../sdk/node/moye-agent-sdk.js')); }
catch { ({ Agent } = require('./vendor/moye-agent-sdk.js')); }

export const BASE_URL = process.env.MOYE_BASE_URL || 'https://moye.ai/a2a';
const IDENTITY_DIR = path.join(os.homedir(), '.moye-mcp');
// Legacy fixed default (kept for cli.js/setup.js, and as the fallback when no clientName is known).
export const IDENTITY_FILE = process.env.MOYE_IDENTITY_FILE || path.join(IDENTITY_DIR, 'identity.json');

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
}

// One project can have several different AI tools (Claude Desktop, Cursor, Codex, ...) all running
// this same server.js against the same MOYE network -- if they all fell back to one fixed identity
// file, they'd silently collapse into a single shared agent_id/DID, which defeats per-agent
// attribution (the ledger, reputation, and messaging all assume one identity = one participant).
// MCP's initialize handshake carries clientInfo {name, version} from whichever host connected (see
// server.js -- this becomes available only AFTER the handshake completes, via
// server.server.getClientVersion()). Resolution order:
//   1. MOYE_IDENTITY_FILE env var, if set -- always wins; explicit config beats any auto-detection.
//   2. clientName-derived path (~/.moye-mcp/identity-<slug(clientName)>.json), optionally suffixed
//      with MOYE_AGENT_ALIAS for running multiple instances of the SAME tool as distinct agents
//      (e.g. two Cursor windows on different sub-tasks of one project).
//   3. The legacy fixed default (IDENTITY_FILE), if no clientName is known (e.g. cli.js/setup.js,
//      which have no MCP handshake at all) -- unchanged single-identity behavior for those.
export function resolveIdentityFile(clientName) {
  if (process.env.MOYE_IDENTITY_FILE) return process.env.MOYE_IDENTITY_FILE;
  if (!clientName) return IDENTITY_FILE;
  const alias = process.env.MOYE_AGENT_ALIAS ? '-' + slugify(process.env.MOYE_AGENT_ALIAS) : '';
  return path.join(IDENTITY_DIR, `identity-${slugify(clientName)}${alias}.json`);
}

export function loadOrCreateIdentity(identityFile) {
  const file = identityFile || IDENTITY_FILE;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const bootstrap = new Agent({ name: 'mcp-agent', baseUrl: BASE_URL });
  const did = bootstrap.generateIdentity();
  const identity = { did, privateKey: bootstrap._priv, agentId: null, token: null };
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

export function saveIdentity(identity, identityFile) {
  fs.writeFileSync(identityFile || IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
}

// Returns { agent, identity, identityFile } -- a ready-to-use Agent instance bound to the persisted
// identity (registered or not). Pass clientName (from an MCP handshake) to get automatic
// per-tool identity separation; omit it for the legacy single fixed-path behavior (cli.js/setup.js).
export function loadAgent(clientName) {
  const identityFile = resolveIdentityFile(clientName);
  const identity = loadOrCreateIdentity(identityFile);
  const agent = new Agent({ name: 'mcp-agent', baseUrl: BASE_URL });
  agent.fromPrivateKey(identity.privateKey);
  if (identity.agentId) { agent.agentId = identity.agentId; agent.token = identity.token; }
  // P-256 E2E + room wraps: persist enc key beside DID so invite/accept works across restarts.
  if (!identity.encPrivateKey) {
    const encPub = agent.generateEncryptionKey();
    identity.encPrivateKey = agent._encPriv;
    identity.encPublicKey = encPub;
    saveIdentity(identity, identityFile);
  } else {
    agent.setEncryptionKey(identity.encPrivateKey);
  }
  const vault = createDiskRoomSecretStore(identityFile, identity.privateKey);
  agent.setRoomSecretStore(vault);
  return { agent, identity, identityFile, vault };
}
