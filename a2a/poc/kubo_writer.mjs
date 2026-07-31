// PoC (kubo version, stores JSON via add/cat): writer -- serializes the agent directory to JSON,
// uploads to IPFS, broadcasts the CID over pubsub
import { create } from 'ipfs-http-client';
import fs from 'fs';

const ADDR_FILE = '/www/moye.ai/a2a/poc/kubo_addr.txt';
const ipfs = create({ url: 'http://127.0.0.1:5001' });

let dir = { agents: {} };
if (fs.existsSync(ADDR_FILE)) {
  const cid = fs.readFileSync(ADDR_FILE, 'utf8').trim();
  try {
    const data = Buffer.concat(await Array.fromAsync(ipfs.cat(cid)));
    dir = JSON.parse(data.toString());
    console.log('[writer] reusing root CID:', cid, 'containing', Object.keys(dir.agents).length, 'agent(s)');
  } catch (e) { console.log('[writer] reuse failed, rebuilding'); }
}

const id = 'ag_poc_' + Date.now();
dir.agents[id] = { name: 'poc_agent', capabilities: ['e2e', 'federation'], home_node: 'seed1', ts: Date.now() };
const added = await ipfs.add(JSON.stringify(dir));
fs.writeFileSync(ADDR_FILE, added.cid.toString());
console.log('[writer] wrote agent', id, '-> new CID', added.cid.toString());

await ipfs.pubsub.publish('moye-agents', Buffer.from(added.cid.toString()));
console.log('[writer] broadcast new CID via pubsub');

setTimeout(() => process.exit(0), 30000);
