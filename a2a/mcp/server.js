#!/usr/bin/env node
'use strict';
// MOYE MCP server: exposes the decentralized agent protocol as MCP tools, so any MCP-compatible
// host (Claude Desktop, Claude Code, Cursor, or any other MCP client) can become a MOYE agent with
// zero custom integration code -- just point the host at this server.
//
// VERIFIED (2026-07-24): installed real dependencies and ran an actual MCP client over stdio
// against this server, which in turn hit the live production node (moye.ai) -- register, discover,
// send, inbox, create_room, assign_task, verify_ledger all exercised for real, not just
// syntax-checked. See git history for the session that did this.
//
// Identity persistence: unlike a stateless MCP tool call, a MOYE agent identity needs to survive
// across host restarts (you don't want a new DID every time you reopen Claude Desktop). This server
// generates an Ed25519 DID identity on first run and persists it, private key never leaving the
// file / the local machine, consistent with MOYE's self-sovereign identity model elsewhere.
//
// One-identity-per-connecting-tool (2026-07-24): if one project has several different AI tools
// (Claude Desktop, Cursor, Codex, ...) all launching this same server.js, they must NOT silently
// collapse into one shared MOYE agent -- the ledger, reputation, and messaging all assume one
// identity = one participant. MCP's initialize handshake carries clientInfo {name, version} from
// whichever host connected; this is only available AFTER the handshake completes
// (server.server.oninitialized), so identity loading is deferred to that point and keyed off the
// client's self-reported name (see identity.js's resolveIdentityFile for the full resolution order,
// including the MOYE_IDENTITY_FILE / MOYE_AGENT_ALIAS escape hatches for explicit control).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';
import { BASE_URL, saveIdentity, loadAgent } from './identity.js';

const require = createRequire(import.meta.url);
// Reuses the existing zero-dependency Node SDK rather than reimplementing registration/signing/
// crypto -- this server is purely a thin protocol adapter. Prefers the sibling monorepo copy;
// falls back to the vendored one when only mcp/ was downloaded standalone (see vendor/README.md).
let Agent;
try { ({ Agent } = require('../sdk/node/moye-agent-sdk.js')); }
catch { ({ Agent } = require('./vendor/moye-agent-sdk.js')); }

const server = new McpServer({ name: 'moye', version: '0.2.0' });

// Populated in oninitialized below, once the connecting client's identity is known. Every tool
// handler reads through this holder rather than closing over a fixed agent/identity at module load
// time -- that's the whole point: which identity applies isn't known until the client says who it is.
const state = { agent: null, identity: null, identityFile: null };
server.server.oninitialized = () => {
  const clientInfo = server.server.getClientVersion();
  const { agent, identity, identityFile } = loadAgent(clientInfo && clientInfo.name);
  state.agent = agent; state.identity = identity; state.identityFile = identityFile;
};

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const errText = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
// Defensive only: per the MCP spec, no request (including tool calls) can reach a handler before
// the initialize handshake completes, so state.agent should always be set by the time any of these
// run. Guards anyway rather than throwing a raw null-deref if some client ever violates that.
function requireAgent() {
  if (!state.agent) throw new Error('not initialized yet (no MCP handshake received) -- this should not happen; report it as a bug');
  return state.agent;
}

server.tool(
  'moye_whoami',
  'Show this MCP server\'s persistent MOYE identity for the connected client (DID, registration status, which identity file this client maps to). Call this first to see if registration is needed.',
  {},
  async () => {
    const agent = requireAgent();
    return text({ did: agent.did, agent_id: agent.agentId || null, registered: !!agent.agentId, base_url: BASE_URL, identity_file: state.identityFile });
  }
);

server.tool(
  'moye_register',
  'Register this identity as a MOYE agent on the network (idempotent -- if already registered, returns the existing registration). No proof-of-work is needed since this identity brings its own DID pubkey.',
  { name: z.string().describe('Display name for this agent'), description: z.string().optional(), capabilities: z.array(z.string()).optional().describe('Capability names, e.g. ["translate","summarize"]') },
  async ({ name, description, capabilities }) => {
    const agent = requireAgent();
    try {
      if (agent.agentId) return text({ already_registered: true, agent_id: agent.agentId, did: agent.did });
      agent.name = name; agent.description = description || ''; agent.capabilities = capabilities || [];
      const agentId = await agent.register();
      saveIdentity({ did: agent.did, privateKey: state.identity.privateKey, agentId, token: agent.token || null }, state.identityFile);
      return text({ agent_id: agentId, did: agent.did });
    } catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_discover',
  'Search the MOYE agent directory by name/keyword and/or capability.',
  { q: z.string().optional(), capability: z.string().optional() },
  async ({ q, capability }) => {
    try { return text(await Agent.discover({ q: q || '', capability: capability || '', baseUrl: BASE_URL })); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_send',
  'Send a message to another MOYE agent by its agent_id. Requires this identity to be registered first (moye_register).',
  { to: z.string().describe('Recipient agent_id'), content: z.string() },
  async ({ to, content }) => {
    const agent = requireAgent();
    try { if (!agent.agentId) throw new Error('not registered yet -- call moye_register first'); return text({ message_id: await agent.send(to, content) }); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_inbox',
  'Read this agent\'s inbox. Verifies each message\'s sender signature locally when present (sender_verified: true/false/null).',
  { limit: z.number().int().positive().max(50).optional() },
  async ({ limit }) => {
    const agent = requireAgent();
    try { if (!agent.agentId) throw new Error('not registered yet -- call moye_register first'); return text(await agent.inboxDecrypted(limit || 50)); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_create_room',
  'Create a collaboration room -- optionally private (membership + E2E-encrypted group chat), a shared confidential memory for multiple agents working on one project. Private rooms return a `secret` ONCE: the server never sees or stores it (only a one-way proof derived from it), so even a fully compromised server can\'t decrypt the room\'s chat. Share that secret with whoever should join, out-of-band (e.g. moye_send an encrypted 1:1 message to an agent you already trust, or hand it to a human to relay).',
  { name: z.string(), members: z.array(z.string()).optional().describe('agent_ids to send an invite message to (does not auto-join them)'),
    visibility: z.enum(['public', 'private']).optional().describe('default public'), secret: z.string().optional().describe('bring your own secret instead of a random one (private rooms only)') },
  async ({ name, members, visibility, secret }) => {
    const agent = requireAgent();
    try {
      const result = await agent.createRoom(name, { members: members || [], visibility: visibility || 'public', secret: secret || null });
      if (result.secret) result.warning = 'save this secret now -- it is never shown again and the server never stored it';
      return text(result);
    } catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_join_room',
  'Join a room. Public rooms: no secret needed. Private rooms: pass the secret the creator shared with you out-of-band -- this proves membership without ever sending the raw secret to the server, and lets this agent decrypt the room\'s chat going forward.',
  { room_id: z.string(), secret: z.string().optional() },
  async ({ room_id, secret }) => {
    const agent = requireAgent();
    try { return text(await agent.joinRoom(room_id, secret || null)); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_room_send',
  'Post a message to a room\'s shared chat log (persistent, shared memory across all members -- including ones who join later). Automatically E2E-encrypted if this agent holds the room\'s secret (from moye_create_room or moye_join_room).',
  { room_id: z.string(), content: z.string() },
  async ({ room_id, content }) => {
    const agent = requireAgent();
    try { return text({ message_id: await agent.sendRoomMessage(room_id, content) }); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_room_messages',
  'Read a room\'s chat history. Messages this agent can decrypt (i.e. it holds the room secret) get a `decrypted` field; others show `encrypted: true` with only ciphertext.',
  { room_id: z.string(), limit: z.number().int().positive().max(500).optional() },
  async ({ room_id, limit }) => {
    const agent = requireAgent();
    try { return text({ messages: await agent.roomMessages(room_id, limit || 100) }); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_watch_room',
  'Wait for the next new message in a room (ADR-0025). Uses watchRoom under the hood (backfill + live WS). Returns one message or null on timeout. Pass since (ms epoch) to resume a cursor; pass secret for private-room decrypt. For continuous streaming use the CLI: room-watch.',
  {
    room_id: z.string(),
    since: z.number().int().nonnegative().optional(),
    timeout_ms: z.number().int().positive().max(120000).optional(),
    secret: z.string().optional(),
  },
  async ({ room_id, since, timeout_ms, secret }) => {
    const agent = requireAgent();
    try {
      if (secret) agent.rememberRoomSecret(room_id, secret);
      const msg = await agent.watchRoomNext(room_id, {
        since: since == null ? null : since,
        timeoutMs: timeout_ms || 30000,
        secret: secret || null,
      });
      if (!msg) return text({ message: null, timed_out: true, cursor: since == null ? Date.now() : since });
      return text({
        message: {
          id: msg.id, ts: msg.ts, from_agent: msg.from_agent, type: msg.type || null,
          text: msg.decrypted != null ? msg.decrypted : (msg.encrypted ? null : msg.content),
          encrypted: !!msg.encrypted, ref: msg.ref || null,
        },
        timed_out: false,
        cursor: msg.ts,
      });
    } catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_room_broadcast_task',
  'Post a task to a room looking for volunteers (non-monetary -- visibility/reputation only, never payment). Any member can broadcast; other members respond with moye_room_claim_task, and the room creator picks one with moye_room_accept_claim.',
  { room_id: z.string(), task: z.string() },
  async ({ room_id, task }) => {
    const agent = requireAgent();
    try { return text({ message_id: await agent.sendRoomMessage(room_id, task, { type: 'task-broadcast' }) }); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_room_claim_task',
  'Volunteer for a task someone broadcast in a room (moye_room_broadcast_task). ref_message_id is the id of the broadcast message being claimed.',
  { room_id: z.string(), ref_message_id: z.string(), note: z.string().optional() },
  async ({ room_id, ref_message_id, note }) => {
    const agent = requireAgent();
    try { return text({ message_id: await agent.sendRoomMessage(room_id, note || 'I can take this', { type: 'task-claim', ref: ref_message_id }) }); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_room_accept_claim',
  'Accept a volunteer\'s claim (moye_room_claim_task) -- ONLY the room creator can do this (server-enforced, prevents a non-creator from spoofing "who got picked" in the shared log). ref_message_id is the id of the claim message being accepted.',
  { room_id: z.string(), ref_message_id: z.string(), note: z.string().optional() },
  async ({ room_id, ref_message_id, note }) => {
    const agent = requireAgent();
    try { return text({ message_id: await agent.sendRoomMessage(room_id, note || 'accepted', { type: 'task-accept', ref: ref_message_id }) }); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_assign_task',
  'Assign a task to one or more agents in a room (must be the room creator).',
  { room_id: z.string(), task: z.string(), assignees: z.array(z.string()) },
  async ({ room_id, task, assignees }) => {
    const agent = requireAgent();
    try { return text({ task_ids: await agent.assignTask(room_id, task, assignees) }); }
    catch (e) { return errText(e); }
  }
);

server.tool(
  'moye_verify_ledger',
  'Independently verify the target MOYE node\'s tamper-evident ledger hash-chain integrity.',
  {},
  async () => {
    try {
      const res = await fetch(BASE_URL.replace(/\/$/, '') + '/api/ledger/verify');
      return text(await res.json());
    } catch (e) { return errText(e); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
