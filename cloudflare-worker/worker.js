/**
 * moye.ai Cloudflare Worker: forwards a2a-backend-related paths to a live origin.
 *
 * When deploying, bind this Worker to the following routes (configure under Worker Routes in
 * the Cloudflare dashboard):
 *   moye.ai/a2a/*
 *   moye.ai/api/guestbook
 *   moye.ai/api/count
 *   moye.ai/.well-known/moye-net
 *   moye.ai/.well-known/agent.json
 *   moye.ai/sdk-dist/*
 *   moye.ai/mcp-dist/*
 *
 * ORIGIN_PRIMARY should match the Cloudflare Tunnel hostname for seed1 (origin.moye.ai).
 * ORIGIN_FALLBACKS is a comma-separated list of other node public endpoints. If the primary
 * fetch throws or returns 502/503/504/521–524, the Worker tries the next origin with the
 * same stripped path. Casual users of moye.ai/a2a then survive seed1 being down.
 *
 * Tunnel still routes by Host: each attempt rewrites Host to that origin's hostname and
 * sets X-Forwarded-Host to the public moye.ai host so Agent Cards stay visitor-facing.
 */

export const DEFAULT_ORIGINS = [
  'https://origin.moye.ai',
  'https://node2-origin.moye.ai',
  'https://node3-origin.moye.ai',
];

export const FAILOVER_STATUSES = new Set([502, 503, 504, 521, 522, 523, 524]);

export function parseOrigins(primary, fallbacks) {
  const out = [];
  const seen = new Set();
  const raw = [primary, ...String(fallbacks || '').split(',')];
  for (const u of raw) {
    const t = String(u || '').trim().replace(/\/$/, '');
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length ? out : DEFAULT_ORIGINS.slice();
}

export function shouldFailoverStatus(status) {
  return FAILOVER_STATUSES.has(Number(status));
}

/** Origin 503 can be Cloudflare dying *or* application `home_unreachable`. Only hop the former. */
export async function shouldFailoverResponse(res) {
  if (!res || !shouldFailoverStatus(res.status)) return false;
  if (res.status !== 503) return true;
  try {
    const j = JSON.parse(await res.clone().text());
    if (j && (j.code === 'home_unreachable' || j.error === 'home_unreachable')) return false;
  } catch { /* non-JSON gateway 503 */ }
  return true;
}

function rewritePath(pathname) {
  let path = pathname;
  if (path === '/a2a' || path.startsWith('/a2a/')) path = path.slice(4) || '/';
  return path;
}

function proxyRequest(request, origin, url, path) {
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', '') || 'https');
  headers.set('Host', new URL(origin).hostname);
  return new Request(origin + path + url.search, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/a2a/dashboard' || url.pathname.startsWith('/a2a/dashboard/')) {
      return Response.redirect(url.origin + '/status', 302);
    }
    const path = rewritePath(url.pathname);
    const origins = parseOrigins(
      (env && env.ORIGIN_PRIMARY) || DEFAULT_ORIGINS[0],
      (env && env.ORIGIN_FALLBACKS) || DEFAULT_ORIGINS.slice(1).join(','),
    );
    const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
    let lastErr = null;
    for (let i = 0; i < origins.length; i++) {
      const origin = origins[i];
      const last = i === origins.length - 1;
      try {
        const inbound = (!isWs && !last) ? request.clone() : request;
        const res = await fetch(proxyRequest(inbound, origin, url, path));
        if (!last && await shouldFailoverResponse(res)) continue;
        return res;
      } catch (e) {
        lastErr = e;
        if (last) {
          return new Response('moye-net origin unreachable: ' + (e.message || String(e)), { status: 502 });
        }
      }
    }
    return new Response('moye-net origin unreachable: ' + (lastErr && lastErr.message || 'all origins failed'), { status: 502 });
  },
};
