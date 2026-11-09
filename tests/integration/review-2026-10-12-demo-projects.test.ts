// 2026-10-12 review, demo finding (owner decision 2026-10-13): a demo session can still add a project and share it.
// Split out of review-2026-10-12-demo.test.ts because it exercises the example resource (`/o/[org]/projects`, D-16),
// which a clone replaces: a clone that removes the projects pages deletes this file with them.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// env.ts parses process.env at import; this file runs with the flag on, as a demo deployment does.
vi.hoisted(() => { process.env.DEMO_MODE = '1'; });

import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { demoSignIn } from '@/core/auth/demo';
import { SESSION_COOKIE } from '@/core/auth/session';
import { seedDemo } from '../../scripts/seed-demo';
import { resetAuthTables } from '../helpers/auth';
import { jar } from '../helpers/next';

beforeEach(resetAuthTables);

describe('a demo session can still use the example resource', () => {
  it('adding a project and sharing it work', async () => {
    await seedDemo();
    const { user: owner, org } = await db.membership.findFirstOrThrow({ where: { role: 'owner', user: { isDemo: true } }, orderBy: { org: { slug: 'asc' } }, select: { user: true, org: true } });
    jar.set(SESSION_COOKIE, (await demoSignIn(owner.id))!);

    const { addProject, shareProject } = await import('@/app/o/[org]/projects/actions');
    await expect(addProject(org.slug, { name: 'Demo project' })).rejects.toThrow(`redirect /o/${org.slug}/projects`);
    const p = await db.project.findFirstOrThrow({ where: { name: 'Demo project' } });
    expect(await shareProject(org.slug, { id: p.id, days: '7' })).toEqual({ notice: expect.stringContaining('/s/') });
  });
});
