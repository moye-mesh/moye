// Shared CLI argv helpers. flag() reads process.argv in place and does NOT consume tokens from
// `rest`. Commands that join leftover args into a posted body MUST strip flags first — otherwise
// `--secret <room_secret>` is encrypted into the room log as plaintext after decrypt (dogfood leak,
// 2026-08-17). Same class of bug `delegate` already special-cased for `--capability`.
export const FLAGS_WITH_VALUE = new Set([
  'secret', 'limit', 'since', 'members', 'name', 'visibility', 'url', 'rooms',
  'capabilities', 'webhook-url', 'q', 'capability', 'description', 'wrap',
  'show-secret', 'room', 'token', 'allow-from', 'subject', 'claim', 'expires-at',
  'node', 'task', 'assignees',
]);

export const FLAGS_BOOL = new Set(['clear', 'all', 'none']);

/**
 * Return positional tokens only. `--flag value` and boolean flags are dropped.
 * `--` ends flag parsing (rest is positional, including values that look like flags).
 */
export function stripFlags(args) {
  const out = [];
  if (!Array.isArray(args)) return out;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (typeof a === 'string' && a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (FLAGS_BOOL.has(name)) continue;
      if (a.includes('=')) continue;
      const next = args[i + 1];
      if (next != null && typeof next === 'string' && !next.startsWith('-')) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}
