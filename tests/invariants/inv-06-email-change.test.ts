import { beforeEach, describe, expect, it } from 'vitest';
import { confirmEmailChange, requestEmailChange } from '@/core/auth/link';
import { currentSession, sessionFor } from '@/core/auth/session';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { createInvite } from '@/core/tenancy/invites';
import { makeUser, resetAuthTables, signInAs } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

beforeEach(resetAuthTables);

const linkTo = async (to: string) =>
  (await db.capturedMessage.findFirstOrThrow({ where: { to }, orderBy: { createdAt: 'desc' } })).body.match(/\/account\/email\/([\w-]+)/)![1]!;

describe('INV-06 changing an email', () => {
  it('through confirmEmailChange: swaps the email, ends other sessions, revokes invites to the old address', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    await createInvite(await actAs(owner.id, org.slug), 'ada@example.test', 'member');

    const ada = await makeUser('ada@example.test');
    const elsewhere = await signInAs(ada.id);
    const here = await signInAs(ada.id);
    await requestEmailChange((await currentSession())!, 'ada@new.example.test');
    expect(await confirmEmailChange((await currentSession())!, await linkTo('ada@new.example.test'))).toBe(true);

    expect((await db.user.findUniqueOrThrow({ where: { id: ada.id } })).email).toBe('ada@new.example.test');
    expect(await sessionFor(elsewhere)).toBeNull();
    expect(await sessionFor(here)).not.toBeNull();
    expect(await db.invite.count({ where: { email: 'ada@example.test', revokedAt: null } })).toBe(0);
    expect(await db.capturedMessage.count({ where: { to: 'ada@example.test', subject: 'Your email address was changed' } })).toBe(1);
  });

  it('the link works once, and only for the user who asked', async () => {
    const ada = await makeUser('ada@example.test');
    await signInAs(ada.id);
    await requestEmailChange((await currentSession())!, 'ada@new.example.test');
    const token = await linkTo('ada@new.example.test');

    await signInAs((await makeUser('eve@example.test')).id);
    expect(await confirmEmailChange((await currentSession())!, token)).toBe(false);

    await signInAs(ada.id);
    expect(await confirmEmailChange((await currentSession())!, token)).toBe(true);
    expect(await confirmEmailChange((await currentSession())!, token)).toBe(false);
  });

  it('an address that belongs to another user gets no confirm link, and no different answer (D-10)', async () => {
    await makeUser('taken@example.test');
    await signInAs((await makeUser('ada@example.test')).id);
    await expect(requestEmailChange((await currentSession())!, 'Taken@Example.test')).resolves.toBeUndefined();
    expect(await db.loginToken.count({ where: { purpose: 'email_change' } })).toBe(0);
    expect(await db.capturedMessage.count({ where: { to: 'taken@example.test' } })).toBe(0);
  });
});
