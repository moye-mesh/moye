#!/usr/bin/env node
/**
 * MOYE WS bridge connector (zero config, NAT traversal, no Tailscale needed)
 *
 * Design principle: the agent side only ever dials out, never requires an inbound port.
 *   - registers with moye.net on startup (/api/bridge/register), gets an agent_id + bridge_token
 *   - immediately opens a persistent outbound WebSocket (/ws?agent=&token=) -- that outbound
 *     connection itself IS the tunnel
 *   - moye.net pushes messages addressed to this agent down that same connection (works behind NAT too)
 *   - replies go out over the same outbound HTTPS POST (/api/bridge/send)
 * Both directions are initiated from the agent side => works with no public IP and no Tailscale.
 *
 * To wire up a real brain: just replace brain() (Hermes / OpenClaw's model callback).
 *
 * Usage:
 *   MOYE_ENDPOINT=https://moye.ai/a2a AGENT_NAME=hermes-1 \
 *   node ws_bridge.js
 */
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const MOYE = process.env.MOYE_ENDPOINT || 'https://moye.ai/a2a';
const NAME = process.env.AGENT_NAME || 'ws-bridge';
const CAPS = (process.env.CAPABILITIES || 'general').split(',');

function request(path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(MOYE + path);
    const data = body ? JSON.stringify(body) : null;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { 'Content-Type': 'application/json', ...(headers||{}) } }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Model hook left for Hermes / OpenClaw
function brain(percept) {
  return `[${NAME}] autonomously handled message from ${percept.from}: ${percept.content}`;
}

async function main() {
  const reg = await request('/api/bridge/register', 'POST',
    { name: NAME, capabilities: CAPS });
  const { agent_id, bridge_token } = reg;
  console.log(`[register] id=${agent_id} token=${bridge_token}`);

  const wsUrl = (MOYE.replace(/^http/, 'ws')) + `/ws?agent=${agent_id}&token=${bridge_token}`;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => console.log('[ws] outbound tunnel established (NAT traversal, no Tailscale needed)'));
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'message') return;
    const m = msg.message;
    console.log(`[recv] from=${m.from_agent} content=${m.content}`);
    const reply = brain({ from: m.from_agent, content: m.content, message_id: m.id });
    if (reply) {
      await request('/api/bridge/send', 'POST',
        { to: m.from_agent, content: reply },
        { 'X-Bridge-Token': bridge_token });
      console.log(`[send] reply sent to ${m.from_agent}`);
    }
  });
  ws.on('close', () => { console.log('[ws] disconnected, reconnecting in 3s'); setTimeout(() => main(), 3000); });
  ws.on('error', (e) => console.log('[ws] error', e.message));
}

main();
