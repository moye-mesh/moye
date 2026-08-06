'use strict';
/**
 * Shared exit-on-wake room inbound watch core (coder + ops).
 * Fixes (dev rmsg_db25d30e5997):
 * - Cursor never silently resets to Date.now(); first-ever arm uses 0 (logged).
 * - Baseline is only updated after a successful wake delivery; outstanding inbound
 *   at re-arm time must wake (arm script may clear baseline → empty hash).
 * - Cursor for inbound batches advances only on wake (not before), so a crash
 *   between poll and wake cannot permanently skip the backlog.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Agent } = require('../../sdk/node/moye-agent-sdk');

function createRoomWatch(opts) {
  const {
    role,
    wakePrefix,
    matchRegex,
    identityFile,
    cursorFile,
    baselineFile,
    ptrFile,
    lastJsonFile,
    ptrPrefix,
    armHint,
  } = opts;

  // __dirname = a2a/tools/lib → a2a root is ../..
  const ROOT = path.join(__dirname, '..', '..');
  const INBOX = process.env.ROOM_WATCH_INBOX
    ? path.resolve(process.env.ROOM_WATCH_INBOX)
    : path.join(ROOT, 'docs/mission/inbox');
  const ROOM_JSON = process.env.ROOM_WATCH_ROOM_JSON
    ? path.resolve(process.env.ROOM_WATCH_ROOM_JSON)
    : path.join(ROOT, 'docs/mission/identities/room.json');
  const ID_JSON = process.env.ROOM_WATCH_ID_JSON
    ? path.resolve(process.env.ROOM_WATCH_ID_JSON)
    : path.join(ROOT, 'docs/mission/identities', identityFile);
  const CURSOR_FILE = path.join(INBOX, cursorFile);
  const BASELINE_FILE = path.join(INBOX, baselineFile);
  const PTR_FILE = path.join(INBOX, ptrFile);
  const SLEEP_MS = Math.max(1000, parseInt(process.env.ROOM_WATCH_SLEEP_MS || '2000', 10));
  const MATCH_RE = new RegExp(matchRegex, 'i');
  const EMPTY_HASH = crypto.createHash('sha256').update('EMPTY').digest('hex');

  function out(line) {
    fs.writeSync(1, line.endsWith('\n') ? line : line + '\n');
  }
  function err(line) {
    fs.writeSync(2, line.endsWith('\n') ? line : line + '\n');
  }
  function die(msg) {
    err(JSON.stringify({ error: msg }));
    process.exit(1);
  }

  if (!fs.existsSync(ROOM_JSON) || !fs.existsSync(ID_JSON)) {
    die(`missing room.json or ${identityFile} under docs/mission/identities/`);
  }
  fs.mkdirSync(INBOX, { recursive: true });

  const room = JSON.parse(fs.readFileSync(ROOM_JSON, 'utf8'));
  const identity = JSON.parse(fs.readFileSync(ID_JSON, 'utf8'));
  const MY_ID = identity.agentId;

  const agent = new Agent({
    name: identity.name || `${role}_watch`,
    agentId: MY_ID,
    baseUrl: process.env.MOYE_BASE_URL || 'https://moye.ai/a2a',
  });
  agent.fromPrivateKey(identity.privateKey);
  if (identity.did) agent.did = identity.did;
  agent.rememberRoomSecret(room.room_id, room.membership_secret);

  function loadCursor() {
    if (!fs.existsSync(CURSOR_FILE)) {
      // First-ever arm only — AGENTS.md default "start at 0". Explicit + logged.
      err(JSON.stringify({
        cursor_init: 'first_ever_arm',
        cursor: 0,
        note: 'no cursor file ever existed; starting at 0 to catch full backlog',
      }));
      fs.writeFileSync(CURSOR_FILE, '0\n');
      return 0;
    }
    let raw;
    try {
      raw = fs.readFileSync(CURSOR_FILE, 'utf8').trim();
    } catch (e) {
      die(`cursor file exists but unreadable (${CURSOR_FILE}): ${e.message || e}`);
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
      die(`cursor file corrupt (${CURSOR_FILE}): ${JSON.stringify(raw)}`);
    }
    return n;
  }

  function saveCursor(ts) {
    fs.writeFileSync(CURSOR_FILE, String(ts) + '\n');
  }

  function textOf(m) {
    if (m.decrypted != null && m.decrypted !== '') return String(m.decrypted);
    if (m.encrypted && m.content) {
      try {
        return agent._decryptFromRoom(agent._roomKey(room.membership_secret, room.room_id), m.content);
      } catch { return ''; }
    }
    return String(m.content || '');
  }

  function isInbound(m, text) {
    if (!m || m.from_agent === MY_ID) return false;
    const hay = [text, m.from_agent || '', m.awaiting || '', m.type || '', m.id || ''].join('\n');
    if (m.awaiting === MY_ID || m.awaiting === identity.did) return true;
    return MATCH_RE.test(hay);
  }

  function inboundHash(items) {
    const parts = items
      .slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((x) => `ID:${x.id}\nFROM:${x.from_agent}\nTEXT:${x.text}`);
    return crypto.createHash('sha256').update(parts.join('\n--\n') || 'EMPTY').digest('hex');
  }

  function writePointer(items) {
    const top = items[items.length - 1];
    const bodyName = `${ptrPrefix}-${top.id}.md`;
    const bodyPath = path.join(INBOX, bodyName);
    const body = [
      `# Inbound room → ${role}`,
      ``,
      `- room: ${room.room_id}`,
      `- message_id: ${top.id}`,
      `- from: ${top.from_agent}`,
      `- ts: ${top.ts}`,
      `- type: ${top.type || ''}`,
      `- awaiting: ${top.awaiting || ''}`,
      ``,
      top.text,
      ``,
    ].join('\n');
    fs.writeFileSync(bodyPath, body);
    const summary = String(top.text).replace(/\s+/g, ' ').slice(0, 120);
    const date = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(PTR_FILE, `${bodyName}\n${summary}\n${date}\n`);
    fs.writeFileSync(path.join(INBOX, lastJsonFile), JSON.stringify({
      id: top.id,
      ts: top.ts,
      room_id: room.room_id,
      from_agent: top.from_agent,
      type: top.type || null,
      awaiting: top.awaiting || null,
      text: top.text,
      _source: 'room-watch-exit-on-wake',
      _received_at: Date.now(),
      _ptr: bodyName,
    }, null, 2) + '\n');
    return { bodyName, summary };
  }

  function loadBaseline() {
    try {
      const h = fs.readFileSync(BASELINE_FILE, 'utf8').trim();
      return h || null;
    } catch {
      return null;
    }
  }

  function saveBaseline(h) {
    fs.writeFileSync(BASELINE_FILE, h + '\n');
  }

  return (async () => {
    let cursor = loadCursor();
    // Missing baseline ⇒ empty hash (= "nothing successfully delivered yet").
    // Do NOT seed from current inbound — that would absorb outstanding backlog.
    let baseline = loadBaseline();
    if (!baseline) {
      baseline = EMPTY_HASH;
      err(JSON.stringify({
        baseline_init: 'empty_undelivered',
        note: 'no prior successful wake delivery; any outstanding inbound will wake',
      }));
    }

    out(JSON.stringify({
      armed: true,
      role,
      room_id: room.room_id,
      agent_id: MY_ID,
      cursor,
      baseline: baseline.slice(0, 12),
      sleep_ms: SLEEP_MS,
      mode: 'exit-on-wake',
      wake_prefix: wakePrefix,
    }));

    let backoffMs = SLEEP_MS;
    // First tick immediately so outstanding backlog wakes without waiting SLEEP_MS.
    let first = true;
    for (;;) {
      if (!first) await new Promise((r) => setTimeout(r, backoffMs));
      first = false;
      backoffMs = SLEEP_MS;
      let msgs;
      try {
        const ch = await agent.roomChanges(room.room_id, cursor);
        msgs = Array.isArray(ch.messages) ? ch.messages
          : (Array.isArray(ch.new_messages) ? ch.new_messages : []);
      } catch (e) {
        err(JSON.stringify({
          watch_soft_error: String(e.message || e).slice(0, 160),
          backoff_ms: Math.min(30000, SLEEP_MS * 4),
        }));
        backoffMs = Math.min(30000, Math.max(SLEEP_MS * 2, backoffMs * 2));
        continue;
      }

      let maxTsAll = cursor;
      let maxTsNonInbound = cursor;
      const inbound = [];
      for (const m of msgs) {
        if (m.ts && m.ts > maxTsAll) maxTsAll = m.ts;
        const text = textOf(m);
        if (isInbound(m, text)) {
          inbound.push({
            id: m.id,
            ts: m.ts,
            from_agent: m.from_agent,
            type: m.type || null,
            awaiting: m.awaiting || null,
            text,
          });
        } else if (m.ts && m.ts > maxTsNonInbound) {
          maxTsNonInbound = m.ts;
        }
      }

      if (inbound.length === 0) {
        // Safe to advance past noise / others' traffic.
        if (maxTsAll > cursor) {
          cursor = maxTsAll;
          saveCursor(cursor);
        }
        continue;
      }

      const h = inboundHash(inbound);
      if (h === baseline) {
        // Already delivered this exact inbound set — advance past it.
        if (maxTsAll > cursor) {
          cursor = maxTsAll;
          saveCursor(cursor);
        }
        continue;
      }

      // Outstanding / new inbound → wake. Advance cursor + baseline only after delivery.
      const { bodyName, summary } = writePointer(inbound);
      const prompt = [
        `Room inbound for ${role}. Read a2a/docs/mission/inbox/${ptrFile},`,
        `open the pointed ${ptrPrefix}-*.md, act if needed (reply/resolve in the room).`,
        `Do NOT edit ${ptrFile} when reporting outbound.`,
        armHint.replace('{ptr}', bodyName),
      ].join(' ');

      out(`${wakePrefix} ${JSON.stringify({
        prompt,
        old: baseline.slice(0, 12),
        new: h.slice(0, 12),
        ptr: bodyName,
        row: summary,
        message_ids: inbound.map((x) => x.id),
      })}`);

      saveBaseline(h);
      saveCursor(maxTsAll);
      process.exit(0);
    }
  })().catch((e) => die(e.message || String(e)));
}

module.exports = { createRoomWatch };
