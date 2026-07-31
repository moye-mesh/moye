// Disposable local test environment for the E2E suite: spawns the real a2a/server.js on a
// throwaway SQLite db + unreachable IPFS_URL (so it runs fully memory-only, no Kubo daemon
// needed -- see the ipfs_store.js crash fix this depended on), and serves the static frontend
// from cloudflare-pages/public/ with a `/a2a/*` reverse proxy in front of it, mirroring the
// same single-origin shape production uses (nginx on the VPS / the Cloudflare Worker).
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const A2A_DIR = path.join(REPO_ROOT, 'a2a');
const PUBLIC_DIR = path.join(REPO_ROOT, 'cloudflare-pages', 'public');

const FRONTEND_PORT = Number(process.env.E2E_PORT || 13400);
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 13500);
const DB_FILE = path.join(__dirname, '.e2e-runtime.db');

for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

const backend = spawn(process.execPath, ['server.js'], {
  cwd: A2A_DIR,
  env: {
    ...process.env,
    PORT: String(BACKEND_PORT),
    NODE_ID: 'e2e',
    DB_FILE,
    IPFS_URL: 'http://127.0.0.1:19999', // deliberately unreachable -> memory-only mode
    PEERS: '',
    OPEN_INVITE: '',
    // Local throwaway backend: allow the default/empty FED_SECRET (server.js otherwise refuses to
    // start, to stop a real node running with the public default). This is exactly the local/CI
    // escape hatch documented in DEPLOY.md; the E2E suite doesn't exercise federation.
    ALLOW_DEFAULT_FED_SECRET: '1',
  },
  stdio: 'inherit',
});
backend.on('exit', (code) => {
  if (code !== null && code !== 0) {
    console.error(`[e2e-harness] backend exited unexpectedly with code ${code}`);
    process.exit(1);
  }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function proxyToBackend(req, res, subPath) {
  const target = `http://127.0.0.1:${BACKEND_PORT}${subPath}`;
  const proxyReq = http.request(target, { method: req.method, headers: req.headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('e2e-harness proxy error: ' + e.message);
  });
  req.pipe(proxyReq);
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath) && !path.extname(filePath)) filePath += '.html';
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + pathname);
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Mirrors nginx's `location /a2a/ { proxy_pass http://127.0.0.1:3100/; }` prefix-stripping,
  // and the worker's forwarding of the handful of non-/a2a API paths -- see cloudflare-worker/worker.js.
  if (url.pathname === '/a2a' || url.pathname.startsWith('/a2a/')) {
    const subPath = (url.pathname.slice(4) || '/') + url.search;
    proxyToBackend(req, res, subPath);
    return;
  }
  if (['/api/guestbook', '/api/count', '/.well-known/moye-net'].includes(url.pathname)) {
    proxyToBackend(req, res, url.pathname + url.search);
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(FRONTEND_PORT, () => {
  console.log(`[e2e-harness] serving ${PUBLIC_DIR} on :${FRONTEND_PORT}, proxying /a2a -> :${BACKEND_PORT}`);
});

function shutdown() {
  server.close();
  backend.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
