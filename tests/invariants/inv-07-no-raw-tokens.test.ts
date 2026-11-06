import { beforeEach, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { requestLink } from '@/core/auth/link';
import { createInvite } from '@/core/tenancy/invites';
import { createShareLink } from '@/core/share/links';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { enrol, makeUser, resetAuthTables, signInAs } from '../helpers/auth';

beforeEach(resetAuthTables);

// Complete as of M4: login token, session, recovery code, invite, share link.
describe('INV-07 no raw token is stored', () => {
  it('login token, session and recovery codes are stored only hashed', async () => {
    const u = await makeUser();
    const session = await signInAs(u.id, { mfa: true });
    const { codes } = await enrol();
    await requestLink('someone-new@example.test', '10.0.0.1');
    const [msg] = await db.capturedMessage.findMany();
    const link = msg!.body.match(/\/login\/([\w-]+)/)![1]!;

    const dump = JSON.stringify([
      await db.loginToken.findMany(),
      await db.session.findMany(),
      await db.recoveryCode.findMany(),
    ]);
    for (const raw of [link, session, ...codes, ...codes.map((c) => c.replace('-', ''))]) {
      expect(dump).not.toContain(raw);
    }
  });
});

describe('INV-07 invites (M3 scope)', () => {
  it('an invite is stored only hashed', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    await createInvite(await actAs(owner.id, org.slug), 'new@example.test', 'member');
    const [msg] = await db.capturedMessage.findMany({ where: { to: 'new@example.test' } });
    const raw = msg!.body.match(/\/onboarding\/invite\/([\w-]+)/)![1]!;
    expect(JSON.stringify(await db.invite.findMany())).not.toContain(raw);
  });
});

describe('INV-07 share links', () => {
  it('a share link is stored only hashed', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const project = await db.project.create({ data: { orgId: org.id, name: 'p' } });
    const url = await createShareLink(await actAs(owner.id, org.slug), 'project', project.id, 1);
    const raw = url.split('/s/')[1]!;
    expect(raw.length).toBeGreaterThan(30);
    expect(JSON.stringify(await db.shareLink.findMany())).not.toContain(raw);
  });
});
