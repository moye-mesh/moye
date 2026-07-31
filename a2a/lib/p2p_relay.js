'use strict';
// moye-net P3: this node doubles as a libp2p circuit-relay-v2 relay -- agents behind NAT connect to
// each other through this node, but it only forwards Noise-encrypted bytes and never sees plaintext.
// The relay's libp2p identity (PeerId) is a separate persisted keypair, distinct from the
// DID/Ed25519-PEM identity in lib/node_identity.js -- don't conflate the two.
//
// Update (2026-07-23): the dcutr incompatibility once suspected here turned out to be a callback
// signature bug in the client-side SDK (sdk/node/p2p.js), not a relay-side issue -- see that file's
// header comment for details. This relay module itself never used dcutr in the first place; it only
// runs circuitRelayServer().
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;

const NODE_ID = process.env.NODE_ID || 'seed1';
const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, `${NODE_ID}-libp2p-key.bin`);
const LIBP2P_PORT = parseInt(process.env.LIBP2P_PORT || '4100', 10);

let node = null;

// ADR-0006 workstream E1 (partial, honest scope): resolving PUBLIC_ENDPOINT to a non-private IP is a
// NECESSARY but not SUFFICIENT signal for "this node is a viable relay candidate" -- it doesn't
// confirm the port itself is actually open/forwarded, which would need a real external vantage point
// this environment doesn't have. Exposed as a hint for an operator (or another node) to weigh, NOT an
// automatic trigger that flips ENABLE_P2P on by itself -- that stays a deliberate, manual opt-in
// pending real multi-node/NAT verification (same caution ADR-0005 F4 and this file's dcutr history
// already established for anything relay/routing-related).
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
  return false;
}
async function reachabilityHint() {
  const endpoint = process.env.PUBLIC_ENDPOINT;
  if (!endpoint) return 'unknown';
  let host;
  try { host = new URL(endpoint).hostname; } catch { return 'unknown'; }
  try {
    if (net.isIP(host)) return isPrivateIp(host) ? 'private' : 'public';
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return 'unknown';
    return addrs.every(a => !isPrivateIp(a.address)) ? 'public' : 'private';
  } catch { return 'unknown'; }
}

async function loadOrCreateKey() {
  const { generateKeyPair } = await import('@libp2p/crypto/keys');
  const { privateKeyToProtobuf, privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    return privateKeyFromProtobuf(new Uint8Array(fs.readFileSync(KEY_FILE)));
  }
  const key = await generateKeyPair('Ed25519');
  fs.writeFileSync(KEY_FILE, Buffer.from(privateKeyToProtobuf(key)), { mode: 0o600 });
  return key;
}

async function init() {
  const { createLibp2p } = await import('libp2p');
  const { webSockets } = await import('@libp2p/websockets');
  const { noise } = await import('@chainsafe/libp2p-noise');
  const { yamux } = await import('@chainsafe/libp2p-yamux');
  const { identify } = await import('@libp2p/identify');
  const { ping } = await import('@libp2p/ping');
  const { circuitRelayServer } = await import('@libp2p/circuit-relay-v2');

  const privateKey = await loadOrCreateKey();
  // ADR-0006 workstream E3 (partial): the library's own default (15) was previously implicit --
  // making it an explicit, operator-tunable env var is the concrete self-throttle a weak node (the
  // ADR's own "458MB node3" example) needs, without requiring any new dependency or real NAT testing
  // to verify (this is a request-admission limit, not a network-behavior claim). Options confirmed
  // against the actually-installed @libp2p/circuit-relay-v2 package's types, not guessed.
  const maxReservations = parseInt(process.env.RELAY_MAX_RESERVATIONS || '15', 10);
  const services = {
    identify: identify(),
    // only forwards encrypted byte streams, never parses message content
    relay: circuitRelayServer({ reservations: { maxReservations } }),
    // ADR-0006 workstream F2: @libp2p/kad-dht hard-requires a ping service capability to be present
    // on the node -- discovered via a real startup crash the first time ENABLE_DHT was ever actually
    // exercised end-to-end ("required capability @libp2p/ping but it was not provided"). Always
    // registered (cheap, harmless when DHT is off) rather than conditionally, so this dependency
    // never silently regresses again.
    ping: ping(),
  };
  // ADR-0006 workstream F1: kad-DHT is its own flag layered on top of ENABLE_P2P, not implied by it
  // -- turning on the relay shouldn't silently also join a DHT. Uses a MOYE-specific protocol string,
  // NOT the default `/ipfs/kad/1.0.0` -- that default is the public IPFS mainnet DHT, and joining it
  // from an app-specific libp2p node would be uninvited protocol pollution on someone else's network.
  //
  // ADR-0006 workstream F2 -- REAL 3-node production test, 2026-07-25 (not simulated, not localhost):
  // ran on seed1/node2/node3 with DHT_SERVER_MODE=1 + the announce-address fix above. Confirmed:
  //   1. Client-mode-only nodes never register a DHT protocol handler for INCOMING queries -- two
  //      client-mode nodes literally cannot query each other. At least one side needs server mode.
  //   2. @libp2p/kad-dht hard-requires the `ping` service to be registered (crashes on start without
  //      it) -- not documented anywhere obvious, found via the actual crash.
  //   3. Without the `announce` fix above, routing tables NEVER populate, no matter how long two
  //      nodes stay connected -- confirmed by leaving two production nodes connected with no announce
  //      address and watching routing table size stay at 0 indefinitely.
  //   4. With both fixes: two independent, real VPS nodes (different cloud providers, different
  //      continents-worth-of-latency) added each other to their routing tables -- but this took up to
  //      ~110 seconds in observed testing, much longer than the library's own 10s onPeerConnectTimeout
  //      constant would suggest. Treat DHT routing-table convergence as eventually-consistent on the
  //      order of minutes, not seconds -- do not build anything that assumes fast convergence.
  //   5. Real third-party discovery confirmed: a third node (seed1), which had ONLY ever dialed one
  //      hub node (node3) and had NEVER directly connected to a second node (node2), successfully
  //      discovered node2's PeerId and multiaddrs via `dht.getClosestPeers()` querying only the hub --
  //      genuine no-DNS, no-central-directory peer discovery, not a simulated result.
  //   6. `peerRouting.findPeer()` (the higher-level convenience wrapper) did NOT succeed in this same
  //      test even though the lower-level `getClosestPeers()` did -- not yet root-caused; use
  //      `getClosestPeers()` directly if adding real callers of this, until findPeer is separately
  //      verified.
  // DHT_SERVER_MODE stays off by default (client-mode, unchanged prior behavior) -- this project
  // doesn't silently change network behavior; an operator opts in deliberately.
  const dhtServerMode = process.env.DHT_SERVER_MODE === '1';
  if (process.env.ENABLE_DHT === '1') {
    const { kadDHT } = await import('@libp2p/kad-dht');
    services.dht = kadDHT({ clientMode: !dhtServerMode, protocol: '/moye/kad/1.0.0' });
  }
  // ADR-0006 workstream F2 (real 3-node production test, 2026-07-25): without an explicit `announce`
  // address, this node self-reports ONLY its raw `listen: 0.0.0.0` interface enumeration via the
  // identify protocol -- on a real VPS that's loopback/private-LAN/CGNAT/docker-bridge addresses, NOT
  // the actual public IP. kad-dht's default peerInfoMapper (removePrivateAddressesMapper) then
  // silently drops the peer from routing-table consideration entirely (multiaddrs.length === 0 after
  // filtering) -- this was invisible before because nothing had ever exercised DHT peer registration
  // for real. Confirmed by direct real-node testing: two production nodes with no announce address
  // never added each other to their routing tables no matter how long they stayed connected; the
  // exact same two nodes, only differing by this one config, converged within ~2 minutes. Resolves
  // PUBLIC_ENDPOINT's hostname to an IP once at startup (not on every dial) -- matches exactly what
  // was verified working; P2P_PUBLIC_HOSTNAME (Cloudflare Tunnel) uses the dns4/wss form already used
  // by publicMultiaddr() below, untested against a real tunnel as part of this pass.
  const announce = [];
  if (process.env.P2P_PUBLIC_HOSTNAME) {
    announce.push(`/dns4/${process.env.P2P_PUBLIC_HOSTNAME}/tcp/443/wss`);
  } else if (process.env.PUBLIC_ENDPOINT) {
    try {
      const host = new URL(process.env.PUBLIC_ENDPOINT).hostname;
      const resolved = net.isIP(host) ? host : (await dns.lookup(host)).address;
      announce.push(`/ip4/${resolved}/tcp/${LIBP2P_PORT}/ws`);
    } catch (e) {
      console.log('[p2p-relay] could not resolve PUBLIC_ENDPOINT for announce address, DHT routing-table registration will likely fail:', e.message);
    }
  }
  node = await createLibp2p({
    privateKey,
    addresses: { listen: [`/ip4/0.0.0.0/tcp/${LIBP2P_PORT}/ws`], announce },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services,
  });
  console.log(`[p2p-relay] libp2p relay started peerId=${node.peerId.toString()} port=${LIBP2P_PORT}` +
    (services.dht ? ` (kad-dht ${dhtServerMode ? 'server' : 'client'}-mode enabled)` : '') + ` maxReservations=${maxReservations}`);
  // ADR-0006 workstream F2: without this, an ENABLE_DHT node has no mechanism at all to learn about
  // another MOYE node's libp2p PeerId/multiaddr -- @libp2p/bootstrap was a listed dependency but
  // never actually wired up anywhere. Reuses the SAME `PEERS` env var the HTTP federation layer
  // already parses (`id=endpoint` pairs): for each configured peer, fetch its already-public
  // /.well-known/moye-net (no new auth surface) to read its own advertised p2p_relay.multiaddr, and
  // dial it directly. Best-effort -- a peer that hasn't enabled its own relay yet, or is
  // unreachable, is skipped and logged, never fatal to this node's own startup.
  if (services.dht && process.env.PEERS) {
    dialConfiguredPeers(node).catch(e => console.log('[p2p-relay] peer dial pass failed:', e.message));
  }
  return node;
}

async function dialConfiguredPeers(node) {
  const { multiaddr } = await import('@multiformats/multiaddr');
  const peers = process.env.PEERS.split(/\s+/).filter(Boolean)
    .map(s => { const [id, endpoint] = s.split('='); return { id, endpoint }; });
  for (const p of peers) {
    try {
      const res = await fetch(p.endpoint.replace(/\/$/, '') + '/.well-known/moye-net', { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const addr = data && data.p2p_relay && data.p2p_relay.multiaddr;
      if (!addr) { console.log(`[p2p-relay] peer ${p.id} has no advertised multiaddr yet, skipping`); continue; }
      await node.dial(multiaddr(addr));
      console.log(`[p2p-relay] dialed peer ${p.id} at ${addr}`);
    } catch (e) {
      console.log(`[p2p-relay] failed to dial peer ${p.id} (${p.endpoint}): ${e.message}`);
    }
  }
}

// ADR-0006 workstream F2 continued (2026-07-25): DID -> PeerID mapping via the DHT, the specific
// MOYE use case the earlier generic getClosestPeers() verification didn't cover yet. Uses kad-dht's
// content-routing (provide/findProviders, CID-keyed) instead of raw put/get -- put/get's default
// record validators only recognize a few built-in key namespaces (pk/ipns) and silently discard
// anything else ("invalid record received, discarded", found via real testing), whereas provider
// records for an arbitrary CID need no such registration. The DID string itself becomes the CID's
// input (raw codec + sha256), so any two parties independently compute the identical CID from the
// same DID with no coordination needed.
//
// What this maps, precisely: "which MOYE node currently knows about this DID and can be asked for
// its p2p_addrs/overlay_addr" -- the provider is THIS NODE (its own relay PeerId), not the agent's
// own separate libp2p identity (sdk/node/p2p.js's optional per-agent keypair, a different thing).
// A caller still needs one more hop (GET /api/agents/:id/resolve or /p2p on whichever node
// findProviders() returns) to get the agent's actual multiaddrs -- this solves "which node do I even
// ask", not "here is the final connectable address" in one step.
async function cidForDid(did) {
  const { CID } = await import('multiformats/cid');
  const { sha256 } = await import('multiformats/hashes/sha2');
  const raw = await import('multiformats/codecs/raw');
  const hash = await sha256.digest(new TextEncoder().encode(did));
  return CID.create(1, raw.code, hash);
}
// ADR-0006 workstream F2 continued: provide()/findProviders() can hang indefinitely on a node with
// an empty (or not-yet-converged) routing table -- found via real testing (a freshly-started,
// still-isolated node's provide() call never returned). A DHT query is inherently best-effort against
// a network that may not have converged yet (routing-table convergence itself was measured taking up
// to ~110s in real production testing), so both functions below cap how long they'll wait rather than
// hanging the caller (an HTTP request handler) forever.
const DHT_QUERY_TIMEOUT_MS = 20000;

// Announces this node as a provider for `did` -- call after any update to an agent's overlay_addr/
// p2p_addrs so the DHT (if enabled) stays current. Best-effort and silent on failure/no-DHT/timeout:
// this is a supplementary discovery path, not the source of truth (GET /api/agents/:id/resolve is).
async function provideDid(did) {
  if (!node || !node.services.dht) return false;
  try {
    const cid = await cidForDid(did);
    const signal = AbortSignal.timeout(DHT_QUERY_TIMEOUT_MS);
    for await (const _event of node.services.dht.provide(cid, { signal })) { /* drain the query */ }
    return true;
  } catch (e) {
    console.log(`[p2p-relay] provideDid failed for ${did}: ${e.message}`);
    return false;
  }
}
// Looks up which node(s) currently provide `did` via the DHT. Returns [] (not an error) if DHT is
// off, times out, or nothing is found -- callers should treat this as "try the ledger-anchored
// resolve instead", never as a hard failure.
async function findProvidersForDid(did) {
  if (!node || !node.services.dht) return [];
  const cid = await cidForDid(did);
  const providers = [];
  try {
    const signal = AbortSignal.timeout(DHT_QUERY_TIMEOUT_MS);
    for await (const event of node.services.dht.findProviders(cid, { signal })) {
      if (event.name === 'PROVIDER' && event.providers) {
        for (const p of event.providers) providers.push({ peer_id: p.id.toString(), multiaddrs: p.multiaddrs.map(a => a.toString()) });
      }
    }
  } catch (e) {
    console.log(`[p2p-relay] findProvidersForDid timed out or failed for ${did}: ${e.message}`);
  }
  return providers;
}
// Public multiaddr for external callers (the agent SDK) to dial.
// multiaddr doesn't support arbitrary URL path segments after /ws (tried /dns4/.../wss/p2p-relay/...
// and got a hard parse error, "Protocol p2p-relay was unknown"), so this can't be proxied through
// nginx by path -- LIBP2P_PORT is exposed directly instead, the same way IPFS's own 5001 API port
// is handled (also a direct connection, not routed through nginx).
function publicMultiaddr() {
  if (!node) return null;
  // When exposed via Cloudflare Tunnel, TLS terminates at the Tunnel's edge on 443 -- the locally
  // listening LIBP2P_PORT is only used for the Tunnel's internal forwarding, external clients need
  // to dial wss+443, not ws+LIBP2P_PORT.
  // Falls back to the old behavior if P2P_PUBLIC_HOSTNAME isn't set: LIBP2P_PORT is exposed directly
  // (requires opening that port in the firewall).
  if (process.env.P2P_PUBLIC_HOSTNAME) {
    return `/dns4/${process.env.P2P_PUBLIC_HOSTNAME}/tcp/443/wss/p2p/${node.peerId.toString()}`;
  }
  const base = process.env.PUBLIC_ENDPOINT || `http://localhost:${LIBP2P_PORT}`;
  const host = new URL(base).hostname;
  return `/dns4/${host}/tcp/${LIBP2P_PORT}/ws/p2p/${node.peerId.toString()}`;
}

function info() {
  if (!node) return null;
  return {
    peer_id: node.peerId.toString(),
    multiaddr: publicMultiaddr(),
    listen_addrs: node.getMultiaddrs().map(a => a.toString()),
  };
}

module.exports = { init, info, reachabilityHint, provideDid, findProvidersForDid, node: () => node };
