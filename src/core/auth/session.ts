import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { hashToken, newToken } from '@/core/tokens';

// Hashed DB sessions (groundwork `src/session.ts`). The cookie holds the raw token and the
// row only its sha256, so a database read signs no one in (INV-07). Every request reads the
// row, so deleting it is instant revocation (INV-05).
// __Host- (K1): the browser refuses it without Secure, Path=/ and no Domain, so it can't be
// set by a subdomain or over plain http. Secure is unconditional for the same reason; modern
// browsers treat http://localhost as a secure context, so local dev still works.
export const SESSION_COOKIE = '__Host-session';
const TTL_MS = 30 * 24 * 3600_000;
const FRESH_MS = 5 * 60_000;
// An enrolled user's session that has not passed TOTP dies after this, so one link buys a
// handful of guesses, not 30 days of them (FR-02).
export const PENDING_MFA_MS = 10 * 60_000;

export type SessionCtx = {
  hash: string;
  userId: string;
  email: string;
  authAt: Date;
  mfaAt: Date | null;
  mfaOrgId: string | null; // mfaAt came from this org's SSO provider, and counts only there (addendum §10.2)
  totpEnrolled: boolean;
  isDemo: boolean;
};

/** Thrown when an action needs a sign-in within the last 5 minutes (INV-26). */
export class ReauthRequired extends Refused {
  constructor() {
    super('For this change, sign in again first. A sign-in link counts as recent for 5 minutes.');
  }
}

export type SignInMethod = 'link' | 'sso' | 'demo';
const SEEN_EVERY_MS = 5 * 60_000;

/** Country only, from the edge's IP lookup (Vercel sets the header); the IP itself is never read (addendum §4). */
async function requestCountry(): Promise<string | null> {
  try {
    return /^[A-Z]{2}$/.exec((await headers()).get('x-vercel-ip-country') ?? '')?.[0] ?? null;
  } catch {
    return null; // outside a request (scripts, tests)
  }
}

/** `mfaOrgId`: an SSO sign-in whose ID token's `amr` includes `mfa`; it satisfies the MFA rule for that org only. */
export async function createSession(userId: string, opts: { mfa?: boolean; mfaOrgId?: string; method?: SignInMethod } = {}): Promise<string> {
  const token = newToken();
  const t = now();
  const mfaAt = opts.mfa || opts.mfaOrgId ? t : null;
  const method = opts.method ?? 'link';
  await db.$transaction([
    db.session.create({
      data: { hash: hashToken(token), userId, authAt: t, mfaAt, mfaOrgId: opts.mfaOrgId ?? null, createdAt: t, lastSeenAt: t, method, country: await requestCountry(), expiresAt: new Date(t.getTime() + TTL_MS) },
    }),
    db.user.update({ where: { id: userId }, data: { lastSignInAt: t, lastSignInMethod: method } }),
  ]);
  return token;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: TTL_MS / 1000, secure: true });
}

export async function sessionFor(token: string | undefined, e: { DEMO_MODE?: string } = env): Promise<SessionCtx | null> {
  if (!token) return null;
  const s = await db.session.findUnique({
    where: { hash: hashToken(token) },
    include: { user: { select: { email: true, totpEnrolledAt: true, isDemo: true } } },
  });
  if (!s || s.expiresAt <= now()) return null;
  // A demo account's TOTP seed is public (scripts/seed-demo.ts), so with the flag off it must be no login at
  // all, whichever way the session was made: /demo before the flag went off, or a sign-in link (INV-27).
  if (s.user.isDemo && e.DEMO_MODE !== '1') return null;
  if (s.user.totpEnrolledAt && !s.mfaAt && now().getTime() - s.authAt.getTime() > PENDING_MFA_MS) return null;
  // At most one write per session per 5 minutes, for the sessions list (addendum §4).
  if (!s.lastSeenAt || now().getTime() - s.lastSeenAt.getTime() > SEEN_EVERY_MS) await db.session.updateMany({ where: { hash: s.hash }, data: { lastSeenAt: now() } });
  return { hash: s.hash, userId: s.userId, email: s.user.email, authAt: s.authAt, mfaAt: s.mfaAt, mfaOrgId: s.mfaOrgId, totpEnrolled: !!s.user.totpEnrolledAt, isDemo: s.user.isDemo };
}

/** One query per request. */
export const currentSession = cache(async () => sessionFor((await cookies()).get(SESSION_COOKIE)?.value));

/**
 * The signed-in user, or a redirect: to /login with no session, to /login/mfa while an enrolled
 * user has not passed TOTP in this session. Only /login/mfa itself passes `allowPendingMfa`.
 */
export async function requireUser(opts: { allowPendingMfa?: boolean } = {}): Promise<SessionCtx> {
  const s = await currentSession();
  if (!s) redirect('/login');
  if (s.totpEnrolled && !s.mfaAt && !opts.allowPendingMfa) redirect('/login/mfa');
  return s;
}

/**
 * A demo account is shared by every /demo visitor, so nothing it does may destroy the demo or change who
 * holds it. `assertFresh` calls this, which covers every INV-26 action (org and account deletion, email
 * change, TOTP changes); membership changes and org creation in core/tenancy call it directly, and so do the
 * billing module's own actions.
 */
export function assertNotDemo(s: SessionCtx) {
  if (s.isDemo) throw new Refused('This is a shared demo account, so that is switched off here.');
}

export function assertFresh(s: SessionCtx) {
  assertNotDemo(s);
  if (now().getTime() - s.authAt.getTime() > FRESH_MS) throw new ReauthRequired();
}

export async function signOut() {
  const s = await currentSession();
  if (s) await db.session.deleteMany({ where: { hash: s.hash } });
  (await cookies()).delete(SESSION_COOKIE);
}

// K1: an outstanding, unused sign-in link is itself a way back in, so ending every session
// must end those too, or someone who kept an old link (a compromised inbox, a shared device)
// can still use it to mint a fresh one.
export async function signOutEverywhere(userId: string) {
  await db.$transaction([
    db.session.deleteMany({ where: { userId } }),
    db.loginToken.updateMany({ where: { userId, purpose: { in: ['login', 'signup'] }, usedAt: null }, data: { usedAt: now() } }),
  ]);
}

/** A TOTP change, a recovery-code use or an email change keeps only this session (INV-23). */
export const otherSessions = (s: SessionCtx) => ({ userId: s.userId, hash: { not: s.hash } });

/** The user's live sessions for /account/security, newest first; `current` marks the one making this request. */
export async function listSessions(s: SessionCtx) {
  const rows = await db.session.findMany({
    where: { userId: s.userId, expiresAt: { gt: now() } },
    orderBy: { createdAt: 'desc' },
    select: { hash: true, createdAt: true, lastSeenAt: true, country: true, method: true },
  });
  return rows.map((r) => ({ ...r, current: r.hash === s.hash }));
}

/**
 * Signs out one other session (addendum §4): deleting its row is the revocation (INV-05), and the rest hold. The row
 * key is the token's sha256, which signs no one in (INV-07), so the page can name it. The current session is refused.
 */
export async function revokeSession(s: SessionCtx, hash: string) {
  assertNotDemo(s); // a shared demo account: this would sign out another visitor
  if (hash === s.hash) throw new Refused('That is this session. Use Sign out instead.');
  await db.session.deleteMany({ where: { userId: s.userId, hash } });
}
