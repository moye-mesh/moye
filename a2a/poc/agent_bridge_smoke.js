'use strict';
// Local smoke for ADR-0026 moye-agent-bridge (R7): room msg → match → --exec receives content.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../sdk/node/moye-agent-sdk');

const PORT = 3126;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(os.tmpdir(), `moye-bridge-smoke-${process.pid}.json`);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ALLOW_DEFAULT_FED_SECRET: '1', NODE_ID: 'bridge-smoke', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => { boot += c; });
  child.stderr.on('data', (c) => { boot += c; });

  let bridge = null;
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* */ }
      await sleep(100);
      if (i === 39) throw new Error('server boot failed: ' + boot.slice(-400));
    }

    const watcher = new Agent({ name: 'bridge-role', capabilities: ['test'], baseUrl: BASE });
    const sender = new Agent({ name: 'sender-role', capabilities: ['test'], baseUrl: BASE });
    watcher.generateIdentity();
    sender.generateIdentity();
    await watcher.register();
    await sender.register();

    const room = await watcher.createRoom('bridge-demo', { visibility: 'private' });
    await sender.joinRoom(room.room_id, room.secret);

    const idFile = path.join(os.tmpdir(), `moye-bridge-id-${process.pid}.json`);
    fs.writeFileSync(idFile, JSON.stringify({
      did: watcher.did,
      privateKey: watcher._priv,
      agentId: watcher.agentId,
      token: watcher.token || null,
      name: 'bridge-role',
    }));

    try { fs.unlinkSync(OUT); } catch { /* */ }

    bridge = spawn(process.execPath, [
      path.join(__dirname, '../tools/moye-agent-bridge.js'),
      '--room', room.room_id,
      '--secret', room.secret,
      '--match', 'coder',
      '--identity', idFile,
      '--base-url', BASE,
      '--since', String(Date.now()),
      '--once',
      '--exec', `cat > ${OUT}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let bridgeLog = '';
    bridge.stderr.on('data', (c) => { bridgeLog += c; });
    bridge.stdout.on('data', (c) => { bridgeLog += c; });

    await sleep(600);
    // Non-match should not fire
    await sender.sendRoomMessage(room.room_id, 'hello ops only', { encrypt: true });
    await sleep(400);
    assert(!fs.existsSync(OUT), 'non-matching message must not trigger exec');

    const mid = await sender.sendRoomMessage(room.room_id, '@coder please pick up R7', { encrypt: true });

    for (let i = 0; i < 50 && !fs.existsSync(OUT); i++) await sleep(100);
    assert(fs.existsSync(OUT), 'bridge did not write OUT. log=' + bridgeLog.slice(-800));

    const got = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    assert(got.id === mid, 'expected message id ' + mid + ' got ' + got.id);
    assert(/coder/i.test(got.text), 'text should include coder: ' + got.text);
    assert(got.room_id === room.room_id, 'room_id mismatch');
    console.log('BRIDGE_OK', { message_id: got.id, text: got.text });

    // Boundary check: core SDK must not grow process-launch helpers
    const sdk = fs.readFileSync(path.join(__dirname, '../sdk/node/moye-agent-sdk.js'), 'utf8');
    assert(!/child_process|spawn\(|execFile\(/.test(sdk), 'SDK must not launch processes (ADR-0026 boundary)');
    const serverHead = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert(!/moye-agent-bridge/.test(serverHead), 'server.js must not reference bridge');
    console.log('BOUNDARY_OK');
    console.log('ALL_OK');
    process.exitCode = 0;
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  } finally {
    if (bridge && !bridge.killed) try { bridge.kill('SIGTERM'); } catch { /* */ }
    child.kill('SIGTERM');
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
})();
