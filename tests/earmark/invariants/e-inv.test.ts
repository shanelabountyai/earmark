// Earmark's clone invariants, E-INV-01 to 08 (PRD §8). They live here, not in tests/invariants/ (template-owned, so a
// file added there is drift; D-16). They run in the same sweep as the foundation's, under RLS_MODE=enforce: every
// action and read below goes through the app role; only fixture rows are written as the owner.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceeded } from '@/core/ai/budget';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { decideStep, editRules, matchInvoice, offboardAgency, submitInvoice, submitRequest } from '@/earmark/actions';
import { findCommitment, toGuestCommitment } from '@/earmark/core';
import { type Drafter, draftVarianceNote, FEATURE } from '@/earmark/explainer';
import { resetAuthTables, signInAs } from '../../helpers/auth';
import { actAs } from '../../helpers/org';
import { addGuest, as, commitmentFor, outcome, world } from './world';

beforeEach(resetAuthTables);

const request = (w: Awaited<ReturnType<typeof world>>, amount: string) =>
  as(w.requester.id, () => submitRequest(w.slug, { budgetLineId: w.line.id, agencyId: w.agency.id, amount, description: `Request for ${amount}` })) as Promise<{ id: string }>;

describe('E-INV-01: a requester cannot approve their own request through any seat they hold', () => {
  it('the requester holds Budget Owner: approving as self is refused and writes no decision; the other holder can', async () => {
    const w = await world('northwind');
    const { id } = await request(w, '7,500.00');
    const [step] = await db.approvalStep.findMany({ where: { requestId: id } });
    expect(step).toMatchObject({ seat: 'Budget Owner', approverIds: [w.budgetOwner.id] }); // dropped at evaluation

    expect(await as(w.requester.id, () => decideStep(w.slug, { requestId: id, decision: 'approve' }))).toEqual({ error: 'You cannot approve your own request.' });
    expect(await db.approvalStep.findUniqueOrThrow({ where: { id: step!.id } })).toMatchObject({ decision: null, decidedById: null });
    expect(await db.spendRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'submitted' });
    expect(await db.commitment.count()).toBe(0);

    expect(await as(w.budgetOwner.id, () => decideStep(w.slug, { requestId: id, decision: 'approve' }))).toEqual({ state: 'approved' });
  });

  it('when the requester is the only holder of a step, the request cannot be submitted at all', async () => {
    const w = await world('northwind');
    await db.seatHolder.deleteMany({ where: { userId: w.budgetOwner.id } });
    const r = await as(w.requester.id, () => submitRequest(w.slug, { budgetLineId: w.line.id, agencyId: w.agency.id, amount: '7,500.00', description: 'x' }));
    expect(r).toMatchObject({ error: expect.stringMatching(/./) });
    expect(await db.spendRequest.count()).toBe(0);
  });
});

describe('E-INV-02: a commitment exists only for an approved request, for no more than the request', () => {
  it('the database refuses a commitment for a request that is not approved, even from the owner role', async () => {
    const w = await world('northwind');
    const { id } = await request(w, '7,500.00');
    const insert = (amountCents: bigint) => db.commitment.create({ data: { orgId: w.orgId, requestId: id, agencyId: w.agency.id, poNumber: 'PO-DIRECT', amountCents, remainingCents: amountCents } });
    await expect(insert(750_000n)).rejects.toThrow(/E-INV-02: a commitment needs an approved request/);
    await expect(withOrg({ orgId: w.orgId }, (tx) => tx.commitment.create({ data: { orgId: w.orgId, requestId: id, agencyId: w.agency.id, poNumber: 'PO-APP', amountCents: 1n, remainingCents: 1n } }))).rejects.toThrow(/E-INV-02/);
    await db.spendRequest.update({ where: { id }, data: { state: 'approved' } });
    await expect(insert(750_001n)).rejects.toThrow(/E-INV-02: a commitment cannot exceed its request/);
    expect(await db.commitment.count()).toBe(0);
  });

  it('the last approval issues exactly one commitment for the request amount, in the same transaction', async () => {
    const w = await world('northwind');
    const { id } = await request(w, '25,000.00'); // Budget Owner, then Marketing Ops ($10k+)
    expect(await as(w.budgetOwner.id, () => decideStep(w.slug, { requestId: id, decision: 'approve' }))).toEqual({ state: 'pending' });
    expect(await db.commitment.count()).toBe(0);
    expect(await as(w.ops.id, () => decideStep(w.slug, { requestId: id, decision: 'approve' }))).toEqual({ state: 'approved' });
    const cs = await db.commitment.findMany();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ requestId: id, amountCents: 2_500_000n, remainingCents: 2_500_000n, agencyId: w.agency.id });
  });

  it('if the commitment cannot be written, the approval is not written either', async () => {
    const w = await world('northwind');
    const { id } = await request(w, '7,500.00');
    await commitmentFor(w, w.agency.id, 100n, `PO-${id.slice(0, 8).toUpperCase()}`); // takes the PO number the approval will use
    await expect(as(w.budgetOwner.id, () => decideStep(w.slug, { requestId: id, decision: 'approve' }))).rejects.toThrow();
    expect(await db.spendRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'submitted' });
    expect(await db.approvalStep.findFirstOrThrow({ where: { requestId: id } })).toMatchObject({ decision: null });
    expect(await db.commitment.count({ where: { requestId: id } })).toBe(0);
  });
});

describe('E-INV-03: a guest sees only their agency’s rows inside the client', () => {
  it('another agency’s commitment is the same 404 as a nonexistent id; their own is visible', async () => {
    const w = await world('northwind');
    const other = await db.agency.create({ data: { orgId: w.orgId, name: 'Rival Media', domains: [] } });
    const mine = await commitmentFor(w, w.agency.id, 500_000n, 'PO-MINE');
    const theirs = await commitmentFor(w, other.id, 500_000n, 'PO-THEIRS');
    const dana = await db.user.create({ data: { email: 'dana@meridian.test' } });
    await addGuest(w.orgId, w.agency.id, dana.id);

    const ctx = await actAs(dana.id, w.slug);
    const read = (id: string) => outcome(withOrg(ctx, (tx) => findCommitment(tx, ctx, id)));
    expect(JSON.parse(await read(mine.id)).ok.id).toBe(mine.id);
    const [cross, missing] = [await read(theirs.id), await read(randomUUID())];
    expect(JSON.parse(cross)).toMatchObject({ nav: 'notFound' });
    expect(cross).toBe(missing); // byte-identical

    // The same through an action: an invoice against the other agency is the 404 of an agency that does not exist.
    const inv = (agencyId: string) => outcome(submitInvoice(w.slug, { agencyId, number: 'N-1', amount: '100.00', invoicedOn: '2026-01-10', dueOn: '2026-02-09' }));
    expect(await inv(other.id)).toBe(await inv(randomUUID()));
    expect(await db.invoice.count()).toBe(0);

    // Staff see both: the predicate is the guest's, not the org's.
    const adminCtx = await actAs(w.admin.id, w.slug);
    expect(JSON.parse(await outcome(withOrg(adminCtx, (tx) => findCommitment(tx, adminCtx, theirs.id)))).ok.id).toBe(theirs.id);
  });

  it('a guest with no agency, or whose agency is offboarded, sees nothing (fail closed)', async () => {
    const w = await world('northwind');
    const c = await commitmentFor(w, w.agency.id, 500_000n, 'PO-1');
    const lost = await db.user.create({ data: { email: 'lost@meridian.test' } });
    await db.membership.create({ data: { orgId: w.orgId, userId: lost.id, role: 'guest' } });
    const ctx = await actAs(lost.id, w.slug);
    expect(JSON.parse(await outcome(withOrg(ctx, (tx) => findCommitment(tx, ctx, c.id))))).toMatchObject({ nav: 'notFound' });

    const dana = await db.user.create({ data: { email: 'dana@meridian.test' } });
    await addGuest(w.orgId, w.agency.id, dana.id);
    await db.agency.update({ where: { id: w.agency.id }, data: { offboardedAt: new Date() } });
    const dctx = await actAs(dana.id, w.slug);
    expect(JSON.parse(await outcome(withOrg(dctx, (tx) => findCommitment(tx, dctx, c.id))))).toMatchObject({ nav: 'notFound' });
  });
});

describe('E-INV-04: toGuestCommitment exposes no budget-line fields', () => {
  it('keys are exactly the allowlist, even with extra fields on the row', async () => {
    const w = await world('northwind');
    const c = await commitmentFor(w, w.agency.id, 500_000n, 'PO-1');
    const row = { ...c, requestId: c.requestId, budgetLineId: w.line.id, plannedCents: 100_000_000n, ownerSeat: 'Budget Owner', dummy: 'LEAK' };
    const g = toGuestCommitment(row);
    expect(Object.keys(g).sort()).toEqual(['amountCents', 'closedAt', 'id', 'invoiceDueDates', 'issuedAt', 'matchStatus', 'poNumber', 'remainingCents']);
    const text = JSON.stringify(g);
    for (const leak of ['LEAK', w.line.id, c.requestId, '100000000', 'Budget Owner']) expect(text).not.toContain(leak);
  });
});

describe('E-INV-05: Commitment.remainingCents equals the recomputed value after any sequence of matches', () => {
  it('property: random matches by Finance (with a note) and non-Finance matchers', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ cents: fc.integer({ min: 1, max: 400_000 }), finance: fc.boolean() }), { minLength: 1, maxLength: 6 }), async (seq) => {
        await resetAuthTables();
        const w = await world('acme');
        const c = await commitmentFor(w, w.agency.id, 750_000n, 'PO-1');
        for (const [n, s] of seq.entries()) {
          const inv = await db.invoice.create({ data: { orgId: w.orgId, agencyId: w.agency.id, number: `N-${n}`, amountCents: BigInt(s.cents), invoicedOn: new Date('2026-01-10'), dueOn: new Date('2026-02-09'), submittedById: w.requester.id } });
          const amount = `${Math.floor(s.cents / 100)}.${String(s.cents % 100).padStart(2, '0')}`;
          await as(s.finance ? w.finance.id : w.ops.id, () => matchInvoice(w.slug, { invoiceId: inv.id, commitmentId: c.id, amount, note: s.finance ? 'Approved overage' : '' }));
          const now = await db.commitment.findUniqueOrThrow({ where: { id: c.id }, include: { matches: true } });
          const matched = now.matches.reduce((a, m) => a + m.amountCents, 0n);
          expect(now.remainingCents).toBe(now.amountCents - matched);
          if (now.remainingCents < 0n) expect(now.matches.some((m) => m.overage)).toBe(true); // never below zero without the flag
          if (now.remainingCents <= 0n) expect(now.closedAt).not.toBeNull();
        }
      }),
      { numRuns: 12 },
    );
  }, 120_000);

  it('one invoice matched against two POs at the same moment is never matched for more than it billed', async () => {
    const w = await world('acme');
    const c1 = await commitmentFor(w, w.agency.id, 500_000n, 'PO-1');
    const c2 = await commitmentFor(w, w.agency.id, 500_000n, 'PO-2');
    const inv = await db.invoice.create({ data: { orgId: w.orgId, agencyId: w.agency.id, number: 'N-1', amountCents: 100_000n, invoicedOn: new Date('2026-01-10'), dueOn: new Date('2026-02-09'), submittedById: w.requester.id } });
    await signInAs(w.ops.id, { mfa: true });
    const results = await Promise.all([c1, c2].map((c) => matchInvoice(w.slug, { invoiceId: inv.id, commitmentId: c.id, amount: '1,000.00' })));
    expect(results.filter((r) => r && 'error' in r)).toHaveLength(1);
    const matched = (await db.invoiceMatch.findMany({ where: { invoiceId: inv.id } })).reduce((a, m) => a + m.amountCents, 0n);
    expect(matched).toBe(100_000n);
  });

  it('a non-Finance matcher cannot take a commitment below zero', async () => {
    const w = await world('acme');
    const c = await commitmentFor(w, w.agency.id, 100_000n, 'PO-1');
    const inv = await db.invoice.create({ data: { orgId: w.orgId, agencyId: w.agency.id, number: 'N-1', amountCents: 150_000n, invoicedOn: new Date('2026-01-10'), dueOn: new Date('2026-02-09'), submittedById: w.requester.id } });
    expect(await as(w.ops.id, () => matchInvoice(w.slug, { invoiceId: inv.id, commitmentId: c.id, amount: '1,500.00' }))).toMatchObject({ error: expect.stringMatching(/Finance/) });
    expect(await db.commitment.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ remainingCents: 100_000n, closedAt: null });
    expect(await db.invoiceMatch.count()).toBe(0);
  });
});

describe('E-INV-06: rule edits are audited with before and after; in-flight requests keep their chainSnapshot', () => {
  const RULES = JSON.parse(readFileSync('rules/approval-chains.json', 'utf8')) as { default: { seat: string; fromCents: number }[] };
  const withThreshold = (seat: string, fromCents: number) => JSON.stringify({ ...RULES, default: RULES.default.map((s) => (s.seat === seat ? { ...s, fromCents } : s)) });

  it('Marketing Ops moves to $15,000 mid-request: the first $12,000 request is unchanged, the next stops at Budget Owner', async () => {
    const w = await world('northwind');
    const first = await request(w, '12,000.00');
    const before = await db.spendRequest.findUniqueOrThrow({ where: { id: first.id }, include: { steps: { orderBy: { index: 'asc' } } } });
    expect(before.steps.map((s) => s.seat)).toEqual(['Budget Owner', 'Marketing Ops']);

    expect(await as(w.admin.id, () => editRules(w.slug, { rules: withThreshold('Marketing Ops', 1_500_000) }))).toMatchObject({ changes: 1 });

    const after = await db.spendRequest.findUniqueOrThrow({ where: { id: first.id }, include: { steps: { orderBy: { index: 'asc' } } } });
    expect(after.chainSnapshot).toEqual(before.chainSnapshot);
    expect(after.steps).toEqual(before.steps);

    const [ev] = await db.auditEvent.findMany({ where: { orgId: w.orgId, action: 'rules.edited' } });
    const data = ev!.data as { audit: { before: typeof RULES; after: typeof RULES }; changes: { seat: string; before: number; after: number }[] };
    expect(data.audit.before.default.find((s) => s.seat === 'Marketing Ops')!.fromCents).toBe(1_000_000);
    expect(data.audit.after.default.find((s) => s.seat === 'Marketing Ops')!.fromCents).toBe(1_500_000);
    expect(data.changes).toEqual([expect.objectContaining({ seat: 'Marketing Ops', before: 1_000_000, after: 1_500_000 })]);
    expect(ev!.actorUserId).toBe(w.admin.id);

    const second = await request(w, '12,000.00');
    expect((await db.approvalStep.findMany({ where: { requestId: second.id } })).map((s) => s.seat)).toEqual(['Budget Owner']);
  });

  it('an admin may not move the top step: refused, rules unchanged, nothing audited', async () => {
    const w = await world('northwind');
    expect(await as(w.admin.id, () => editRules(w.slug, { rules: withThreshold('CFO', 30_000_000) }))).toMatchObject({ error: expect.stringMatching(/needs owner/) });
    expect((await db.orgSettings.findUniqueOrThrow({ where: { orgId: w.orgId } })).rules).toEqual(RULES);
    expect(await db.auditEvent.count({ where: { action: 'rules.edited' } })).toBe(0);
    expect(await as(w.owner.id, () => editRules(w.slug, { rules: withThreshold('CFO', 30_000_000) }))).toMatchObject({ changes: 1 });
  });
});

describe('E-INV-07: offboarding an agency revokes its guests in that client only', () => {
  it('Dana loses Northwind on the next request and keeps Contoso', async () => {
    const n = await world('northwind');
    const c = await world('contoso');
    const dana = await db.user.create({ data: { email: 'dana@meridian.test' } });
    await addGuest(n.orgId, n.agency.id, dana.id);
    await addGuest(c.orgId, c.agency.id, dana.id);
    const nPo = await commitmentFor(n, n.agency.id, 500_000n, 'PO-N');
    const cPo = await commitmentFor(c, c.agency.id, 500_000n, 'PO-C');

    await signInAs(dana.id);
    await expect(requireOrg('northwind')).resolves.toMatchObject({ role: 'guest' });

    expect(await as(n.owner.id, () => offboardAgency(n.slug, { agencyId: n.agency.id }))).toMatchObject({ guestsRemoved: 1 });

    await signInAs(dana.id);
    expect(JSON.parse(await outcome(requireOrg('northwind')))).toMatchObject({ nav: 'notFound' });
    await expect(requireOrg('contoso')).resolves.toMatchObject({ role: 'guest', orgId: c.orgId });
    expect(await db.guestMembership.findMany({ where: { userId: dana.id } })).toEqual([expect.objectContaining({ orgId: c.orgId, agencyId: c.agency.id })]);
    expect(await db.commitment.findUniqueOrThrow({ where: { id: nPo.id } })).toMatchObject({ closeReason: 'offboarded' });
    expect(await db.commitment.findUniqueOrThrow({ where: { id: cPo.id } })).toMatchObject({ closedAt: null });
    expect(await db.auditEvent.count({ where: { orgId: n.orgId, action: 'member.removed', targetId: dana.id } })).toBe(1);
  });

  it('a rerun after a failed guest removal finishes the job; once done it is refused', async () => {
    const n = await world('northwind');
    const dana = await db.user.create({ data: { email: 'dana@meridian.test' } });
    await addGuest(n.orgId, n.agency.id, dana.id);
    await db.agency.update({ where: { id: n.agency.id }, data: { offboardedAt: new Date() } }); // marked, removal never ran

    const off = () => as(n.owner.id, () => offboardAgency(n.slug, { agencyId: n.agency.id }));
    expect(await off()).toMatchObject({ guestsRemoved: 1 });
    expect(await db.membership.count({ where: { orgId: n.orgId, userId: dana.id } })).toBe(0);
    expect(await db.auditEvent.count({ where: { orgId: n.orgId, action: 'agency.offboarded' } })).toBe(0); // not marked twice
    expect(await off()).toMatchObject({ error: expect.stringContaining('already offboarded') });
  });
});

describe('E-INV-08: the variance explainer is refused once the org’s AI cap is hit and writes no draft', () => {
  it('cap $1.00, each draft ~$0.30: three drafts, the fourth refused before the model runs', async () => {
    const w = await world('northwind');
    await db.aiBudget.create({ data: { orgId: w.orgId, monthlyCapMicros: 1_000_000n } });
    // 30,000 Sonnet output tokens = $0.30 (src/core/ai/prices.ts). The drafter is a stub; Phase 4 passes the real model.
    const draft = vi.fn(async () => ({ text: 'Spend ran ahead of plan.', usage: { provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 30_000 } }));
    const drafter: Drafter = { provider: 'anthropic', model: 'claude-sonnet-5-5', maxOutputTokens: 30_000, draft };
    const ctx = await actAs(w.admin.id, w.slug);
    for (let k = 0; k < 3; k++) await draftVarianceNote(ctx, w.line.id, drafter);
    await expect(draftVarianceNote(ctx, w.line.id, drafter)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(draft).toHaveBeenCalledTimes(3);
    expect(await db.varianceNote.count({ where: { orgId: w.orgId } })).toBe(3);
    expect(await db.aiUsage.count({ where: { orgId: w.orgId, feature: FEATURE } })).toBe(3);
  });
});
