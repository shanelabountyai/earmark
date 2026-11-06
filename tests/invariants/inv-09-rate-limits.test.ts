import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { requestLink } from '@/core/auth/link';
import { LIMITS } from '@/core/rate-limit';
import { verifyTotp } from '@/core/auth/totp';
import { currentSession } from '@/core/auth/session';
import { acceptInvite, createInvite } from '@/core/tenancy/invites';
import { createShareLink, readShare } from '@/core/share/links';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { advanceClock } from '@/core/clock';
import { codeFor, enrol, makeUser, resetAuthTables, signInAs } from '../helpers/auth';

beforeEach(resetAuthTables);

const sent = () => db.loginToken.count();

/** Pins the clock 1s into a fresh 15-minute window (a multiple of every limit's window), plus `ms`. */
const base = Math.ceil(Date.now() / 900_000) * 900_000 + 1000 - Date.now();
const at = (ms = 0) => advanceClock(base + ms);
beforeEach(() => at());

// Scope through M4: link requests (per IP and per email), TOTP attempts, invite accepts, share reads.
// Public forms join when a clone adds one.
describe('INV-09 Postgres rate limits', () => {
  it('link requests: the per-IP limit refuses request N+1', async () => {
    const n = LIMITS.linkPerIp.limit;
    for (let i = 0; i < n; i++) await requestLink(`u${i}@example.test`, '10.0.0.9');
    expect(await sent()).toBe(n);
    await requestLink('one-more@example.test', '10.0.0.9');
    expect(await sent()).toBe(n);
    await requestLink('one-more@example.test', '10.0.0.10'); // another IP still gets through
    expect(await sent()).toBe(n + 1);
  });

  it('link requests: the per-email limit refuses request N+1 across IPs, and survives a fresh module', async () => {
    const n = LIMITS.linkPerEmail.limit;
    for (let i = 0; i < n; i++) {
      await requestLink('ada@example.test', `10.0.1.${i}`);
      at((i + 1) * 61_000); // past the 60-second cooldown, inside the window
    }
    expect(await sent()).toBe(n);
    // A fresh module instance (a new serverless instance) still sees the count. Its clock is
    // fresh too, so pin it to the same moment: past the cooldown, inside the window.
    vi.resetModules();
    (await import('@/core/clock')).advanceClock(base + (n + 1) * 61_000);
    const fresh = await import('@/core/auth/link');
    await fresh.requestLink('ada@example.test', '10.0.2.1');
    expect(await sent()).toBe(n);
  });

  it('TOTP attempts: the per-user limit refuses attempt N+1 even with the right code', async () => {
    const u = await makeUser();
    await signInAs(u.id, { mfa: true });
    const { secret } = await enrol();
    await signInAs(u.id); // a new sign-in, MFA pending
    for (let i = 0; i < LIMITS.mfaPerUser.limit; i++) expect(await verifyTotp('000000')).toBe(false);
    at(30_000); // a new step, so replay is not what refuses it
    expect(await verifyTotp(codeFor(secret))).toBe(false);
  });

  it('invite sends: per-recipient, per-sender and per-org daily caps refuse the next one (FR-03)', async () => {
    const mail = (to?: string) => db.capturedMessage.count({ where: to ? { to } : { subject: { startsWith: 'You are invited' } } });
    const org = await makeOrg();
    const a = await actAs((await addMember(org.id, 'owner', 'a@example.test')).id, org.slug);
    const b = await actAs((await addMember(org.id, 'admin', 'b@example.test')).id, org.slug);
    const c = await actAs((await addMember(org.id, 'admin', 'c@example.test')).id, org.slug);
    // One recipient, from two orgs: the cap follows the address, not the org.
    const other = await makeOrg('other');
    const d = await actAs((await addMember(other.id, 'owner', 'd@example.test')).id, other.slug);
    for (let i = 0; i < LIMITS.invitePerEmailDay.limit; i++) await createInvite(i % 2 ? d : a, 'target@example.test', 'member');
    await expect(createInvite(d, 'target@example.test', 'member')).rejects.toThrow('Too many');
    expect(await mail('target@example.test')).toBe(LIMITS.invitePerEmailDay.limit);

    const sendMany = async (ctx: typeof a, tag: string, n: number) => {
      for (let i = 0; i < n; i++) await createInvite(ctx, `${tag}${i}@example.test`, 'member');
    };
    await sendMany(b, 'b', LIMITS.invitePerUserDay.limit);
    await expect(createInvite(b, 'b-extra@example.test', 'member')).rejects.toThrow('Too many');
    await sendMany(c, 'c', LIMITS.invitePerOrgDay.limit - LIMITS.invitePerUserDay.limit - 3); // a sent 3 above
    await expect(createInvite(c, 'c-extra@example.test', 'member')).rejects.toThrow('Too many');
    expect(await mail()).toBe(LIMITS.invitePerOrgDay.limit + 2); // d's 2 went from the other org
  });

  it('invite accepts: the per-user limit refuses attempt N+1 even with the right token', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    await createInvite(await actAs(owner.id, org.slug), 'ada@example.test', 'member');
    const token = (await db.capturedMessage.findFirstOrThrow({ where: { to: 'ada@example.test' } })).body.match(/invite\/([\w-]+)/)![1]!;
    await signInAs((await makeUser('ada@example.test')).id);
    const s = (await currentSession())!;
    for (let i = 0; i < LIMITS.inviteAcceptPerUser.limit; i++) await expect(acceptInvite(s, 'guess')).rejects.toThrow('not valid');
    await expect(acceptInvite(s, token)).rejects.toThrow('Too many');
    expect(await db.membership.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('share reads: the per-IP limit refuses read N+1 even with a live token', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const project = await db.project.create({ data: { orgId: org.id, name: 'p' } });
    const token = (await createShareLink(await actAs(owner.id, org.slug), 'project', project.id, 1)).split('/s/')[1]!;
    for (let i = 0; i < LIMITS.shareReadPerIp.limit; i++) expect(await readShare('guess', '10.0.4.1')).toBeNull();
    expect(await readShare(token, '10.0.4.1')).toBe('limited');
    expect(await readShare(token, '10.0.4.2')).toEqual({ name: 'p' }); // another IP still reads
  });
});
