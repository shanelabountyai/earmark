// v1.4.0: the clone hook `filterListedOrgs` (clone-owned src/app/org-hooks.ts) decides which of a user's orgs the
// template's org lists show — /onboarding and each account on /demo. Default: all of them, as before. The template
// keeps only ids the user already had (core/tenancy/listed.ts), so a hook can hide an org and never add or rename one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { keepListedOrgs, type ListedOrg, type OrgListFilter } from '@/core/tenancy/listed';
import { resetAuthTables, signInAs } from '../helpers/auth';

vi.hoisted(() => {
  process.env.DEMO_MODE = '1'; // env.ts parses process.env at import; /demo 404s without it
});

// The page under test imports the clone's hook; each test swaps in the clone it wants (default: the real one).
const hook = vi.hoisted(() => ({ filter: null as null | ((userId: string, orgs: readonly { id: string; slug: string; name: string }[]) => unknown) }));
vi.mock('@/app/org-hooks', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/org-hooks')>();
  return { ...real, filterListedOrgs: (userId: string, orgs: readonly ListedOrg[]) => (hook.filter ? hook.filter(userId, orgs) : real.filterListedOrgs(userId, orgs)) };
});

const { default: Onboarding } = await import('@/app/onboarding/page');
const { default: Demo } = await import('@/app/(public)/demo/page');
const html = async (page: () => Promise<ReactElement>) => renderToStaticMarkup(await page());

let ada: { id: string };
let orgs: Record<'live' | 'archived' | 'stranger', { id: string; slug: string; name: string }>;

beforeEach(async () => {
  hook.filter = null;
  await resetAuthTables();
  const mk = (slug: string, name: string) => db.org.create({ data: { slug, name }, select: { id: true, slug: true, name: true } });
  orgs = { live: await mk('live-co', 'Live Co'), archived: await mk('archived-co', 'Archived Co'), stranger: await mk('stranger-co', 'Stranger Co') };
  ada = await db.user.create({ data: { email: 'ada@example.test', isDemo: true } });
  const bob = await db.user.create({ data: { email: 'bob@example.test', isDemo: true } });
  await db.membership.createMany({
    data: [
      { orgId: orgs.live.id, userId: ada.id, role: 'owner' },
      { orgId: orgs.archived.id, userId: ada.id, role: 'member' },
      { orgId: orgs.stranger.id, userId: bob.id, role: 'owner' }, // ada is not in stranger-co
    ],
  });
  await signInAs(ada.id, { mfa: true });
});

const hideArchived = (_: string, list: readonly ListedOrg[]) => list.filter((o) => o.id !== orgs.archived.id);

describe('default hook: every org is listed, as before v1.4.0', () => {
  it('/onboarding lists both of ada’s orgs and nobody else’s', async () => {
    const page = await html(Onboarding);
    expect(page).toContain('href="/o/live-co"');
    expect(page).toContain('href="/o/archived-co"');
    expect(page).not.toContain('stranger-co');
  });

  it('/demo lists both of ada’s orgs', async () => {
    const page = await html(Demo);
    expect(page).toContain('owner of Live Co');
    expect(page).toContain('member of Archived Co');
  });
});

describe('a hook that hides one org', () => {
  beforeEach(() => {
    hook.filter = hideArchived;
  });

  it('hides it on /onboarding and keeps the other', async () => {
    const page = await html(Onboarding);
    expect(page).toContain('href="/o/live-co"');
    expect(page).not.toContain('archived-co');
    expect(page).not.toContain('Archived Co');
  });

  it('hides it on /demo too, and leaves other accounts’ orgs alone', async () => {
    const page = await html(Demo);
    expect(page).toContain('owner of Live Co');
    expect(page).not.toContain('Archived Co');
    expect(page).toContain('owner of Stranger Co');
  });

  it('is asked about the signed-in user and only that user’s orgs on /onboarding', async () => {
    const calls: [string, string[]][] = [];
    hook.filter = (userId, list) => (calls.push([userId, list.map((o) => o.slug)]), list);
    await html(Onboarding);
    expect(calls).toEqual([[ada.id, ['live-co', 'archived-co']]]);
  });

  it('hiding every org shows the empty state', async () => {
    hook.filter = () => [];
    expect(await html(Onboarding)).toContain('You are not in an org yet.');
  });
});

describe('the hook cannot widen what a user sees', () => {
  it('an org id the user is not in, returned by the hook, is not shown on /onboarding', async () => {
    hook.filter = (_, list) => [...list, { id: orgs.stranger.id, slug: orgs.stranger.slug, name: orgs.stranger.name }];
    const page = await html(Onboarding);
    expect(page).not.toContain('stranger-co');
    expect(page).not.toContain('Stranger Co');
    expect(page).toContain('href="/o/live-co"');
    expect(page).toContain('href="/o/archived-co"');
  });

  it('an extra id on /demo is not added to ada’s line', async () => {
    hook.filter = (userId, list) => (userId === ada.id ? [...list, { id: orgs.stranger.id }] : list);
    const page = await html(Demo);
    expect(page).toMatch(/ada@example\.test<\/button> owner of Live Co, member of Archived Co</);
    expect(page.match(/Stranger Co/g)).toHaveLength(1); // bob's line only
  });

  it('a renamed or re-slugged org renders as stored, not as the hook returned it', async () => {
    hook.filter = (_, list) => list.map((o) => ({ ...o, slug: 'elsewhere', name: 'Renamed' }));
    const page = await html(Onboarding);
    expect(page).toContain('href="/o/live-co">Live Co</a>');
    expect(page).not.toContain('elsewhere');
    expect(page).not.toContain('Renamed');
  });

  it('the hook gets frozen copies, so it cannot edit the rows the page renders', async () => {
    hook.filter = (_, list) => {
      expect(Object.isFrozen(list)).toBe(true);
      expect(() => ((list[0] as { name: string }).name = 'Mutated')).toThrow(TypeError);
      return list;
    };
    const page = await html(Onboarding);
    expect(page).toContain('Live Co');
    expect(page).not.toContain('Mutated');
  });
});

describe('keepListedOrgs', () => {
  const items = [
    { role: 'owner', org: { id: 'a', slug: 'a', name: 'A' } },
    { role: 'member', org: { id: 'b', slug: 'b', name: 'B' } },
    { role: 'admin', org: { id: 'c', slug: 'c', name: 'C' } },
  ];

  it('keeps input order and the input objects, whatever order or duplicates the filter returns', async () => {
    const reorder: OrgListFilter = () => [{ id: 'c' }, { id: 'a' }, { id: 'c' }, { id: 'zz' }];
    const kept = await keepListedOrgs('u', items, reorder);
    expect(kept.map((i) => i.org.id)).toEqual(['a', 'c']);
    expect(kept[0]).toBe(items[0]);
  });

  it('does not call the filter for an empty list', async () => {
    const filter = vi.fn<OrgListFilter>(() => []);
    expect(await keepListedOrgs('u', [], filter)).toEqual([]);
    expect(filter).not.toHaveBeenCalled();
  });
});
