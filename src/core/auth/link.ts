import { z } from 'zod';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { asSystem } from '@/core/db/rls';
import { env } from '@/core/env';
import { sendEmail } from '@/core/email/transport';
import { hit, LIMITS } from '@/core/rate-limit';
import { hashToken, newToken } from '@/core/tokens';
import { audit } from '@/core/audit';
import { Refused } from '@/core/errors';
import { assertFresh, createSession, otherSessions, type SessionCtx } from './session';
import { ssoRefusesLink } from './sso-hook';

const TTL_MS = 15 * 60_000;
const COOLDOWN_MS = 60_000;

export const normalizeEmail = (input: string) => {
  const e = input.trim().toLowerCase();
  return z.email().safeParse(e).success ? e : null;
};

/**
 * Sends a sign-in link to a known email and a sign-up link to an unknown one (D-10). It
 * resolves the same way whatever happens, so the form cannot probe who has an account.
 * Limited per IP and per email in Postgres (INV-09), plus a 60-second per-address cooldown.
 */
export async function requestLink(input: string, ip: string): Promise<void> {
  const email = normalizeEmail(input);
  if (!email) return;
  const [ipOk, emailOk] = [await hit(`link:ip:${ip}`, LIMITS.linkPerIp), await hit(`link:email:${email}`, LIMITS.linkPerEmail)];
  if (!ipOk || !emailOk) return;
  const t = now();
  if (await db.loginToken.count({ where: { email, createdAt: { gt: new Date(t.getTime() - COOLDOWN_MS) } } })) return;

  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  // SSO-required org (INV-36): no link is sent, and the answer is the same as for any other address.
  if (user && (await ssoRefusesLink(user.id))) return;
  const token = newToken();
  await db.loginToken.create({
    data: { hash: hashToken(token), purpose: user ? 'login' : 'signup', email, userId: user?.id ?? null, createdAt: t, expiresAt: new Date(t.getTime() + TTL_MS) },
  });
  const url = `${env.APP_URL}/login/${token}`;
  await sendEmail(
    user
      ? { to: email, subject: 'Your sign-in link', body: `Sign in: ${url}\n\nThis link expires in 15 minutes. If you did not ask for it, ignore this email.` }
      : { to: email, subject: 'Create your account', body: `Create your account: ${url}\n\nThis link expires in 15 minutes. If you did not ask for it, ignore this email.` },
  );
}

/**
 * Spends a login or sign-up link, once and before expiry, and returns a raw session token or
 * null. POST only: GET must never reach this (INV-17). A sign-up link creates the user here,
 * not at request time (D-10); the upsert covers two sign-up links for one address.
 */
export async function redeemLink(token: string): Promise<string | null> {
  const hash = hashToken(token);
  const t = now();
  const spent = await db.loginToken.updateMany({
    where: { hash, purpose: { in: ['login', 'signup'] }, usedAt: null, expiresAt: { gt: t } },
    data: { usedAt: t },
  });
  if (spent.count !== 1) return null;
  const row = await db.loginToken.findUniqueOrThrow({ where: { hash } });
  // Checked again here: the link may predate the org turning SSO-required on (INV-36).
  if (row.userId && (await ssoRefusesLink(row.userId))) return null;
  const userId = row.userId ?? (await db.user.upsert({ where: { email: row.email }, create: { email: row.email }, update: {}, select: { id: true } })).id;
  return createSession(userId);
}

/**
 * Sends a confirm link to the NEW address (spec §7a.6). Needs a fresh sign-in (INV-26). An address
 * that belongs to another user gets no link and the same answer. Limited per user like link requests are per email.
 */
export async function requestEmailChange(s: SessionCtx, input: string): Promise<void> {
  assertFresh(s);
  const email = normalizeEmail(input);
  if (!email) throw new Refused('Enter a valid email address.');
  if (email === s.email) throw new Refused('That is already your email address.');
  // Counted before the lookup, and a taken address resolves exactly like a free one (D-10): otherwise
  // any signed-in user could probe who has an account, at request speed. No mail goes to a taken address.
  if (!(await hit(`email-change:user:${s.userId}`, LIMITS.linkPerEmail))) throw new Refused('Too many requests. Wait a few minutes and try again.');
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) return;
  const token = newToken();
  const t = now();
  await db.loginToken.create({
    data: { hash: hashToken(token), purpose: 'email_change', email, userId: s.userId, createdAt: t, expiresAt: new Date(t.getTime() + TTL_MS) },
  });
  await sendEmail({
    to: email,
    subject: 'Confirm your new email address',
    body: `Confirm this address: ${env.APP_URL}/account/email/${token}\n\nThis link expires in 15 minutes. If you did not ask for it, ignore this email.`,
  });
}

/**
 * Spends an email-change link for the signed-in user who asked for it (POST only). In one
 * transaction: swaps the email, signs out every other session and revokes pending invites to
 * the old address (INV-06). The old address gets a notice. False on a bad, used or stale link.
 */
export async function confirmEmailChange(s: SessionCtx, token: string): Promise<boolean> {
  const hash = hashToken(token);
  const t = now();
  const spent = await db.loginToken.updateMany({
    where: { hash, purpose: 'email_change', userId: s.userId, usedAt: null, expiresAt: { gt: t } },
    data: { usedAt: t },
  });
  if (spent.count !== 1) return false;
  const { email } = await db.loginToken.findUniqueOrThrow({ where: { hash } });
  try {
    // Cross-org (cross-org.ts): invites to the old address are revoked in every org. Under RLS the app role
    // would silently match none of them (caught by INV-06 in the enforce leg).
    await asSystem((sys) => sys.$transaction(async (tx) => {
      await tx.user.update({ where: { id: s.userId }, data: { email } });
      await tx.session.deleteMany({ where: otherSessions(s) });
      // K1: any other unused sign-in link for this account (sent to the old address) dies too.
      await tx.loginToken.updateMany({ where: { userId: s.userId, purpose: { in: ['login', 'signup'] }, usedAt: null }, data: { usedAt: t } });
      await tx.invite.updateMany({ where: { email: s.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: t } });
      await audit({ userId: s.userId }, 'account.email_changed', { targetType: 'user', targetId: s.userId }, tx);
    }));
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return false; // taken since the link was sent
    throw e;
  }
  await sendEmail({
    to: s.email,
    subject: 'Your email address was changed',
    body: 'The email address on your account was just changed. If this was not you, contact support right away.',
  });
  return true;
}
