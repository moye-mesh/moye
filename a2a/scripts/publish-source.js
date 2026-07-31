#!/usr/bin/env node
'use strict';
// ADR-0006 workstream B: self-distribution. Packages the repo's current git-tracked source into a
// tarball, uploads it to IPFS, and records the CID (+ sha256, git commit) on this node's own ledger
// via a `source.release` entry. The point: if every git forge (GitHub included) is unreachable or
// suspended, anyone holding this node's ledger can recover the exact source tree that produced a
// given commit -- via `ipfs cat <cid>` -- without depending on any single hosting platform.
//
// Usage: node scripts/publish-source.js [--version=1.2.0] [--arweave]
//   --arweave  also anchor the tarball permanently to Arweave (needs AR_JWK/AR_KEY, see ledger.anchorToArweave)
//
// Deliberately uses `git archive` (not a recursive fs copy) so the tarball only ever contains
// git-tracked files -- .gitignore'd secrets (data/, .env, node_modules) can never leak into it.
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ledger = require('../lib/ledger');

const REPO_ROOT = path.join(__dirname, '..', '..'); // a2a/scripts -> repo root
const OUT_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function arg(name) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}

async function main() {
  const version = arg('version') || null;
  const wantArweave = process.argv.includes('--arweave');

  let gitCommit = null;
  try { gitCommit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim(); } catch (e) {
    console.warn('[publish-source] not a git repo or git unavailable, git_commit will be null:', e.message);
  }

  const tarPath = path.join(OUT_DIR, `moye-source-${Date.now()}.tar.gz`);
  console.log('[publish-source] archiving git-tracked files with `git archive`...');
  execSync(`git archive --format=tar.gz -o "${tarPath}" HEAD`, { cwd: REPO_ROOT });

  const bytes = fs.readFileSync(tarPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  console.log(`[publish-source] tarball ${tarPath} (${bytes.length} bytes), sha256=${sha256}`);

  console.log('[publish-source] uploading to IPFS...');
  const ipfs = (await import('ipfs-http-client')).create({ url: process.env.IPFS_URL || 'http://127.0.0.1:5001' });
  const res = await ipfs.add({ path: 'moye-source.tar.gz', content: bytes });
  const cid = res.cid.toString();
  console.log(`[publish-source] uploaded, cid=${cid}`);

  let arweave_tx = null;
  if (wantArweave) {
    try {
      const Arweave = (await import('arweave')).default;
      const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
      let wallet;
      if (process.env.AR_JWK) wallet = JSON.parse(fs.readFileSync(process.env.AR_JWK, 'utf8'));
      else if (process.env.AR_KEY) wallet = JSON.parse(Buffer.from(process.env.AR_KEY, 'base64').toString('utf8'));
      else throw new Error('no AR_JWK/AR_KEY configured');
      const tx = await arweave.createTransaction({ data: bytes }, wallet);
      tx.addTag('App-Name', 'moye-net');
      tx.addTag('Type', 'source-release');
      tx.addTag('Sha256', sha256);
      if (version) tx.addTag('Version', version);
      await arweave.transactions.sign(tx, wallet);
      const r = await arweave.transactions.post(tx);
      if (r.status !== 200 && r.status !== 202) throw new Error('arweave post failed: ' + r.status);
      arweave_tx = tx.id;
      console.log(`[publish-source] anchored to arweave, tx=${arweave_tx}`);
    } catch (e) {
      console.warn('[publish-source] arweave anchor skipped:', e.message);
    }
  }

  const entry = await ledger.recordSourceRelease({
    version, git_commit: gitCommit, tarball_cid: cid, sha256, size_bytes: bytes.length, arweave_tx,
  });
  console.log(`[publish-source] recorded on ledger: seq=${entry.seq} hash=${entry.hash}`);
  console.log(`[publish-source] recover with: ipfs cat ${cid} > moye-source.tar.gz  (verify: sha256sum)`);
  fs.unlinkSync(tarPath); // the durable copy is now IPFS + the ledger pointer; no need to keep it locally
}

main().catch(e => { console.error('[publish-source] failed:', e); process.exit(1); });
