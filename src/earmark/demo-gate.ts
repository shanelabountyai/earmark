import { createHash, timingSafeEqual } from 'node:crypto';

// The deployed demo's shared password (D-64), checked by src/proxy.ts before anything else runs. HTTP Basic, any username.
// Ported from gavel `src/auction/demo-gate.ts` (same gate as boxloop, callboard, showcall and rent). It stands in front of
// /demo, which signs anyone in as an owner. Read from process.env, not @/core/env: the template owns that schema.
export type Gate = 'open' | 'allowed' | 'challenge' | 'misconfigured';

/** Paths that carry their own credential, so the password never stands between a caller and the route. */
// /api/cron: CRON_SECRET. /api/v1: bearer API keys, which also use the Authorization header. /api/demo/webhook: HMAC-signed, called by the app itself.
export const ownCredential = (path: string) => path === '/api/cron' || path === '/api/demo/webhook' || path.startsWith('/api/v1/');

const digest = (s: string) => createHash('sha256').update(s).digest();

export function gate(authorization: string | null, env: Partial<Record<string, string>>): Gate {
  const password = env.DEMO_ACCESS_PASSWORD;
  // On Vercel a missing password fails closed; locally (dev, e2e) there is no gate.
  if (!password) return env.VERCEL ? 'misconfigured' : 'open';
  if (!authorization?.startsWith('Basic ')) return 'challenge';
  const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return decoded.includes(':') && timingSafeEqual(digest(given), digest(password)) ? 'allowed' : 'challenge';
}
