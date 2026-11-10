// Phase 3 item 6, guests' agency (D-29): an invited guest is untied and sees nothing until an admin ties them; agency
// creation normalizes domains and refuses junk; members cannot manage agencies.
import { beforeEach, expect, it } from 'vitest';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { assignGuestAgency, createAgency } from '@/earmark/actions';
import { scopeOf } from '@/earmark/core';
import { resetAuthTables } from '../../helpers/auth';
import { actAs } from '../../helpers/org';
import { as, outcome, world } from './world';

beforeEach(resetAuthTables);

it('an untied guest sees nothing; once tied, they are scoped to that agency', async () => {
  const w = await world('acme');
  const dana = await db.user.create({ data: { email: 'dana@meridian.test' } });
  await db.membership.create({ data: { orgId: w.orgId, userId: dana.id, role: 'guest' } }); // what invite accept leaves
  const scope = async () => {
    const ctx = await actAs(dana.id, w.slug);
    return outcome(withOrg(ctx, (tx) => scopeOf(tx, ctx), { atomic: false }));
  };
  expect(await scope()).toMatch(/notFound|NEXT_HTTP_ERROR|404/i);

  expect(await as(w.requester.id, () => assignGuestAgency(w.slug, { userId: dana.id, agencyId: w.agency.id }))).toEqual({ error: 'You do not have access to that.' });
  expect(await as(w.admin.id, () => assignGuestAgency(w.slug, { userId: dana.id, agencyId: w.agency.id }))).toEqual({ notice: 'Guest tied to the agency.' });
  expect(JSON.parse(await scope())).toEqual({ ok: { agencyId: w.agency.id } });
});

it('createAgency normalizes domains and refuses junk and duplicates', async () => {
  const w = await world('acme');
  expect(await as(w.admin.id, () => createAgency(w.slug, { name: 'Northstar', domains: 'not a domain' }))).toEqual({ error: 'Domains look like meridian.com, separated by commas.' });
  expect(await as(w.admin.id, () => createAgency(w.slug, { name: 'Northstar', domains: '@NorthStar.io, northstar.io  ns.co' }))).toEqual({ notice: 'Northstar added.' });
  expect((await db.agency.findFirstOrThrow({ where: { orgId: w.orgId, name: 'Northstar' } })).domains).toEqual(['northstar.io', 'ns.co']);
  expect(await as(w.admin.id, () => createAgency(w.slug, { name: 'Northstar', domains: '' }))).toEqual({ error: 'Northstar already exists.' });
});
