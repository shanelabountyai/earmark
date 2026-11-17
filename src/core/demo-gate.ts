import { createHash, timingSafeEqual } from 'node:crypto';
import { env as appEnv } from '@/core/env';

// The deployed demo's shared password (v1.6.5, from the clones' copies: boxloop, gavel, ledgerleave, tradepost,
// callboard). HTTP Basic, any username, checked by the clone's proxy.ts before anything else runs. It stands in front
// of /demo, which signs anyone in as a demo account. It is not access control: one password for everyone.
// Read through @/core/env (INV-14, K11): the clones' copies read the raw environment and missed .env.example.

export type Gate = 'open' | 'allowed' | 'challenge' | 'misconfigured';

/** The routes core ships that carry their own credential, so the password never stands between a caller and them. */
export const CORE_OWN_CREDENTIAL = ['/api/cron'] as const; // CRON_SECRET

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * On Vercel a missing password fails closed (`misconfigured`); off Vercel (dev, CI, e2e) there is no gate (`open`).
 * A changed password needs a new deployment: Vercel binds env values per deployment.
 */
export function gate(authorization: string | null, e: { DEMO_ACCESS_PASSWORD?: string; VERCEL?: string } = appEnv): Gate {
  const password = e.DEMO_ACCESS_PASSWORD;
  if (!password) return e.VERCEL ? 'misconfigured' : 'open';
  if (!authorization?.startsWith('Basic ')) return 'challenge';
  const decoded = Buffer.from(authorization.slice(6), 'base64').toString();
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return decoded.includes(':') && timingSafeEqual(digest(given), digest(password)) ? 'allowed' : 'challenge';
}

/** The response for a gate that did not admit: 401 with a Basic challenge, or 503 when the deployment has no password. */
export function gateResponse(g: Exclude<Gate, 'open' | 'allowed'>): Response {
  return g === 'misconfigured'
    ? new Response('This demo is not configured.\n', { status: 503, headers: { 'Cache-Control': 'no-store' } })
    : new Response('Demo access required.\n', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="demo", charset="UTF-8"', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
      });
}
