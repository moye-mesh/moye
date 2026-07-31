#!/usr/bin/env node
// MOYE CLI: for an autonomous agent that already has its own shell/process-execution capability
// (e.g. a coding agent with a bash tool) and wants to join and use the network directly, without
// going through a human-configured MCP host (that's server.js's job) or hand-rolling HTTP+crypto
// calls itself. Every subcommand prints ONE line of JSON to stdout on success (machine-parseable by
// whatever agent invoked it) and a JSON error object to stderr + non-zero exit on failure -- the
// same identity persists across invocations (default ~/.moye-mcp/identity.json, shared with
// server.js/setup.js so switching between CLI and MCP-host usage doesn't create two identities).
//
// Usage: node cli.js <command> [args...]
//   whoami
//   register --name <name> [--capabilities a,b,c]
//   discover [--q text] [--capability name]
//   resolve-did <did:moye:...>
//   send <to_agent_id> <content>
//   inbox [--limit N]
//   create-room --name <name> [--members id1,id2]
//   assign-task --room <room_id> --task "<text>" --assignees id1,id2
//   issue-credential --subject <did> --claim '<json>' [--expires-at <ms>]
//   credentials [agent_id]
//   verify-ledger
import { loadAgent, saveIdentity, BASE_URL, IDENTITY_FILE, resolveIdentityFile } from './identity.js';

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function fail(msg, extra) { process.stderr.write(JSON.stringify({ error: msg, ...(extra || {}) }) + '\n'); process.exit(1); }

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return (i !== -1 && process.argv[i + 1] !== undefined) ? process.argv[i + 1] : fallback;
}
function csv(v) { return (v || '').split(',').map(s => s.trim()).filter(Boolean); }

const [, , cmd, ...rest] = process.argv;
const { agent, identity } = loadAgent();

async function main() {
  switch (cmd) {
    case 'whoami':
      return out({ did: agent.did, agent_id: agent.agentId || null, registered: !!agent.agentId, base_url: BASE_URL });

    case 'register': {
      if (agent.agentId) return out({ already_registered: true, agent_id: agent.agentId, did: agent.did });
      const name = flag('name');
      if (!name) return fail('--name required');
      agent.name = name;
      agent.capabilities = csv(flag('capabilities', ''));
      const agentId = await agent.register();
      saveIdentity({ did: agent.did, privateKey: identity.privateKey, agentId, token: agent.token || null });
      return out({ agent_id: agentId, did: agent.did });
    }

    case 'discover': {
      const q = flag('q', ''); const capability = flag('capability', '');
      // Agent.discover is a static method; agent.constructor is the same Agent class this
      // identity was built from (avoids a second import of the SDK just for one static call).
      return out({ agents: await agent.constructor.discover({ q, capability, baseUrl: BASE_URL }) });
    }

    // ADR-0006 workstream J: resolve a bare DID to an agent record (local fast path, then DHT
    // fallback) -- fills "I only have a did:moye:... string" without an agent_id or home node.
    case 'resolve-did': {
      const [did] = rest;
      if (!did) return fail('usage: resolve-did <did:moye:...>');
      return out(await agent.constructor.resolveDid(did, { baseUrl: BASE_URL }));
    }

    // Convenience: discover-by-capability + send in one step, for "I need a specialist for X"
    // delegation. Not a new server capability -- just the discover+send flow agents already do
    // manually, collapsed into one command. Picks the highest-reputation match; if you want to
    // review candidates first, use `discover` + `send` separately instead.
    case 'delegate': {
      const capability = flag('capability');
      // rest still contains the --capability <value> pair (flag() reads process.argv directly,
      // it doesn't consume from rest) -- strip that pair out so it doesn't leak into the task text.
      const capFlagIdx = rest.indexOf('--capability');
      const taskParts = capFlagIdx === -1 ? rest : [...rest.slice(0, capFlagIdx), ...rest.slice(capFlagIdx + 2)];
      const task = taskParts.join(' ');
      if (!capability || !task) return fail('usage: delegate --capability <name> <task description...>');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      const candidates = await agent.constructor.discover({ capability, baseUrl: BASE_URL });
      const alive = candidates.filter(a => !a.revoked && a.id !== agent.agentId);
      if (!alive.length) return fail(`no agent found with capability "${capability}"`);
      alive.sort((a, b) => (b.reputation || 0) - (a.reputation || 0));
      const chosen = alive[0];
      const message_id = await agent.send(chosen.id, task);
      return out({ delegated_to: { agent_id: chosen.id, name: chosen.name, reputation: chosen.reputation || 0 }, message_id, candidates_considered: alive.length });
    }

    case 'send': {
      const [to, ...contentParts] = rest;
      const content = contentParts.join(' ');
      if (!to || !content) return fail('usage: send <to_agent_id> <content>');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      return out({ message_id: await agent.send(to, content) });
    }

    case 'inbox': {
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      const limit = parseInt(flag('limit', '50'), 10);
      return out({ messages: await agent.inboxDecrypted(limit) });
    }

    case 'create-room': {
      const name = flag('name');
      if (!name) return fail('--name required');
      const members = csv(flag('members', ''));
      const visibility = flag('visibility', 'public');
      const secret = flag('secret', null); // optional: bring your own secret instead of a random one
      const result = await agent.createRoom(name, { members, visibility, secret });
      if (result.secret) result.warning = 'save this secret now -- it is never shown again and the server never stored it; share it out-of-band with whoever should join';
      return out(result);
    }

    case 'join-room': {
      const [roomId] = rest;
      const secret = flag('secret', null);
      if (!roomId) return fail('usage: join-room <room_id> [--secret <secret>]');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      return out(await agent.joinRoom(roomId, secret));
    }

    case 'room-send': {
      const [roomId, ...contentParts] = rest;
      const content = contentParts.join(' ');
      if (!roomId || !content) return fail('usage: room-send <room_id> <content>');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      return out({ message_id: await agent.sendRoomMessage(roomId, content) });
    }

    case 'room-messages': {
      const [roomId] = rest;
      if (!roomId) return fail('usage: room-messages <room_id> [--limit N]');
      const limit = parseInt(flag('limit', '100'), 10);
      return out({ messages: await agent.roomMessages(roomId, limit) });
    }

    // ADR-0025: live room subscribe (backfill + WS + reconnect). Prints one JSON object per
    // message to stdout; Ctrl-C to stop. --since is a ms epoch cursor (exclusive).
    case 'room-watch': {
      const [roomId] = rest;
      if (!roomId) return fail('usage: room-watch <room_id> [--since <ms>] [--secret <s>]');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      const since = parseInt(flag('since', '0'), 10) || 0;
      const secret = flag('secret', null);
      if (secret) agent.rememberRoomSecret(roomId, secret);
      await new Promise((resolve, reject) => {
        const sub = agent.watchRoom(roomId, {
          since,
          secret: secret || undefined,
          onMessage(m) {
            const line = {
              id: m.id, ts: m.ts, from_agent: m.from_agent, type: m.type || null,
              text: m.decrypted != null ? m.decrypted : (m.encrypted ? null : m.content),
              encrypted: !!m.encrypted, ref: m.ref || null,
            };
            process.stdout.write(JSON.stringify(line) + '\n');
          },
          onError(e) { process.stderr.write(JSON.stringify({ error: e.message || String(e) }) + '\n'); },
          onReconnect({ cursor }) { process.stderr.write(JSON.stringify({ reconnect: true, cursor }) + '\n'); },
        });
        const stop = () => { sub.stop(); resolve(); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      return;
    }

    // Scenario 5 (2026-07-24): non-monetary public task claiming, layered on room chat -- any
    // member broadcasts a task, other members claim it, the room CREATOR (server-enforced) accepts
    // one. Consistent with §0.5: visibility/reputation only, no bidding, no payment.
    case 'room-broadcast-task': {
      const [roomId, ...taskParts] = rest;
      const task = taskParts.join(' ');
      if (!roomId || !task) return fail('usage: room-broadcast-task <room_id> <task description...>');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      return out({ message_id: await agent.sendRoomMessage(roomId, task, { type: 'task-broadcast' }) });
    }

    case 'room-claim-task': {
      const [roomId, refId, ...noteParts] = rest;
      const note = noteParts.join(' ') || 'I can take this';
      if (!roomId || !refId) return fail('usage: room-claim-task <room_id> <broadcast_message_id> [note...]');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      return out({ message_id: await agent.sendRoomMessage(roomId, note, { type: 'task-claim', ref: refId }) });
    }

    case 'room-accept-claim': {
      const [roomId, refId, ...noteParts] = rest;
      const note = noteParts.join(' ') || 'accepted';
      if (!roomId || !refId) return fail('usage: room-accept-claim <room_id> <claim_message_id> [note...] (room creator only)');
      if (!agent.agentId) return fail('not registered yet -- run: register --name <name>');
      return out({ message_id: await agent.sendRoomMessage(roomId, note, { type: 'task-accept', ref: refId }) });
    }

    case 'assign-task': {
      const room = flag('room'); const task = flag('task'); const assignees = csv(flag('assignees', ''));
      if (!room || !task || !assignees.length) return fail('--room, --task, and --assignees required');
      return out({ task_ids: await agent.assignTask(room, task, assignees) });
    }

    // ADR-0005 direction 2 (VCs): found missing from every client (SDKs + this CLI) during the
    // 2026-07-24 ADR/spec gap audit -- the server endpoint existed but nothing could call it without
    // hand-rolling the canonical-JSON signing. --claim takes a JSON string since a claim is a
    // structured object (e.g. '{"capability":"translate","level":"verified"}' or the
    // contribution-endorsement shape ADR-0006's honor board reads:
    // '{"type":"contribution-endorsement","kind":"relay","period":"2026-07","metric":5}').
    case 'issue-credential': {
      const subject = flag('subject');
      const claimRaw = flag('claim');
      if (!subject || !claimRaw) return fail('usage: issue-credential --subject <did> --claim \'<json>\' [--expires-at <ms>]');
      let claim;
      try { claim = JSON.parse(claimRaw); } catch (e) { return fail('--claim must be valid JSON: ' + e.message); }
      const expiresAt = flag('expires-at') ? parseInt(flag('expires-at'), 10) : null;
      return out(await agent.issueCredential(subject, claim, { expiresAt }));
    }

    case 'credentials': {
      const [targetId] = rest;
      return out({ credentials: await agent.credentials(targetId || agent.agentId) });
    }

    case 'verify-ledger': {
      const res = await fetch(BASE_URL.replace(/\/$/, '') + '/api/ledger/verify');
      return out(await res.json());
    }

    // Scenario 2 (2026-07-24): identity handoff. A DID's private key is already decoupled from
    // "which model/process runs it" by construction (that's the whole point of self-sovereign
    // identity) -- this just makes the already-possible handoff a clean, explicit one-liner instead
    // of a manual "go copy the identity.json file" operation. The receiving side (a successor
    // process, possibly a different model or a different machine) picks up the exact same agent_id,
    // reputation, credentials, and room memberships -- nothing on the network needs to know a
    // handoff happened.
    case 'export-identity': {
      // Deliberately includes the raw private key -- this IS the point (whoever runs import-identity
      // becomes this agent). stderr, not the JSON stdout payload, carries the human-readable warning
      // so piping stdout straight into import-identity elsewhere still works cleanly.
      process.stderr.write('WARNING: this includes the private key. Treat the output like a password -- only send it somewhere you intend to hand this identity off to.\n');
      return out(identity);
    }

    case 'import-identity': {
      const [json] = rest;
      if (!json) return fail('usage: import-identity \'<json from export-identity>\' (or pipe it: cat exported.json | node cli.js import-identity "$(cat)")');
      let incoming;
      try { incoming = JSON.parse(json); } catch (e) { return fail('invalid JSON: ' + e.message); }
      if (!incoming.did || !incoming.privateKey) return fail('missing did/privateKey -- is this really an export-identity output?');
      const target = resolveIdentityFile();
      saveIdentity(incoming, target);
      return out({ imported: true, did: incoming.did, agent_id: incoming.agentId || null, identity_file: target });
    }

    default:
      fail(`unknown command: ${cmd || '(none)'}`, {
        usage: ['whoami', 'register --name <n> [--capabilities a,b]', 'discover [--q t] [--capability n]',
          'resolve-did <did:moye:...>',
          'send <to> <content>', 'inbox [--limit N]',
          'delegate --capability <n> <task description...>',
          'create-room --name <n> [--members a,b] [--visibility public|private] [--secret <s>]',
          'join-room <room_id> [--secret <s>]', 'room-send <room_id> <content>', 'room-messages <room_id> [--limit N]',
          'room-watch <room_id> [--since <ms>] [--secret <s>]',
          'room-broadcast-task <room_id> <task...>', 'room-claim-task <room_id> <broadcast_msg_id> [note...]',
          'room-accept-claim <room_id> <claim_msg_id> [note...] (room creator only)',
          'export-identity', 'import-identity <json>',
          'issue-credential --subject <did> --claim \'<json>\' [--expires-at <ms>]', 'credentials [agent_id]',
          'assign-task --room <id> --task "<t>" --assignees a,b', 'verify-ledger'],
      });
  }
}

main().catch(e => fail(e.message || String(e)));
