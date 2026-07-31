#!/usr/bin/env node
// One-shot CLI setup (as opposed to server.js, which blocks on a stdio JSON-RPC transport and can't
// give interactive feedback). This is what a one-click installer actually runs to produce a visible
// result: generate/load identity, register on the network, and auto-wire this server into any
// detected MCP host's config -- so by the time this script exits, the effect is concrete and
// checkable (an agent_id exists on the live network; Claude Desktop, if installed, already has a
// "moye" entry waiting for a restart).
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAgent, saveIdentity, BASE_URL, IDENTITY_FILE } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'server.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
const skipRegister = process.argv.includes('--no-register');
const skipConfigure = process.argv.includes('--no-configure');
const displayName = arg('name', `moye-agent@${os.hostname()}`);
const capabilities = (arg('capabilities', '') || '').split(',').map(s => s.trim()).filter(Boolean);

console.log(`[moye-setup] identity file: ${IDENTITY_FILE}`);
console.log(`[moye-setup] target network: ${BASE_URL}`);

const { agent, identity } = loadAgent();
console.log(`[moye-setup] DID: ${agent.did}`);

if (identity.agentId) {
  console.log(`[moye-setup] already registered as agent_id=${identity.agentId} -- skipping registration`);
} else if (skipRegister) {
  console.log('[moye-setup] --no-register passed, skipping registration (run again without it later, or call the moye_register MCP tool)');
} else {
  try {
    agent.name = displayName;
    agent.capabilities = capabilities;
    const agentId = await agent.register();
    saveIdentity({ did: agent.did, privateKey: identity.privateKey, agentId, token: agent.token || null });
    console.log(`[moye-setup] registered: agent_id=${agentId} name="${displayName}"`);
    console.log(`[moye-setup] verify: curl ${BASE_URL.replace(/\/$/, '')}/api/agents/${agentId}`);
  } catch (e) {
    console.error(`[moye-setup] registration failed: ${e.message}`);
    console.error('[moye-setup] this is not fatal -- the MCP server will still run and you can retry via the moye_register tool');
  }
}

// ---- Auto-configure Claude Desktop (best-effort; safe no-op if not installed) ----
// Only edits Claude Desktop's config file (a well-documented, stable JSON format) and merges into
// any existing mcpServers rather than overwriting the file -- other MCP servers already configured
// there are left untouched. Deliberately does NOT attempt to auto-run `claude mcp add` for Claude
// Code: invoking an external CLI to mutate global config non-interactively is a bigger, less
// reversible action than editing one known JSON file, so that path is printed as a suggested command
// for the human to run themselves instead.
function claudeDesktopConfigPath() {
  const plat = process.platform;
  if (plat === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (plat === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'); // linux (unofficial but conventional)
}

if (!skipConfigure) {
  const cfgPath = claudeDesktopConfigPath();
  if (fs.existsSync(path.dirname(cfgPath))) {
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
      catch (e) { console.warn(`[moye-setup] existing Claude Desktop config at ${cfgPath} is not valid JSON, not touching it: ${e.message}`); cfg = null; }
    }
    if (cfg !== null) {
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.moye = { command: 'node', args: [SERVER_PATH] };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log(`[moye-setup] added "moye" to Claude Desktop config: ${cfgPath}`);
      console.log('[moye-setup] restart Claude Desktop for the moye_* tools to appear.');
    }
  } else {
    console.log('[moye-setup] Claude Desktop config directory not found -- skipping auto-configure (not installed, or a non-standard location)');
  }
  console.log('');
  console.log('[moye-setup] Claude Code: add this server yourself with:');
  console.log(`    claude mcp add moye -- node "${SERVER_PATH}"`);
} else {
  console.log('[moye-setup] --no-configure passed, skipping MCP host auto-configuration');
}

console.log('');
console.log('[moye-setup] done.');
