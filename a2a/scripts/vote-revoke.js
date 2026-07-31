#!/usr/bin/env node
'use strict';
// A node operator casts a revoke vote against an agent, using this node's own identity.
// Usage: NODE_ID=seed1 node scripts/vote-revoke.js <target_agent_id> [--endpoint=http://localhost:3100]
const http = require('http');
const https = require('https');
const nodeIdentity = require('../lib/node_identity');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/vote-revoke.js <target_agent_id> [--endpoint=http://localhost:3100]');
  process.exit(1);
}
const endpointArg = process.argv.find(a => a.startsWith('--endpoint='));
const endpoint = (endpointArg ? endpointArg.split('=')[1] : `http://localhost:${process.env.PORT || 3100}`).replace(/\/$/, '');

const sig = nodeIdentity.sign(`revoke:${target}:${nodeIdentity.nodeId}`);
const data = JSON.stringify({ voter_node: nodeIdentity.nodeId, sig });
const u = new URL(endpoint + '/api/agents/' + target + '/revoke-vote');
const lib = u.protocol === 'https:' ? https : http;
const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
  let buf = ''; res.on('data', c => buf += c);
  res.on('end', () => {
    try {
      const body = JSON.parse(buf);
      if (!body.success) { console.error('[vote-revoke] failed:', body.error); process.exit(1); }
      console.log(`[vote-revoke] node ${nodeIdentity.nodeId} voted on ${target} -- current votes ${body.votes}/${body.threshold}, ${body.applied ? 'applied' : 'threshold not reached'}`);
    } catch (e) { console.error('[vote-revoke] failed to parse response:', buf); process.exit(1); }
  });
});
req.on('error', (e) => { console.error('[vote-revoke] request failed:', e.message); process.exit(1); });
req.write(data);
req.end();
