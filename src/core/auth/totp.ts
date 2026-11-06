import { createHmac, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { Secret, TOTP } from 'otpauth';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { asSystem } from '@/core/db/rls';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { audit } from '@/core/audit';
import { hit, LIMITS, spent } from '@/core/rate-limit';
import { openSecret, sealSecret } from './secret-box';
import { assertFresh, otherSessions, requireUser, type SessionCtx } from './session';

// TOTP ported from rental `packages/core/auth/totp.ts`, with one change: the match returns
// its time step, and a code is accepted only when that step is past `totpLastStep` (INV-24).
const ISSUER = 'SaaS Foundation';
const PERIOD = 30;
const PENDING_COOKIE = 'totp_pending';

const totp = (secret: string, label = 'account') =>
  new TOTP({ issuer: ISSUER, label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: Secret.fromBase32(secret) });

/** The time step `code` matches now (drift ±1), or null. */
export function matchStep(secret: string, code: string): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const ts = now().getTime();
  try {
    const delta = totp(secret).validate({ token: c, timestamp: ts, window: 1 });
    return delta === null ? null : Math.floor(ts / 1000 / PERIOD) + delta;
  } catch {
    return null;
  }
}

// Recovery codes: 10 hex chars, shown once. HMAC-keyed rather than bare sha256 because 40 bits
// is small enough to brute-force from a dump alone; with the key, a dump is not enough.
const recoveryHash = (code: string) =>
  createHmac('sha256', env.AUTH_SECRET).update(code.toLowerCase().replace(/[^0-9a-f]/g, '')).digest('hex');

/**
 * Starts enrolment (needs a fresh sign-in, INV-26). The new secret waits sealed in an httpOnly
 * cookie, not in the user row, so an abandoned or failed re-enrolment leaves the working one alone.
 */
export async function enrolTotp(): Promise<{ uri: string; secret: string }> {
  const s = await requireUser();
  assertFresh(s);
  const secret = new Secret({ size: 20 }).base32;
  (await cookies()).set(PENDING_COOKIE, sealSecret(`${s.userId}:${secret}`, 'totp-pending'), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600, secure: env.APP_URL.startsWith('https:'),
  });
  return { uri: totp(secret, s.email).toString(), secret };
}

/** The enrolment in progress for this user, for the page to show its secret again. */
export async function pendingEnrolment(s: SessionCtx): Promise<{ uri: string; secret: string } | null> {
  const opened = openSecret((await cookies()).get(PENDING_COOKIE)?.value ?? '', 'totp-pending');
  const [userId, secret] = opened?.split(':') ?? [];
  return userId === s.userId && secret ? { uri: totp(secret, s.email).toString(), secret } : null;
}

/**
 * Activates the pending secret when `code` matches it. Returns 10 fresh recovery codes (shown
 * once), or null on a wrong code. A TOTP change signs out every other session (INV-23).
 */
export async function confirmTotp(code: string): Promise<string[] | null> {
  const s = await requireUser();
  assertFresh(s);
  const secret = (await pendingEnrolment(s))?.secret;
  if (!secret) return null;
  const step = matchStep(secret, code);
  if (step === null) return null;

  const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').replace(/^(.{5})/, '$1-'));
  const t = now();
  // K2: `totpEnrolledAt: null` in the WHERE claims the row. Two concurrent confirms both race
  // to update it; Postgres serializes them on the row lock, and the loser's WHERE no longer
  // matches once it re-checks, so it gets count 0 instead of also inserting 10 recovery codes.
  const claimed = await db.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: s.userId, totpEnrolledAt: null },
      data: { totpSecretSealed: sealSecret(secret, 'totp'), totpEnrolledAt: t, totpLastStep: step },
    });
    if (count !== 1) return false;
    await tx.recoveryCode.deleteMany({ where: { userId: s.userId } });
    await tx.recoveryCode.createMany({ data: codes.map((c) => ({ hash: recoveryHash(c), userId: s.userId })) });
    await tx.session.deleteMany({ where: otherSessions(s) });
    await tx.session.update({ where: { hash: s.hash }, data: { mfaAt: t } });
    return true;
  });
  if (!claimed) return null;
  (await cookies()).delete(PENDING_COOKIE);
  return codes;
}

/** Fresh sign-in required (INV-26); refused while the user is an owner or admin anywhere. */
export async function disableTotp(): Promise<void> {
  const s = await requireUser();
  assertFresh(s);
  // Cross-org (cross-org.ts): the user's role in every org.
  if (await asSystem((sys) => sys.membership.count({ where: { userId: s.userId, role: { in: ['owner', 'admin'] } } }))) {
    throw new Refused('Owners and admins must keep two-factor sign-in on.');
  }
  await db.$transaction([
    db.user.update({ where: { id: s.userId }, data: { totpSecretSealed: null, totpEnrolledAt: null, totpLastStep: null } }),
    db.recoveryCode.deleteMany({ where: { userId: s.userId } }),
    db.session.deleteMany({ where: otherSessions(s) }),
  ]);
}

const failKey = (userId: string) => `mfa-fail:user:${userId}`;

/** Past the daily failure cap the pending session is ended: the user needs a new link, tomorrow. */
async function pendingMfa(): Promise<SessionCtx | null> {
  const s = await requireUser({ allowPendingMfa: true });
  if (!s.totpEnrolled) return null;
  if (await spent(failKey(s.userId), LIMITS.mfaFailPerUserDay)) {
    await db.session.deleteMany({ where: { hash: s.hash, mfaAt: null } });
    return null;
  }
  return (await hit(`mfa:user:${s.userId}`, LIMITS.mfaPerUser)) ? s : null;
}

/** A wrong code: audited, and counted toward the daily cap (FR-02). Always returns false. */
async function failed(s: SessionCtx, kind: 'totp' | 'recovery'): Promise<false> {
  await audit({ userId: s.userId }, 'auth.mfa_failed', { data: { kind } });
  await hit(failKey(s.userId), LIMITS.mfaFailPerUserDay);
  return false;
}

/** Second step of sign-in. The step must beat `totpLastStep`, so a code is good once (INV-24). */
export async function verifyTotp(code: string): Promise<boolean> {
  const s = await pendingMfa();
  if (!s) return false;
  const user = await db.user.findUniqueOrThrow({ where: { id: s.userId }, select: { totpSecretSealed: true } });
  const secret = user.totpSecretSealed && openSecret(user.totpSecretSealed, 'totp');
  const step = secret ? matchStep(secret, code) : null;
  if (step === null) return failed(s, 'totp');
  const claimed = await db.user.updateMany({
    where: { id: s.userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  if (claimed.count !== 1) return failed(s, 'totp');
  await db.session.update({ where: { hash: s.hash }, data: { mfaAt: now() } });
  return true;
}

/** Stands in for TOTP once. Single use; signs out every other session (INV-23, INV-24). */
export async function redeemRecoveryCode(code: string): Promise<boolean> {
  const s = await pendingMfa();
  if (!s) return false;
  const t = now();
  const used = await db.recoveryCode.updateMany({ where: { hash: recoveryHash(code), userId: s.userId, usedAt: null }, data: { usedAt: t } });
  if (used.count !== 1) return failed(s, 'recovery');
  await db.$transaction([
    db.session.deleteMany({ where: otherSessions(s) }),
    db.session.update({ where: { hash: s.hash }, data: { mfaAt: t } }),
  ]);
  return true;
}
