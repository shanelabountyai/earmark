import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import '@/app/modules'; // registers the hooks, as the sign-in routes do
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sealSecret } from '@/core/auth/secret-box';
import { redeemLink, requestLink } from '@/core/auth/link';
import { resolveSso } from '@/core/auth/sso-hook';
import { createSession, SESSION_COOKIE } from '@/core/auth/session';
import { requireOrg } from '@/core/authz/guards';
import { advanceClock, now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { hashToken, newToken } from '@/core/tokens';
import { finishSso, resolver, sharedIssuers, SSO_STATE_COOKIE, startSso } from '@/modules/sso/flow';
import { addDomain, dns, saveConnection, setRequired, txtValue, verifyDomain } from '@/modules/sso/settings';
import { makeUser, resetAuthTables, signInAs } from '../helpers/auth';
import { jar, NavSignal } from '../helpers/next';
import { addMember, actAs, makeOrg } from '../helpers/org';
import { startOidcMock, type MockUser, type OidcMock } from '../helpers/oidc-mock';

// Addendum §3, §8 and §10.2-3, against the local mock provider. Module invariants: they go with the `sso` module.
let mock: OidcMock;
const DOMAIN = 'sso.example';
const ALICE: MockUser = { sub: 'sub-alice', email: `alice@${DOMAIN}`, email_verified: true };

beforeAll(async () => {
  mock = await startOidcMock();
  env.SSO_ENABLED = '1';
});
afterAll(async () => {
  env.SSO_ENABLED = undefined;
  await mock.close();
});

let org: { id: string; slug: string };
async function connect(extra: { allowedDomains?: string[]; defaultRole?: 'member' | 'admin' | 'owner'; issuer?: string } = {}, slug = 'sso-a', domain = DOMAIN) {
  const o = await makeOrg(slug);
  await db.ssoConnection.create({
    data: {
      orgId: o.id,
      issuer: extra.issuer ?? mock.issuer,
      clientId: mock.client.id,
      clientSecretSealed: sealSecret(mock.client.secret, 'sso'),
      allowedDomains: extra.allowedDomains ?? [domain],
      defaultRole: extra.defaultRole ?? 'member',
      enabledAt: now(),
    },
  });
  await db.ssoDomain.create({ data: { orgId: o.id, domain, verifiedAt: now() } });
  return o;
}

beforeEach(async () => {
  await resetAuthTables();
  mock.tamper = null;
  mock.okta = false;
  mock.user = { ...ALICE };
  org = await connect();
});

/** One full browser round trip: start, the provider's redirect, then the callback. */
async function signIn(user: Partial<MockUser> = {}, slug = org.slug) {
  Object.assign(mock.user, user);
  const url = await startSso(slug, { ip: randomUUID() });
  expect(url).not.toBeNull();
  const res = await fetch(url!, { redirect: 'manual' });
  const params = new URL(res.headers.get('location')!).searchParams;
  const state = jar.get(SSO_STATE_COOKIE)!;
  return { params, state, done: await finishSso(params) };
}

const counts = async () => ({ users: await db.user.count(), members: await db.membership.count(), sessions: await db.session.count(), subjects: await db.ssoSubject.count() });

describe('the happy path (JIT on an allowed, verified domain)', () => {
  it('creates the user, links the subject, joins as defaultRole, and writes one session', async () => {
    const { done } = await signIn();
    expect(done?.kind).toBe('session');
    const u = await db.user.findUniqueOrThrow({ where: { email: ALICE.email } });
    expect((await db.membership.findUniqueOrThrow({ where: { orgId_userId: { orgId: org.id, userId: u.id } } })).role).toBe('member');
    expect(await db.ssoSubject.findUnique({ where: { issuer_subject: { issuer: mock.issuer, subject: ALICE.sub } } })).not.toBeNull();
    expect(await db.session.count({ where: { userId: u.id } })).toBe(1);
  });

  it('Okta: email_verified only in userinfo (not the ID token) still joins; unverified there is still a 404', async () => {
    mock.okta = true;
    expect((await signIn()).done?.kind).toBe('session');
    const before = await counts();
    expect((await signIn({ sub: 'sub-bob', email: `bob@${DOMAIN}`, email_verified: false })).done).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it('the subject is the key: an email change at the provider keeps the same account', async () => {
    await signIn();
    const before = await db.user.findUniqueOrThrow({ where: { email: ALICE.email } });
    const { done } = await signIn({ email: `alice.new@${DOMAIN}` });
    expect(done?.kind).toBe('session');
    expect(await db.user.count()).toBe(1);
    expect((await db.session.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).userId).toBe(before.id);
  });

  it('a recycled address (same email, new subject at the same issuer) does not take over the account', async () => {
    await signIn();
    const before = await counts();
    expect((await signIn({ sub: 'sub-someone-else' })).done).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it('/login routes a verified, enabled domain to its org, and nothing else', async () => {
    expect(await resolveSso(`bob@${DOMAIN}`)).toBe(org.slug);
    expect(await resolveSso('bob@elsewhere.example')).toBeNull();
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { enabledAt: null } });
    expect(await resolveSso(`bob@${DOMAIN}`)).toBeNull();
  });

  it('with SSO_ENABLED unset, /login never routes and the flow is a 404', async () => {
    env.SSO_ENABLED = undefined;
    try {
      expect(await resolveSso(`bob@${DOMAIN}`)).toBeNull();
      expect(await startSso(org.slug, { ip: randomUUID() })).toBeNull();
    } finally {
      env.SSO_ENABLED = '1';
    }
  });
});

describe('INV-35: no join outside the org’s verified domains', () => {
  it.each([
    ['another domain', { email: 'alice@other.example' }],
    ['an unverified email', { email_verified: false }],
  ])('%s → 404, and no User, Membership or Session row', async (_, user) => {
    const before = await counts();
    expect((await signIn(user)).done).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it('a domain the org added but never verified does not match', async () => {
    await db.ssoDomain.updateMany({ where: { orgId: org.id }, data: { verifiedAt: null } });
    const before = await counts();
    expect((await signIn()).done).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it('a shared issuer (Google) needs hd to match the email domain: missing or mismatched → 404', async () => {
    sharedIssuers.add(mock.issuer);
    try {
      expect((await signIn({ hd: undefined })).done).toBeNull();
      expect((await signIn({ hd: 'other.example' })).done).toBeNull();
      expect(await db.user.count()).toBe(0);
      expect((await signIn({ hd: DOMAIN })).done?.kind).toBe('session');
    } finally {
      sharedIssuers.delete(mock.issuer);
    }
  });

  it('invite-only (no allowedDomains): no membership without a pending invite; with one, a session and no auto-join', async () => {
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { allowedDomains: [] } });
    expect((await signIn()).done).toBeNull();
    expect(await counts()).toEqual({ users: 0, members: 0, sessions: 0, subjects: 0 });

    await db.invite.create({ data: { orgId: org.id, email: ALICE.email, tokenHash: hashToken(newToken()), expiresAt: new Date(now().getTime() + 86_400_000) } });
    expect((await signIn()).done?.kind).toBe('session');
    expect(await db.membership.count()).toBe(0); // accepted on /onboarding, like any invite
  });

  it('a demo user is never an SSO user', async () => {
    await db.user.create({ data: { email: ALICE.email, isDemo: true } });
    expect((await signIn()).done).toBeNull();
    expect(await db.session.count()).toBe(0);
  });

  it('verifying a domain needs the TXT record, and only one org may hold it verified', async () => {
    const other = await makeOrg('sso-b');
    const owner = await addMember(other.id, 'owner', 'owner@b.example');
    const ctx = await actAs(owner.id, other.slug);
    await addDomain(ctx, DOMAIN);
    const d = await db.ssoDomain.findFirstOrThrow({ where: { orgId: other.id } });
    const real = dns.resolveTxt;
    try {
      dns.resolveTxt = async () => [['unrelated']];
      await expect(verifyDomain(ctx, d.id)).rejects.toBeInstanceOf(Refused);
      dns.resolveTxt = async () => [[txtValue(other.id, DOMAIN)]];
      await expect(verifyDomain(ctx, d.id)).rejects.toThrow(/Another org/); // org A holds it
      await db.ssoDomain.deleteMany({ where: { orgId: org.id } });
      await verifyDomain(ctx, d.id);
      expect((await db.ssoDomain.findUniqueOrThrow({ where: { id: d.id } })).verifiedAt).not.toBeNull();
    } finally {
      dns.resolveTxt = real;
    }
  });
});

describe('INV-36: Require SSO refuses magic links; the enabling owner is exempt for 24 h', () => {
  it('both sign-in routes load the module hooks (else the rule silently does nothing)', () => {
    for (const f of ['src/app/(public)/login/request/route.ts', 'src/app/(public)/login/redeem/route.ts']) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/^import '@\/app\/modules';/m);
    }
  });

  const linkCount = (email: string) => db.loginToken.count({ where: { email } });

  // v1.6.5 (A-06, owner decision 2026-11-17): the link is refused to members on the org's verified domain. These tests
  // used off-domain addresses because the rule was per user; the off-domain case now has its own tests below.
  it('a member gets no link, and an older link stops working', async () => {
    const member = await addMember(org.id, 'member', `member@${DOMAIN}`);
    const old = newToken();
    await db.loginToken.create({ data: { hash: hashToken(old), purpose: 'login', email: member.email, userId: member.id, createdAt: now(), expiresAt: new Date(now().getTime() + 900_000) } });
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), requiredById: null } });

    await requestLink(member.email, randomUUID());
    expect(await linkCount(member.email)).toBe(1); // only the old one
    expect(await redeemLink(old)).toBeNull();
  });

  it('the owner who turned it on keeps links for 24 h, then not', async () => {
    const owner = await addMember(org.id, 'owner', `owner@${DOMAIN}`);
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), requiredById: owner.id } });
    await requestLink(owner.email, randomUUID());
    expect(await linkCount(owner.email)).toBe(1);

    advanceClock(24 * 3600_000 + 60_000);
    await db.rateLimit.deleteMany();
    await requestLink(owner.email, randomUUID());
    expect(await linkCount(owner.email)).toBe(1); // no second link
    const t = newToken();
    await db.loginToken.create({ data: { hash: hashToken(t), purpose: 'login', email: owner.email, userId: owner.id, createdAt: now(), expiresAt: new Date(now().getTime() + 900_000) } });
    expect(await redeemLink(t)).toBeNull();
  });

  it('turning the connection off lifts it (no lock-out by a broken provider)', async () => {
    const member = await addMember(org.id, 'member', `member@${DOMAIN}`);
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), enabledAt: null } });
    await requestLink(member.email, randomUUID());
    expect(await linkCount(member.email)).toBe(1);
  });
});

describe('INV-37: state is single-use, hashed and expires', () => {
  it('a replayed state (and code) is a 404', async () => {
    const { params, state, done } = await signIn();
    expect(done?.kind).toBe('session');
    jar.set(SSO_STATE_COOKIE, state);
    expect(await finishSso(params)).toBeNull();
  });

  it('the stored row holds only the hash of the state value', async () => {
    await startSso(org.slug, { ip: randomUUID() });
    const raw = jar.get(SSO_STATE_COOKIE)!;
    const rows = await db.$queryRaw<{ j: string }[]>`SELECT row_to_json(s)::text AS j FROM "SsoState" s`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.j).not.toContain(raw);
    expect(rows[0]!.j).toContain(hashToken(raw));
  });

  it('after 10 minutes the state is dead', async () => {
    const url = await startSso(org.slug, { ip: randomUUID() });
    const params = new URL((await fetch(url!, { redirect: 'manual' })).headers.get('location')!).searchParams;
    advanceClock(10 * 60_000 + 1000);
    expect(await finishSso(params)).toBeNull();
    expect(await db.session.count()).toBe(0);
  });

  it('a callback in a browser that did not start the flow (no state cookie) is a 404', async () => {
    const url = await startSso(org.slug, { ip: randomUUID() });
    const params = new URL((await fetch(url!, { redirect: 'manual' })).headers.get('location')!).searchParams;
    jar.clear();
    expect(await finishSso(params)).toBeNull();
  });

  it.each(['nonce', 'aud', 'signature'] as const)('an ID token with a bad %s is a 404', async (tamper) => {
    mock.tamper = tamper;
    expect((await signIn()).done).toBeNull();
    expect(await db.user.count()).toBe(0);
  });
});

describe('INV-38: SSO cannot create or elevate an owner', () => {
  it('defaultRole = owner is refused at save', async () => {
    const owner = await addMember(org.id, 'owner', 'owner@elsewhere.example');
    const ctx = await actAs(owner.id, org.slug);
    const input = { issuer: mock.issuer, clientId: 'x', clientSecret: 'y', allowedDomains: DOMAIN, defaultRole: 'owner' as const };
    await expect(saveConnection(ctx, input)).rejects.toThrow(/owner/);
    expect((await db.ssoConnection.findUniqueOrThrow({ where: { orgId: org.id } })).defaultRole).toBe('member');
  });

  it('a row set to owner by hand fails closed: no user, no membership', async () => {
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { defaultRole: 'owner' } });
    expect((await signIn()).done).toBeNull();
    expect(await counts()).toEqual({ users: 0, members: 0, sessions: 0, subjects: 0 });
  });

  it('an admin or member signing in keeps their role; SSO never changes an existing membership', async () => {
    const u = await makeUser(ALICE.email);
    await db.membership.create({ data: { orgId: org.id, userId: u.id, role: 'admin' } });
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { defaultRole: 'member' } });
    expect((await signIn()).done?.kind).toBe('session');
    expect((await db.membership.findUniqueOrThrow({ where: { orgId_userId: { orgId: org.id, userId: u.id } } })).role).toBe('admin');
  });
});

describe('INV-22 with SSO (§10.2): provider MFA counts only when amr has mfa, and only in that org', () => {
  async function adminSignsIn(amr?: string[]) {
    const u = await makeUser(ALICE.email);
    await db.membership.create({ data: { orgId: org.id, userId: u.id, role: 'admin' } });
    const b = await makeOrg('other-org');
    await db.membership.create({ data: { orgId: b.id, userId: u.id, role: 'admin' } });
    const { done } = await signIn({ amr });
    jar.clear();
    jar.set(SESSION_COOKIE, (done as { token: string }).token);
    return b;
  }
  const outcome = (slug: string) => requireOrg(slug).then(() => 'ok', (e) => (e instanceof NavSignal ? e.to : String(e)));

  it('amr with mfa: an unenrolled admin is through in that org, and still sent to enrol in another', async () => {
    const b = await adminSignsIn(['pwd', 'mfa']);
    expect(await outcome(org.slug)).toBe('ok');
    expect(await outcome(b.slug)).toBe('/account/security?mfa=required');
  });

  it('no mfa in amr: the admin is sent to enrol TOTP', async () => {
    await adminSignsIn(['pwd']);
    expect(await outcome(org.slug)).toBe('/account/security?mfa=required');
  });

  it('a TOTP-enrolled user still does their own TOTP step after SSO, whatever amr says', async () => {
    const u = await makeUser(ALICE.email);
    await db.user.update({ where: { id: u.id }, data: { totpEnrolledAt: now() } });
    await db.membership.create({ data: { orgId: org.id, userId: u.id, role: 'admin' } });
    const { done } = await signIn({ amr: ['mfa'] });
    expect((await db.session.findUniqueOrThrow({ where: { hash: hashToken((done as { token: string }).token) } })).mfaAt).toBeNull();
  });
});

// v1.6.4 (audit 2026-11-17, A-02, A-05, A-07; moved from tests/defects when fixed).
describe('SSO v1.6.4: the issuer is a public address, and Require SSO ends link sessions', () => {
  // the file's beforeEach has reset the tables and connected `org` to the mock (enabled, domain verified)

  it.each(['https://169.254.169.254/', 'https://10.0.0.5/realms/x', 'https://[::1]/', 'https://localhost/', 'https://[::ffff:a9fe:a9fe]/'])(
    'A-02 an issuer at %s is refused at save, and nothing is saved',
    async (issuer) => {
      const o = await makeOrg('acme');
      const owner = await actAs((await addMember(o.id, 'owner', 'owner@acme.test')).id, o.slug);
      await expect(saveConnection(owner, { issuer, clientId: 'c', clientSecret: 's', allowedDomains: '', defaultRole: 'member' })).rejects.toThrow(/private address/);
      expect(await db.ssoConnection.count({ where: { orgId: o.id } })).toBe(0); // `org` from beforeEach has its own
    },
  );

  it('A-02 an issuer NAME that resolves to a private address is refused too', async () => {
    const real = resolver.lookup;
    resolver.lookup = async () => [{ address: '10.0.0.5', family: 4 }];
    try {
      const o = await makeOrg('acme');
      const owner = await actAs((await addMember(o.id, 'owner', 'owner@acme.test')).id, o.slug);
      await expect(saveConnection(owner, { issuer: 'https://idp.internal.example', clientId: 'c', clientSecret: 's', allowedDomains: '', defaultRole: 'member' })).rejects.toThrow(/private address/);
    } finally {
      resolver.lookup = real;
    }
  });

  it("A-05 turning Require SSO on ends other members' link sessions, keeps their SSO sessions and the owner's own", async () => {
    const owner = await addMember(org.id, 'owner', `owner@${DOMAIN}`);
    const linkMember = await addMember(org.id, 'member', `mel@${DOMAIN}`);
    const ssoMember = await addMember(org.id, 'member', `sam@${DOMAIN}`);
    const linkToken = await signInAs(linkMember.id, { mfa: true });
    await signInAs(ssoMember.id, { mfa: true });
    await db.session.updateMany({ where: { userId: ssoMember.id }, data: { method: 'sso' } });
    const ownerCtx = await viaSso(owner.id);
    const ownerSessions = await db.session.count({ where: { userId: owner.id } });

    jar.clear();
    jar.set(SESSION_COOKIE, linkToken);
    expect(await requireOrg(org.slug).then(() => 'admitted'), 'before the switch').toBe('admitted');

    await setRequired(ownerCtx, true);

    expect(await db.session.count({ where: { userId: linkMember.id } }), 'the link session').toBe(0);
    expect(await db.session.count({ where: { userId: ssoMember.id } }), 'the SSO session').toBe(1);
    expect(await db.session.count({ where: { userId: owner.id } }), "the acting owner's").toBe(ownerSessions);
    jar.clear();
    jar.set(SESSION_COOKIE, linkToken);
    await expect(requireOrg(org.slug)).rejects.toBeInstanceOf(NavSignal);
  });

  it('A-07 a sign-up link issued before the account existed does not sign in a member of an SSO-required org', async () => {
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), requiredById: null } });
    const email = `newhire@${DOMAIN}`; // on the org's domain: an off-domain one now gets its link (A-06) and is stopped at the guard
    await requestLink(email, randomUUID()); // unknown address: a 15-minute sign-up token with userId = null
    const row = await db.loginToken.findFirstOrThrow({ where: { email } });
    expect(row.purpose).toBe('signup');
    await addMember(org.id, 'member', email); // inside those 15 minutes the account appears and joins the org
    const token = newToken(); // the emailed token is unknown here (only its hash is stored), so plant one of the same shape
    await db.loginToken.create({ data: { ...row, hash: hashToken(token) } });
    expect(await redeemLink(token)).toBeNull();
    expect(await db.session.count()).toBe(0);
  });
});

// v1.6.5 (audit A-05 guard half, A-06, A-10; owner decisions 2026-11-17; A-06's tests moved from tests/defects).
/** Signs `userId` in as if through this org's provider: an 'sso' session and a subject row for the mock's issuer. */
async function viaSso(userId: string) {
  await db.ssoSubject.create({ data: { issuer: mock.issuer, subject: `sub-${userId}`, userId } });
  const token = await createSession(userId, { mfa: true, method: 'sso' });
  jar.clear();
  jar.set(SESSION_COOKIE, token);
  return requireOrg(org.slug);
}

describe('Require SSO v1.6.5: per org, by domain, enforced at the guard', () => {
  it('A-06 an off-domain member still gets links, so they can reach their OWN org', async () => {
    const contractor = await addMember(org.id, 'member', 'pat@freelance.example');
    const own = await makeOrg('pats-studio');
    await db.membership.create({ data: { orgId: own.id, userId: contractor.id, role: 'owner' } });
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), requiredById: null } });
    await requestLink(contractor.email, randomUUID());
    expect(await db.loginToken.count({ where: { email: contractor.email } })).toBe(1);
  });

  it('A-05/A-06 the SSO-required org admits only an SSO session; the same link session still opens the member\'s own org', async () => {
    const contractor = await addMember(org.id, 'member', 'pat@freelance.example');
    const own = await makeOrg('pats-studio');
    await db.membership.create({ data: { orgId: own.id, userId: contractor.id, role: 'member' } });
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), requiredById: null } });
    await signInAs(contractor.id, { mfa: true });
    await expect(requireOrg(org.slug)).rejects.toMatchObject({ kind: 'redirect', to: `/login/sso/start?org=${org.slug}` });
    await expect(requireOrg(own.slug)).resolves.toMatchObject({ orgId: own.id });
    await db.session.updateMany({ where: { userId: contractor.id }, data: { method: 'sso' } });
    await expect(requireOrg(org.slug)).resolves.toMatchObject({ orgId: org.id });
  });

  it('A-06 Require SSO cannot be turned on by an owner who has not signed in through this connection', async () => {
    const owner = await addMember(org.id, 'owner', 'owner@acme.test'); // off-domain: the provider could never sign them in
    await expect(setRequired(await actAs(owner.id, org.slug), true)).rejects.toThrow(/Sign in through this SSO connection first/);
    expect((await db.ssoConnection.findUniqueOrThrow({ where: { orgId: org.id } })).required).toBe(false);
    // signed in through it: allowed, and the org can never be left with no owner able to get in
    await setRequired(await viaSso(owner.id), true);
    expect((await db.ssoConnection.findUniqueOrThrow({ where: { orgId: org.id } })).required).toBe(true);
  });

  it('A-06 an sso session from a different issuer does not count for this connection', async () => {
    const owner = await addMember(org.id, 'owner', `boss@${DOMAIN}`);
    await db.ssoSubject.create({ data: { issuer: 'https://other-idp.example', subject: 'x', userId: owner.id } });
    const token = await createSession(owner.id, { mfa: true, method: 'sso' });
    jar.clear();
    jar.set(SESSION_COOKIE, token);
    await expect(setRequired(await requireOrg(org.slug), true)).rejects.toThrow(/Sign in through this SSO connection first/);
  });

  it('v1.6.6 a /demo session is not refused by Require SSO (shared demo accounts are never on a provider)', async () => {
    const demo = await addMember(org.id, 'member', 'member@acme.demo.test');
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), requiredById: null } });
    const token = await createSession(demo.id, { mfa: true, method: 'demo' });
    jar.clear();
    jar.set(SESSION_COOKIE, token);
    await expect(requireOrg(org.slug)).resolves.toMatchObject({ orgId: org.id });
    await signInAs(demo.id, { mfa: true }); // the same account on a link session is still sent to SSO
    await expect(requireOrg(org.slug)).rejects.toMatchObject({ kind: 'redirect' });
  });

  it('the owner who turned it on keeps a link session for 24 h, then is sent to SSO', async () => {
    const owner = await addMember(org.id, 'owner', `owner@${DOMAIN}`);
    await db.ssoConnection.update({ where: { orgId: org.id }, data: { required: true, requiredAt: now(), requiredById: owner.id } });
    await signInAs(owner.id, { mfa: true });
    await expect(requireOrg(org.slug)).resolves.toMatchObject({ orgId: org.id });
    advanceClock(24 * 3600_000 + 60_000);
    await signInAs(owner.id, { mfa: true });
    await expect(requireOrg(org.slug)).rejects.toMatchObject({ kind: 'redirect' });
  });
});
