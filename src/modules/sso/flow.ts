import { cookies } from 'next/headers';
import * as oidc from 'openid-client';
import { audit } from '@/core/audit';
import { normalizeEmail } from '@/core/auth/link';
import { openSecret } from '@/core/auth/secret-box';
import { createSession } from '@/core/auth/session';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { asSystem, withOrg } from '@/core/db/rls';
import { env } from '@/core/env';
import { log } from '@/core/log';
import { hit, LIMITS } from '@/core/rate-limit';
import { hashToken, newToken, safeEqual } from '@/core/tokens';
import type { Role } from '@/generated/prisma/enums';
import { emailDomain } from './hooks';

// OIDC authorization code + PKCE (addendum §3, D-25), on openid-client. Every failure after the redirect is the same
// 404 (step 4: fails closed, nothing written); only the owner's Test sign-in learns which check failed.
export const SSO_STATE_COOKIE = '__Host-sso-state';
const STATE_TTL_MS = 10 * 60_000;
// Issuers shared by every account of a provider (Google), where `hd` must match the email's domain too (§10.3).
// Tests add the mock's issuer.
export const sharedIssuers = new Set(['https://accounts.google.com']);

export const callbackUrl = () => `${env.APP_URL}/login/sso/callback`;

/** Plain http only for a provider on this machine (the e2e mock), and never in a deployed environment. */
export const insecureOk = (u: URL) => !env.VERCEL_ENV && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');

type Conn = { orgId: string; issuer: string; clientId: string; clientSecretSealed: string };

// ponytail: discovery (one fetch) on every start and callback; cache the Configuration per connection if a provider rate-limits it.
async function configFor(c: Conn) {
  const secret = openSecret(c.clientSecretSealed, 'sso');
  if (!secret) throw new Error('unreadable client secret (AUTH_SECRET rotated?)');
  const url = new URL(c.issuer);
  // Non-repudiation: check the ID token's signature against the provider's JWKS (addendum §3 step 3). openid-client
  // skips it by default for a token fetched straight from the token endpoint, trusting TLS instead (OIDC Core 3.1.3.7).
  const execute = [oidc.enableNonRepudiationChecks, ...(insecureOk(url) ? [oidc.allowInsecureRequests] : [])];
  return oidc.discovery(url, c.clientId, secret, undefined, { execute });
}

/**
 * Step 2: a single-use state row and the provider's authorization URL. The state value also goes in a cookie, so a
 * callback only completes in the browser that started it (login CSRF). Null = 404. `test`: the owner's Test sign-in,
 * allowed before the connection is enabled; the route has already checked the caller is an owner.
 */
export async function startSso(slug: string, opts: { ip: string; hint?: string; test?: boolean }): Promise<URL | null> {
  if (env.SSO_ENABLED !== '1') return null;
  if (!(await hit(`sso:ip:${opts.ip}`, LIMITS.linkPerIp))) return null;
  const org = await db.org.findUnique({ where: { slug }, select: { id: true } });
  if (!org) return null;
  const c = await withOrg({ orgId: org.id }, (tx) => tx.ssoConnection.findUnique({ where: { orgId: org.id } }), { atomic: false });
  if (!c || (!c.enabledAt && !opts.test)) return null;
  let config: oidc.Configuration;
  try {
    config = await configFor(c);
  } catch (e) {
    log('sso.discovery_failed', { orgId: org.id, error: (e as Error).name });
    return null;
  }
  const [state, nonce, codeVerifier, t] = [newToken(), oidc.randomNonce(), oidc.randomPKCECodeVerifier(), now()];
  await withOrg({ orgId: org.id }, (tx) =>
    tx.ssoState.create({ data: { hash: hashToken(state), orgId: org.id, nonce, codeVerifier, test: !!opts.test, createdAt: t, expiresAt: new Date(t.getTime() + STATE_TTL_MS) } }),
  );
  (await cookies()).set(SSO_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: STATE_TTL_MS / 1000, secure: true });
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(),
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    ...(opts.hint && { login_hint: opts.hint }),
  });
}

export type SsoDone = { kind: 'session'; token: string } | { kind: 'test'; slug: string; result: string } | null;
type Checked = { ok: true; issuer: string; subject: string; email: string; domain: string; mfa: boolean } | { ok: false; reason: string };

/** Step 3-4: exchange the code and check the ID token; then the org's domain and, for Google, `hd`. */
async function check(c: Conn, params: URLSearchParams, row: { nonce: string; codeVerifier: string }, state: string): Promise<Checked> {
  let claims: (oidc.IDToken & { email?: unknown; email_verified?: unknown }) | undefined;
  try {
    const config = await configFor(c);
    const tokens = await oidc.authorizationCodeGrant(config, new URL(`${callbackUrl()}?${params}`), {
      pkceCodeVerifier: row.codeVerifier,
      expectedNonce: row.nonce,
      expectedState: state,
      idTokenExpected: true,
    });
    claims = tokens.claims(); // iss, aud, exp, nonce and the JWKS signature are checked by openid-client
    // Okta's ID token carries `email` but never `email_verified`; userinfo does. Bound to the same `sub` (openid-client checks it).
    if (claims && (claims.email === undefined || claims.email_verified === undefined)) {
      const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      claims = { ...claims, email: info.email, email_verified: info.email_verified };
    }
  } catch (e) {
    log('sso.token_refused', { orgId: c.orgId, error: (e as Error).name, code: (e as { code?: string }).code ?? null });
    return { ok: false, reason: 'token' };
  }
  if (!claims) return { ok: false, reason: 'token' };
  const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : null;
  if (!email || claims.email_verified !== true) return { ok: false, reason: 'email_unverified' };
  const domain = emailDomain(email);
  if (sharedIssuers.has(new URL(c.issuer).origin) && claims.hd !== domain) return { ok: false, reason: 'hd' };
  const verified = await asSystem((sys) => sys.ssoDomain.findFirst({ where: { orgId: c.orgId, domain, verifiedAt: { not: null } }, select: { id: true } }));
  if (!verified) return { ok: false, reason: 'domain' }; // INV-35
  const mfa = Array.isArray(claims.amr) && claims.amr.includes('mfa');
  return { ok: true, issuer: claims.iss, subject: claims.sub, email, domain, mfa };
}

/**
 * The callback (cross-org.ts: the state names the org only once it is read). Spends the state row first, so a
 * replayed state or code is a 404 (INV-37).
 */
export async function finishSso(params: URLSearchParams): Promise<SsoDone> {
  const jar = await cookies();
  const cookieState = jar.get(SSO_STATE_COOKIE)?.value;
  jar.delete(SSO_STATE_COOKIE);
  if (env.SSO_ENABLED !== '1') return null;
  const state = params.get('state');
  if (!state || !cookieState || !safeEqual(state, cookieState)) return null;
  const row = await asSystem((sys) =>
    sys.ssoState.delete({ where: { hash: hashToken(state) }, include: { org: { select: { slug: true, ssoConnection: true } } } }).catch((e) => {
      if ((e as { code?: string }).code === 'P2025') return null;
      throw e;
    }),
  );
  const c = row?.org.ssoConnection;
  if (!row || !c || row.expiresAt <= now() || (!c.enabledAt && !row.test)) return null;

  const r = await check(c, params, row, state);
  if (row.test) return { kind: 'test', slug: row.org.slug, result: r.ok ? `ok${r.mfa ? '-mfa' : ''}` : r.reason };
  if (!r.ok) return null;
  const user = await signIn(c, r);
  if (!user) return null;
  // An enrolled user keeps their own TOTP step; the provider's MFA stands in only for users without one (§10.2).
  return { kind: 'session', token: await createSession(user.id, { method: 'sso', ...(r.mfa && !user.totpEnrolledAt ? { mfaOrgId: c.orgId } : {}) }) };
}

type Signed = Extract<Checked, { ok: true }>;

/**
 * Step 5, in one transaction, deciding before writing. A known subject is its user. An unknown one links to the user
 * with that (provider-verified) email, unless that user already has a different subject at this issuer (a recycled
 * address). Not yet a member: JIT with `defaultRole` when the domain is in `allowedDomains` (§10.3), else only with a
 * pending invite, which the user accepts on /onboarding as usual. Never an owner (INV-38), never a demo user.
 */
async function signIn(c: Conn & { allowedDomains: string[]; defaultRole: Role }, r: Signed) {
  if (c.defaultRole === 'owner') return null; // refused at save; a row edited by hand fails closed too
  const t = now();
  return asSystem((sys) =>
    sys.$transaction(async (tx) => {
      const select = { id: true, isDemo: true, totpEnrolledAt: true } as const;
      const subject = await tx.ssoSubject.findUnique({ where: { issuer_subject: { issuer: r.issuer, subject: r.subject } }, select: { user: { select } } });
      const existing = subject?.user ?? (await tx.user.findUnique({ where: { email: r.email }, select }));
      if (existing?.isDemo) return null;
      if (!subject && existing && (await tx.ssoSubject.count({ where: { issuer: r.issuer, userId: existing.id } }))) return null;
      const member = existing && (await tx.membership.findUnique({ where: { orgId_userId: { orgId: c.orgId, userId: existing.id } }, select: { role: true } }));
      const jit = !member && c.allowedDomains.includes(r.domain);
      if (!member && !jit && !(await tx.invite.count({ where: { orgId: c.orgId, email: r.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: t } } }))) return null;

      const user = existing ?? (await tx.user.create({ data: { email: r.email }, select }));
      if (!subject) await tx.ssoSubject.create({ data: { issuer: r.issuer, subject: r.subject, userId: user.id } });
      if (jit) await tx.membership.create({ data: { orgId: c.orgId, userId: user.id, role: c.defaultRole } });
      await audit({ orgId: c.orgId, userId: user.id }, 'auth.sso_signed_in', { targetType: 'user', targetId: user.id, data: { joined: jit, mfa: r.mfa } }, tx);
      return user;
    }),
  );
}
