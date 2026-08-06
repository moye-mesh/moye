'use strict';
// ADR-0030: per-task SSE fan-out for A2A tasks/resubscribe.
// Same wire pattern as firehose (text/event-stream + heartbeats), scoped to one task_id
// so an external A2A client can watch lifecycle without polling tasks/get.

const crypto = require('crypto');

const HEARTBEAT_MS = Math.max(5000, parseInt(process.env.A2A_STREAM_HEARTBEAT_MS || '15000', 10));

/** @type {Map<string, Set<object>>} taskId -> clients */
const byTask = new Map();

function writeClient(client, chunk) {
  try {
    if (!client.res.writableEnded) client.res.write(chunk);
  } catch { /* client gone */ }
}

/**
 * Attach SSE to `res` for one task. Sends an immediate snapshot if `snapshot` is provided.
 * Returns { ok:true } or { ok:false, reason }.
 */
function subscribe(res, { taskId, agentId, snapshot } = {}) {
  if (!taskId || !agentId) return { ok: false, reason: 'task_id and agent required' };

  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.flushHeaders?.();

  const client = {
    id: crypto.randomBytes(6).toString('hex'),
    res,
    taskId,
    agentId,
  };
  if (!byTask.has(taskId)) byTask.set(taskId, new Set());
  byTask.get(taskId).add(client);

  writeClient(client, `: a2a task stream connected task=${taskId}\n\n`);
  writeClient(client, `event: a2a.hello\ndata: ${JSON.stringify({ ok: true, task_id: taskId, agent_id: agentId })}\n\n`);
  if (snapshot) {
    writeClient(client, `event: task\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    writeClient(client, `: ping ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const onClose = () => {
    clearInterval(heartbeat);
    const set = byTask.get(taskId);
    if (set) {
      set.delete(client);
      if (set.size === 0) byTask.delete(taskId);
    }
  };
  res.on('close', onClose);
  res.on('error', onClose);

  return { ok: true, id: client.id };
}

/** Fan out a task JSON (a2aTaskToJson shape) to any live subscribers. */
function publish(taskJson) {
  if (!taskJson || !taskJson.id) return;
  const set = byTask.get(taskJson.id);
  if (!set || !set.size) return;
  const chunk = `event: task\ndata: ${JSON.stringify(taskJson)}\n\n`;
  for (const client of [...set]) writeClient(client, chunk);
}

function info() {
  let clients = 0;
  for (const set of byTask.values()) clients += set.size;
  return { tasks: byTask.size, clients, heartbeat_ms: HEARTBEAT_MS };
}

module.exports = { subscribe, publish, info };
