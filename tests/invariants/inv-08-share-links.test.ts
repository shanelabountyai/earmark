import { beforeEach, describe, expect, it } from 'vitest';
import { advanceClock } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { createShareLink, readShare, revokeShareLink } from '@/core/share/links';
import { blankPublicProject, toPublicProject } from '@/core/share/project';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { resetAuthTables } from '../helpers/auth';

beforeEach(resetAuthTables);

const IP = '10.0.3.1';
const tokenOf = (url: string) => url.split('/s/')[1]!;

async function shared(role: 'owner' | 'member' = 'owner') {
  const org = await makeOrg();
  const user = await addMember(org.id, role, `${role}@example.test`);
  const ctx = await actAs(user.id, org.slug);
  const project = await db.project.create({ data: { orgId: org.id, name: 'Launch plan', notes: 'margin is 12%' } });
  const token = tokenOf(await createShareLink(ctx, 'project', project.id, 7));
  const link = await db.shareLink.findFirstOrThrow();
  return { ctx, project, token, link };
}

// Headers are asserted in e2e/headers.spec.ts (they are set by next.config, not by this code).
describe('INV-08 share links', () => {
  it('expiresAt is NOT NULL in the database', async () => {
    const [col] = await db.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns WHERE table_name = 'ShareLink' AND column_name = 'expiresAt'`;
    expect(col!.is_nullable).toBe('NO');
  });

  it('a live link reads the projection, and only the projection', async () => {
    const { token } = await shared();
    expect(await readShare(token, IP)).toEqual({ name: 'Launch plan' });
  });

  it('revoke is immediate: the next read is a 404', async () => {
    const { ctx, token, link } = await shared();
    await revokeShareLink(ctx, link.id);
    expect(await readShare(token, IP)).toBeNull();
  });

  it('an expired link is a 404, the same as an unknown one', async () => {
    const { token } = await shared();
    advanceClock(7 * 86_400_000 + 1);
    expect(await readShare(token, IP)).toBeNull();
    expect(await readShare('not-a-token', IP)).toBeNull();
  });

  it('a link whose resource is gone is a 404', async () => {
    const { token, project } = await shared();
    await db.project.delete({ where: { id: project.id } });
    expect(await readShare(token, IP)).toBeNull();
  });

  it('a member can create a link but not revoke one', async () => {
    const { ctx, token, link } = await shared('member');
    await expect(revokeShareLink(ctx, link.id)).rejects.toThrow('share.revoke');
    expect(await readShare(token, IP)).toEqual({ name: 'Launch plan' });
  });

  it('the projection is an allowlist: a new column stays private', async () => {
    const { project } = await shared();
    const row = { ...project, dummyField: 'leak' } as typeof project;
    expect(Object.keys(toPublicProject(row))).toEqual(Object.keys(blankPublicProject()));
    expect(JSON.stringify(toPublicProject(row))).not.toMatch(/leak|margin/);
  });
});
