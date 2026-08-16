/**
 * moye.ai Cloudflare Worker: forwards a2a-backend-related paths to the origin exposed via
 * Cloudflare Tunnel; all other paths (static pages) never go through this Worker at all --
 * only paths bound to a route reach here, so there's no need for a fallback like "everything
 * else goes to Pages static assets".
 *
 * When deploying, bind this Worker to the following routes (configure under Worker Routes in
 * the Cloudflare dashboard):
 *   moye.ai/a2a/*
 *   moye.ai/api/guestbook
 *   moye.ai/api/count
 *   moye.ai/.well-known/moye-net
 *   moye.ai/.well-known/agent.json  (ADR-0005 direction 5: Agent Card interop, dynamic backend route)
 *   moye.ai/sdk-dist/*              (express.static SDK tarballs; no /a2a prefix)
 *   moye.ai/mcp-dist/*              (express.static MCP install stubs; no /a2a prefix)
 *
 * ORIGIN must match the public hostname configured in Cloudflare Tunnel (see the Cloudflare
 * migration section in docs/DEPLOY.md -- the Tunnel maps origin.moye.ai -> localhost:3100).
 *
 * Verified end-to-end 2026-07-25: every bound route (Pages static pages, /a2a/*, the two
 * /.well-known/* endpoints, /api/count) returned 200 with correct live content post-deploy.
 *
 * New backend endpoints added since (protocol adoption, seeds governance, contributions,
 * DHT-based DID resolution, A2A JSON-RPC bridge, credentials, firehose /api/stream, etc.) all
 * live under the existing /a2a/* wildcard above -- none of them need a new Worker route binding
 * here. Explicit routes are only needed for bare paths that are not under /a2a/* and would
 * otherwise be answered by Pages as missing static files (/.well-known/*, /api/guestbook,
 * /api/count, /sdk-dist/*, /mcp-dist/*).
 *
 * Note on SSE/NDJSON firehose (ADR-0013): long-lived streaming responses go through this Worker
 * as ordinary proxied HTTP. Cloudflare may idle-timeout very quiet connections; clients should
 * reconnect (the /stream page and any serious subscriber already do).
 */

const ORIGIN = 'https://origin.moye.ai';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Status UI moved to Cloudflare Pages (/status). Keep old dashboard bookmarks working
    // even before every origin node has picked up the Express redirect.
    if (url.pathname === '/a2a/dashboard' || url.pathname.startsWith('/a2a/dashboard/')) {
      return Response.redirect(url.origin + '/status', 302);
    }
    // The old nginx config was `location /a2a/ { proxy_pass http://127.0.0.1:3100/; }` --
    // the trailing slash makes nginx strip the /a2a prefix when forwarding, and all the routes
    // server.js registers on the backend have no /a2a prefix (e.g. /health, not /a2a/health).
    // We need to replicate that same prefix-stripping behavior here, otherwise every /a2a/*
    // request to the origin would 404 -- only /api/guestbook, /api/count, and
    // /.well-known/moye-net already have no /a2a prefix, so those don't need stripping.
    let path = url.pathname;
    if (path === '/a2a' || path.startsWith('/a2a/')) {
      path = path.slice(4) || '/';
    }
    const targetUrl = ORIGIN + path + url.search;

    // Builds a new request from the original method/headers/body, swapping only the URL;
    // the Host header is explicitly rewritten to the origin's own hostname, since Cloudflare
    // Tunnel routes by public hostname -- leaving it as moye.ai would make the Tunnel unable
    // to find the matching hostname mapping.
    const headers = new Headers(request.headers);
    // Tunnel routes on origin.moye.ai; keep the public host so Agent Cards / seeds are not
    // localhost or origin.moye.ai when the visitor came in on moye.ai.
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', '') || 'https');
    headers.set('Host', new URL(ORIGIN).hostname);

    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    try {
      // fetch() natively supports passing through WebSocket upgrades (Upgrade/Connection
      // headers + 101 response), no need to handle WebSocketPair manually -- this is just a
      // plain reverse proxy.
      return await fetch(proxyRequest);
    } catch (e) {
      return new Response('moye-net origin unreachable: ' + e.message, { status: 502 });
    }
  },
};
