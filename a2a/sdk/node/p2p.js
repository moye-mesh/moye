'use strict';
/**
 * MOYE Node SDK optional module: real libp2p direct-connect (P3).
 * moye-agent-sdk.js itself stays zero-dependency; the libp2p deps here only load
 * if you explicitly require('./p2p') (see sdk/node/package.json).
 *
 * Usage:
 *   const { Agent } = require('./moye-agent-sdk');
 *   const { attachP2P } = require('./p2p');
 *   const agent = new Agent({ name: 'my_bot', baseUrl: 'https://moye.ai/a2a' });
 *   await attachP2P(agent);   // connects to the relay, gets a p2p address; register()/send() pick it up automatically and prefer direct
 *   await agent.register();
 *   await agent.send(otherId, 'hi');  // direct if the peer supports p2p, otherwise falls back to HTTP relay automatically
 *
 * The relay only forwards Noise-encrypted bytes, never sees plaintext -- its address is
 * auto-discovered from the server's GET /api/network p2p_relay field, never hardcoded.
 *
 * Known limitation (corrected 2026-07-23 after retesting): the previously-recorded "dcutr
 * causes the protocol stream to reset immediately after it's established" was actually a bug
 * in this file's node.handle() callback signature (it was wrongly treated as a { stream }
 * destructured object, when it's really two positional arguments (stream, connection), so
 * stream was always undefined) -- unrelated to dcutr or the version combination; ANY message
 * receive would have broken, it was just misdiagnosed as a dcutr compatibility issue at the
 * time. That bug is now fixed and dcutr is re-enabled; message delivery has been stable across
 * multiple test runs. What's still unconfirmed is whether the hole-punch upgrade actually
 * turns the connection into a true physical direct link (as opposed to still relaying bytes
 * through the relay) -- the connection list currently only ever shows the relay address, never
 * a separate direct address, so strictly speaking this may not yet be "zero-touch" direct
 * connect -- it just no longer crashes, and message delivery is reliable.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PROTOCOL = '/moye/msg/1.0.0';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(u, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function loadOrCreateKey(keyFile) {
  const { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
  if (fs.existsSync(keyFile)) {
    return privateKeyFromProtobuf(new Uint8Array(fs.readFileSync(keyFile)));
  }
  const key = await generateKeyPair('Ed25519');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  // mode 0600: this agent's libp2p private key, equivalent to an identity credential
  fs.writeFileSync(keyFile, Buffer.from(privateKeyToProtobuf(key)), { mode: 0o600 });
  return key;
}

async function waitForCircuitAddr(node, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const addr = node.getMultiaddrs().find((a) => a.toString().includes('p2p-circuit'));
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timed out waiting for the relay to assign a circuit address');
}

/**
 * Attaches libp2p direct-connect capability to an Agent instance:
 * - agent.p2pAddrs: register() picks this up automatically (see the hook in moye-agent-sdk.js)
 * - agent.send(): wrapped to try direct-connect first, falling back to the existing HTTP path on failure/timeout/unsupported peer
 * - opts.onMessage(msg): callback fired when a p2p direct message arrives (never touches the server at all)
 */
async function attachP2P(agent, opts = {}) {
  const { createLibp2p } = await import('libp2p');
  const { webSockets } = await import('@libp2p/websockets');
  const { noise } = await import('@chainsafe/libp2p-noise');
  const { yamux } = await import('@chainsafe/libp2p-yamux');
  const { identify } = await import('@libp2p/identify');
  const { dcutr } = await import('@libp2p/dcutr');
  const { circuitRelayTransport } = await import('@libp2p/circuit-relay-v2');
  const { multiaddr } = await import('@multiformats/multiaddr');

  const keyFile = opts.keyFile || path.join(os.tmpdir(), `moye_p2p_${agent.name}.key`);
  const privateKey = await loadOrCreateKey(keyFile);

  const netInfo = await fetchJson(agent.baseUrl + '/api/network');
  if (!netInfo.p2p_relay || !netInfo.p2p_relay.multiaddr) {
    throw new Error('server is not broadcasting p2p_relay info (this seed node may not have P3 enabled)');
  }

  const node = await createLibp2p({
    privateKey,
    addresses: { listen: ['/p2p-circuit'] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), dcutr: dcutr() },
  });

  await node.dial(multiaddr(netInfo.p2p_relay.multiaddr));
  const circuitAddr = await waitForCircuitAddr(node, opts.reservationTimeout || 10000);

  const inbox = [];
  // node.handle()'s callback takes two positional arguments (stream, connection), not a
  // { stream } destructured object -- this used to be wrongly destructured, so stream was
  // always undefined and the receiving side could never read any p2p message at all
  // (unrelated to whether dcutr/the relay was stable -- this callback signature was just wrong).
  await node.handle(PROTOCOL, async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk.subarray ? chunk.subarray() : chunk);
    try {
      const msg = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
      inbox.push(msg);
      if (opts.onMessage) opts.onMessage(msg);
    } catch (e) { /* ignore malformed messages that fail to parse */ }
  }, { runOnLimitedConnection: true });

  agent._p2pNode = node;
  agent._p2pInbox = inbox;
  agent.p2pAddrs = [circuitAddr.toString()];

  const originalSend = agent.send.bind(agent);
  agent.send = async function (to, content, sender, encrypted = false, nonce = null) {
    try {
      const info = await fetchJson(agent.baseUrl + '/api/agents/' + to + '/p2p');
      if (info.deliver_via === 'p2p' && info.p2p_addrs && info.p2p_addrs.length) {
        const targetAddr = multiaddr(info.p2p_addrs[0]);
        const msgId = 'msg_' + crypto.randomBytes(6).toString('hex');
        const payload = JSON.stringify({
          id: msgId, from_agent: sender || agent.agentId, to_agent: to,
          content, encrypted: !!encrypted, nonce: nonce || null, ts: Date.now(),
        });
        // Testing shows a freshly-established relay stream can occasionally get reset just
        // before the write completes, with this specific dependency combination (unrelated to
        // whether dcutr is enabled -- the plain relay path itself has a nonzero failure rate).
        // One retry (a brand-new dial, not reusing the old stream) recovers some of these --
        // doesn't get the failure rate to zero, but is better than not retrying at all.
        let lastErr;
        for (let attempt = 0; attempt < (opts.dialRetries || 2); attempt++) {
          try {
            const dialPromise = node.dialProtocol(targetAddr, PROTOCOL, { runOnLimitedConnection: true });
            const timeoutPromise = new Promise((_, rej) =>
              setTimeout(() => rej(new Error('p2p dial timeout')), opts.dialTimeout || 8000));
            const stream = await Promise.race([dialPromise, timeoutPromise]);
            stream.send(new TextEncoder().encode(payload));
            await stream.close();
            return msgId; // never touched the server at all (aside from the one address lookup GET above)
          } catch (e) {
            lastErr = e;
            if (process.env.MOYE_P2P_DEBUG) console.error(`[p2p debug] dial attempt ${attempt} failed:`, e.message);
          }
        }
        throw lastErr;
      }
    } catch (e) {
      // Direct-connect failed even after retries / timed out / peer never published a p2p address --
      // silently fall back to the existing HTTP relay path rather than throwing
      if (process.env.MOYE_P2P_DEBUG) console.error('[p2p debug] send fallback reason:', e);
    }
    // force_relay=true: tells the server "I already tried p2p direct-connect and it failed, don't
    // bounce me back to a p2p hint again this time -- just store/forward it properly" -- otherwise
    // a recipient who registered p2p_addrs but happens to be offline would have their messages
    // never delivered at all.
    return originalSend(to, content, sender, encrypted, nonce, true);
  };

  return node;
}

module.exports = { attachP2P };
