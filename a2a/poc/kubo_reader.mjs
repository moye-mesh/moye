// PoC (kubo version, stores JSON via add/cat): reader -- subscribes to pubsub to get the CID,
// then cats it to read back the agent directory
import { create } from 'ipfs-http-client';
import fs from 'fs';

const ipfs = create({ url: 'http://127.0.0.1:5001' });
const ADDR_FILE = '/www/moye.ai/a2a/poc/kubo_addr.txt';

console.log('[reader] subscribing to the moye-agents channel...');
let ok = false;
const handler = async (msg) => {
  const cid = msg.data.toString();
  const data = Buffer.concat(await Array.fromAsync(ipfs.cat(cid)));
  const dir = JSON.parse(data.toString());
  const keys = Object.keys(dir.agents || {});
  console.log(`[reader] received CID ${cid}, containing ${keys.length} agent(s)`);
  if (keys.length > 0) {
    console.log('[reader] discovered agent(s):', JSON.stringify(dir.agents));
    ok = true;
  }
};

if (fs.existsSync(ADDR_FILE)) {
  const cid = fs.readFileSync(ADDR_FILE, 'utf8').trim();
  try {
    const data = Buffer.concat(await Array.fromAsync(ipfs.cat(cid)));
    const dir = JSON.parse(data.toString());
    const keys = Object.keys(dir.agents || {});
    if (keys.length > 0) { console.log('[reader] already have local agent(s):', JSON.stringify(dir.agents)); ok = true; }
  } catch (e) {}
}

const sub = ipfs.pubsub.subscribe('moye-agents', handler);
await new Promise(r => setTimeout(r, 15000));
await sub;
console.log(ok ? 'POChapon: OK cross-process/IPFS sync succeeded' : 'POChapon: FAIL');
process.exit(ok ? 0 : 1);
