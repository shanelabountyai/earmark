// Earmark's demo ledger (PRD §9), called by seed-demo.ts after it has made each org's owner, admin and member.
// Synthetic only: no real people, no real vendors. Every run deletes the org's Earmark rows and plants them again,
// so the ledger is the same on every seed and its frozen approver ids always name users that exist.
import { readFileSync } from 'node:fs';
import { sealSecret } from '@/core/auth/secret-box';
import { now } from '@/core/clock';
import { demoReceiverSecret, demoReceiverUrl } from '@/earmark/demo-receiver';
import type { PrismaClient } from '@/generated/prisma/client';
import { chainToJson } from '@/lib/earmark/cases';
import { evaluateChain, parseRules, type RulesJson, type Seat } from '@/lib/earmark/chain';
import { applyMatch } from '@/lib/earmark/match';

type Db = PrismaClient;
type Person = { local: string; name: string; seats: string[] };
type Program = { name: string; seat: string; dollars: number; campaigns: { name: string; costCenter?: string }[] };
type Plan = {
  slug: string;
  domain: string;
  fy: { label: string; startsOn: string };
  programs: Program[];
  agencies: string[];
  people: Person[]; // seat holders beyond owner/admin/member; `owner`/`admin`/`member` name the template's three
  delegation?: { seat: string; from: string; to: string };
  // Request states in order. Specials pin a request's line and amount (dollars) to set up a demo moment.
  states: ('approved' | 'submitted' | 'over-budget' | 'rejected' | 'withdrawn')[];
  specials: Record<number, { line: string; dollars: number }>;
  invoicesPer: (j: number) => number;
  overages: number[]; // indexes into the approved commitments
  unmatchedAges: number[];
  replanLine?: string;
};

const RULES = parseRules(JSON.parse(readFileSync('rules/approval-chains.json', 'utf8')) as RulesJson);
export const AGENCY_DOMAIN = 'meridian.demo.test';
export const GUEST_EMAIL = `dana@${AGENCY_DOMAIN}`;

const rep = <T>(x: T, n: number) => Array<T>(n).fill(x);

export const PLANS: Plan[] = [
  {
    slug: 'northwind',
    domain: 'northwind.demo.test',
    fy: { label: 'FY2026', startsOn: '2026-01-01' },
    programs: [
      { name: 'Brand', seat: 'Brand Owner', dollars: 1_200_000, campaigns: [{ name: 'Awareness' }, { name: 'Sponsorships' }] },
      { name: 'Demand Gen', seat: 'Demand Gen Owner', dollars: 1_800_000, campaigns: [{ name: 'Paid Social' }, { name: 'Search' }] },
      { name: 'Events', seat: 'Events Owner', dollars: 1_000_000, campaigns: [{ name: 'Trade Shows', costCenter: 'Events' }, { name: 'Field Events', costCenter: 'Events' }] },
      { name: 'Content', seat: 'Content Owner', dollars: 800_000, campaigns: [{ name: 'Editorial' }, { name: 'Video' }] },
    ],
    agencies: ['Meridian Creative', 'Harbor Media', 'Lumenfield Events'],
    people: [
      { local: 'owner', name: '', seats: ['CFO'] },
      { local: 'admin', name: '', seats: ['Marketing Ops'] },
      { local: 'member', name: '', seats: ['Demand Gen Owner'] }, // the requester also holds the seat: step 4's self-approval refusal
      { local: 'brand', name: 'Priya Shah (Brand owner)', seats: ['Brand Owner'] },
      { local: 'demandgen', name: 'Marcus Lee (Demand Gen owner)', seats: ['Demand Gen Owner'] },
      { local: 'events', name: 'Ines Duarte (Events owner)', seats: ['Events Owner', 'Events Lead'] },
      { local: 'content', name: 'Tom Okafor (Content owner)', seats: ['Content Owner'] },
      { local: 'finance', name: 'Grace Kim (Finance)', seats: ['Finance'] },
      { local: 'cmo', name: 'Ruth Alvarez (CMO)', seats: ['CMO'] },
    ],
    delegation: { seat: 'Content Owner', from: 'content', to: 'brand' }, // the one delegated seat
    states: [...rep('approved' as const, 25), ...rep('submitted' as const, 7), 'over-budget', ...rep('rejected' as const, 4), ...rep('withdrawn' as const, 3)],
    specials: { 0: { line: 'Q2 Paid Social', dollars: 18_000 }, 1: { line: 'Q3 Editorial', dollars: 30_000 }, 2: { line: 'Q3 Editorial', dollars: 30_000 }, 3: { line: 'Q3 Editorial', dollars: 32_000 }, 32: { line: 'Q3 Editorial', dollars: 9_500 } },
    invoicesPer: (j) => (j < 4 ? 3 : 2), // 4×3 + 21×2 = 54 matched, + 6 unmatched = 60
    overages: [5, 11],
    unmatchedAges: [3, 9, 16, 21, 28, 40],
    replanLine: 'Q2 Paid Social',
  },
  {
    slug: 'contoso',
    domain: 'contoso.demo.test',
    fy: { label: 'FY2027', startsOn: '2026-07-01' },
    programs: [
      { name: 'Product Launch', seat: 'Product Launch Owner', dollars: 700_000, campaigns: [{ name: 'Launch Ads' }, { name: 'Analyst Relations' }] },
      { name: 'Partner Marketing', seat: 'Partner Marketing Owner', dollars: 500_000, campaigns: [{ name: 'Co-marketing' }, { name: 'Partner Events', costCenter: 'Events' }] },
    ],
    agencies: ['Meridian Creative', 'Copperline Digital'],
    people: [
      { local: 'owner', name: '', seats: ['CFO'] },
      { local: 'admin', name: '', seats: ['Marketing Ops', 'Events Lead'] },
      { local: 'member', name: '', seats: [] },
      { local: 'launch', name: 'Hana Sato (Product Launch owner)', seats: ['Product Launch Owner'] },
      { local: 'partner', name: 'Diego Ruiz (Partner Marketing owner)', seats: ['Partner Marketing Owner'] },
      { local: 'finance', name: 'Ben Carter (Finance)', seats: ['Finance'] },
      { local: 'cmo', name: 'Alma Novak (CMO)', seats: ['CMO'] },
    ],
    states: [...rep('approved' as const, 5), ...rep('submitted' as const, 2), 'rejected'],
    specials: {},
    invoicesPer: () => 1,
    overages: [],
    unmatchedAges: [5, 12],
  },
];

const AMOUNTS = [4_500, 7_500, 12_000, 6_250, 9_800, 15_000, 8_400, 22_000, 5_600, 11_250];
const DAY = 86_400_000;

/** Upserts a demo user and their membership; returns the id. */
async function person(db: Db, orgId: string, email: string, name: string, role: 'member' | 'guest') {
  const u = await db.user.upsert({ where: { email }, create: { email, name, isDemo: true }, update: { name, isDemo: true } });
  await db.membership.upsert({ where: { orgId_userId: { orgId, userId: u.id } }, create: { orgId, userId: u.id, role }, update: { role } });
  return u.id;
}

/** Deletes the org's Earmark rows. Cascades carry periods, lines, requests, steps, commitments, invoices and matches. */
async function clear(db: Db, orgId: string) {
  await db.agency.deleteMany({ where: { orgId } });
  await db.fiscalYear.deleteMany({ where: { orgId } });
  await db.seat.deleteMany({ where: { orgId } });
  await db.orgSettings.deleteMany({ where: { orgId } });
}

export async function seedEarmark(db: Db): Promise<string[]> {
  const printed: string[] = [];
  for (const p of PLANS) printed.push(...(await seedOrg(db, p)));
  printed.push(await seedReceiver(db));
  return printed;
}

/** Step 6: Northwind's endpoint for the demo receiver, from the org's current seq, so it sends what happens from now on. */
async function seedReceiver(db: Db): Promise<string> {
  const { id: orgId, eventSeq } = await db.org.findUniqueOrThrow({ where: { slug: 'northwind' }, select: { id: true, eventSeq: true } });
  const url = demoReceiverUrl();
  await db.webhookEndpoint.deleteMany({ where: { orgId, url } });
  const eventTypes = ['request.approved', 'commitment.issued', 'invoice.matched', 'invoice.approved_for_payment'];
  await db.webhookEndpoint.create({ data: { orgId, url, eventTypes, secretSealed: sealSecret(demoReceiverSecret(), 'webhook'), cursorSeq: eventSeq } });
  return `Northwind webhooks go to the demo receiver at ${url}${url.startsWith('http:') ? ' (needs WEBHOOK_ALLOW_PRIVATE=1)' : ''}`;
}

async function seedOrg(db: Db, p: Plan): Promise<string[]> {
  const t = now();
  const ago = (days: number) => new Date(t.getTime() - days * DAY);
  const org = await db.org.findUniqueOrThrow({ where: { slug: p.slug }, select: { id: true, name: true } });
  const orgId = org.id;
  await clear(db, orgId);
  await db.orgSettings.create({ data: { orgId, rules: JSON.parse(readFileSync('rules/approval-chains.json', 'utf8')), fiscalStartMonth: Number(p.fy.startsOn.slice(5, 7)) } });

  // People: the template's owner/admin/member exist already; the others are members.
  const ids: Record<string, string> = {};
  const printed: string[] = [];
  for (const who of p.people) {
    const email = `${who.local}@${p.domain}`;
    if (['owner', 'admin', 'member'].includes(who.local)) ids[who.local] = (await db.user.findUniqueOrThrow({ where: { email } })).id;
    else {
      ids[who.local] = await person(db, orgId, email, who.name, 'member');
      printed.push(`${email}  member of ${org.name}, holds ${who.seats.join(', ')}`);
    }
  }

  // Seats and holders. The seat-holder rows carry the delegation, as the chain engine reads it.
  const seatNames = [...new Set(p.people.flatMap((w) => w.seats))].sort();
  const seats: Seat[] = [];
  for (const name of seatNames) {
    const seat = await db.seat.create({ data: { orgId, name } });
    const holders = p.people.filter((w) => w.seats.includes(name)).map((w) => {
      const d = p.delegation?.seat === name && p.delegation.from === w.local ? p.delegation : null;
      return { userId: ids[w.local]!, activeFrom: ago(365), activeTo: d ? new Date(t.getTime() + 14 * DAY) : null, delegateToId: d ? ids[d.to]! : null };
    });
    await db.seatHolder.createMany({ data: holders.map((h) => ({ orgId, seatId: seat.id, ...h })) });
    seats.push({ name, holders: holders.map((h) => ({ userId: h.userId, activeFrom: h.activeFrom.toISOString(), activeTo: h.activeTo?.toISOString() ?? null, delegateToId: h.delegateToId })) });
  }
  // Mirrors core.ts seatsFor: the chain's `Budget Owner` step resolves to the line's owner seat (D-18).
  const seatsFor = (ownerSeat: string) => [...seats.filter((s) => s.name !== 'Budget Owner'), { name: 'Budget Owner', holders: seats.find((s) => s.name === ownerSeat)?.holders ?? [] }];

  // The plan: fiscal year, twelve periods, programs, campaigns, one line per campaign per quarter.
  const start = new Date(`${p.fy.startsOn}T00:00:00Z`);
  const fy = await db.fiscalYear.create({ data: { orgId, label: p.fy.label, startsOn: start } });
  const periods: { id: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const e = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 0));
    periods.push(await db.period.create({ data: { orgId, fiscalYearId: fy.id, index: i + 1, startsOn: s, endsOn: e } }));
  }
  const lines: { id: string; name: string; campaignId: string; plannedCents: bigint; ownerSeat: string; costCenter: string; committed: bigint }[] = [];
  for (const [pi, prog] of p.programs.entries()) {
    const program = await db.program.create({ data: { orgId, fiscalYearId: fy.id, name: prog.name } });
    for (const camp of prog.campaigns) {
      const campaign = await db.campaign.create({ data: { orgId, programId: program.id, name: camp.name } });
      const plannedCents = BigInt(Math.round((prog.dollars / prog.campaigns.length / 4) * 100));
      for (let q = 1; q <= 4; q++) {
        const data = { orgId, campaignId: campaign.id, periodId: periods[(q - 1) * 3]!.id, name: `Q${q} ${camp.name}`, plannedCents, ownerSeat: prog.seat, costCenter: camp.costCenter ?? prog.name, glCode: `61${pi}0` };
        const l = await db.budgetLine.create({ data });
        lines.push({ ...data, id: l.id, committed: 0n });
      }
    }
  }

  const agencies: { id: string; name: string }[] = [];
  for (const name of p.agencies) {
    agencies.push(await db.agency.create({ data: { orgId, name, domains: [name === 'Meridian Creative' ? AGENCY_DOMAIN : `${name.toLowerCase().replace(/\W+/g, '')}.example.test`], activeAt: ago(400) } }));
  }

  // Requests, each through the real chain engine with the line's real available at that point.
  const requester = ids.member!;
  const prefix = p.slug.slice(0, 2).toUpperCase();
  const commitments: { id: string; poNumber: string; agencyId: string; amountCents: bigint; remainingCents: bigint; issuedAt: Date; open: boolean }[] = [];
  let free = 0; // cycles the non-special lines
  for (const [i, state] of p.states.entries()) {
    const sp = p.specials[i];
    const line = sp ? lines.find((l) => l.name === sp.line)! : lines.filter((l) => !Object.values(p.specials).some((s) => s.line === l.name))[(free++ * 5) % (lines.length - 2)]!;
    const amountCents = BigInt((sp?.dollars ?? AMOUNTS[i % AMOUNTS.length]!) * 100);
    const agency = agencies[i % agencies.length]!;
    const submittedAt = ago(300 - i * 7);
    const chain = evaluateChain({ rules: RULES, request: { amountCents, requesterId: requester, kind: 'default', costCenter: line.costCenter, availableCents: line.plannedCents - line.committed }, seats: seatsFor(line.ownerSeat), now: submittedAt.toISOString() });
    if (!chain.ok) throw new Error(`seed: request ${i} on ${line.name}: ${chain.error.message}`);
    if ((state === 'over-budget') !== chain.overBudget) throw new Error(`seed: request ${i} on ${line.name} should ${state === 'over-budget' ? '' : 'not '}be over budget`);
    const final = state === 'over-budget' ? 'submitted' : state;
    const r = await db.spendRequest.create({
      data: { orgId, budgetLineId: line.id, agencyId: agency.id, amountCents, description: `${line.name}: ${agency.name} ${['media buy', 'creative production', 'retainer', 'campaign build'][i % 4]}`, requestedById: requester, state: final, overBudget: chain.overBudget, chainSnapshot: chainToJson(chain) as object, submittedAt, decidedAt: ['approved', 'rejected', 'withdrawn'].includes(final) ? new Date(submittedAt.getTime() + 2 * DAY) : null },
    });
    await db.approvalStep.createMany({
      data: chain.steps.map((s, k) => {
        const decide = state === 'approved' || (state === 'over-budget' && s.source !== 'over-budget') || (state === 'rejected' && k === 0);
        return {
          orgId, requestId: r.id, index: s.index, seat: s.seat, thresholdCents: s.fromCents, source: s.source, approverIds: s.approverIds, blocked: !!s.blocked, requiresNote: s.requiresNote,
          ...(decide ? { decidedById: s.approverIds[0]!, decision: state === 'rejected' ? ('reject' as const) : ('approve' as const), decidedAt: new Date(submittedAt.getTime() + (k + 1) * 3_600_000), note: state === 'rejected' ? 'Not this quarter.' : '' } : {}),
        };
      }),
    });
    if (final === 'approved') {
      const c = await db.commitment.create({ data: { orgId, requestId: r.id, agencyId: agency.id, poNumber: `PO-${prefix}-${1001 + i}`, amountCents, remainingCents: amountCents, issuedAt: r.decidedAt! } });
      commitments.push({ id: c.id, poNumber: c.poNumber, agencyId: agency.id, amountCents, remainingCents: amountCents, issuedAt: c.issuedAt, open: true });
      line.committed += amountCents;
      if (line.name === p.replanLine) {
        await db.budgetLine.update({ where: { id: line.id }, data: { plannedEditedAt: new Date(c.issuedAt.getTime() + 10 * DAY) } }); // PRD §4 replan marker
      }
    }
  }

  // Invoices: each commitment billed in parts; some fully, two past the PO (Finance overages); then the unmatched.
  const finance = ids.finance!;
  const seq: Record<string, number> = {};
  const invNo = (agencyId: string) => `${agencies.find((a) => a.id === agencyId)!.name.split(' ')[0]!.toUpperCase()}-${(seq[agencyId] = (seq[agencyId] ?? 0) + 1) + 200}`;
  let matchedCount = 0;
  for (const [j, c] of commitments.entries()) {
    const n = p.invoicesPer(j);
    const full = j % 4 === 0 || p.overages.includes(j);
    const parts = Array.from({ length: n }, (_, k) => {
      if (k < n - 1) return (c.amountCents * 30n) / 100n;
      const rest = c.amountCents - ((c.amountCents * 30n) / 100n) * BigInt(n - 1);
      return p.overages.includes(j) ? rest + c.amountCents / 20n : full ? rest : rest / 2n;
    });
    for (const [k, amountCents] of parts.entries()) {
      const invoicedOn = new Date(c.issuedAt.getTime() + (k + 1) * 9 * DAY);
      if (invoicedOn > t) break;
      const overage = c.remainingCents - amountCents < 0n;
      const m = applyMatch({ id: c.id, remainingCents: c.remainingCents, state: c.open ? 'open' : 'closed' }, { commitmentId: c.id, amountCents, matcherSeats: overage ? ['Finance'] : [], note: overage ? 'Agreed extra production day.' : '' });
      if (!m.ok) throw new Error(`seed: match on ${c.poNumber}: ${m.message}`);
      const paid = invoicedOn.getTime() < t.getTime() - 30 * DAY && k % 2 === 0;
      const inv = await db.invoice.create({
        data: { orgId, agencyId: c.agencyId, number: invNo(c.agencyId), poNumber: c.poNumber, amountCents, invoicedOn, dueOn: new Date(invoicedOn.getTime() + 30 * DAY), submittedById: requester, state: paid ? 'approved' : 'matched', approvedForPaymentAt: paid ? new Date(invoicedOn.getTime() + 5 * DAY) : null, createdAt: invoicedOn },
      });
      await db.invoiceMatch.create({ data: { orgId, invoiceId: inv.id, commitmentId: c.id, amountCents, matchedById: overage ? finance : ids.admin!, matchedAt: new Date(invoicedOn.getTime() + DAY), variance: m.variance, overage: m.overage, note: overage ? 'Agreed extra production day.' : '' } });
      c.remainingCents = m.remainingAfter;
      if (m.closes) c.open = false;
      matchedCount++;
    }
    await db.commitment.update({ where: { id: c.id }, data: { remainingCents: c.remainingCents, ...(c.open ? {} : { closedAt: t, closeReason: c.remainingCents < 0n ? 'overage' : 'fully matched' }) } });
  }
  const open = commitments.filter((c) => c.open);
  for (const [k, age] of p.unmatchedAges.entries()) {
    const c = open[k % open.length]!;
    const invoicedOn = ago(age);
    await db.invoice.create({ data: { orgId, agencyId: c.agencyId, number: invNo(c.agencyId), poNumber: c.poNumber, amountCents: c.remainingCents > 1n ? c.remainingCents / 4n : 50_000n, invoicedOn, dueOn: new Date(invoicedOn.getTime() + 30 * DAY), submittedById: requester, createdAt: invoicedOn } });
  }

  // Dana: one person, a guest in each client, tied to that client's Meridian row (D-12).
  const meridian = agencies.find((a) => a.name === 'Meridian Creative')!;
  const dana = await person(db, orgId, GUEST_EMAIL, 'Dana Reyes (Meridian Creative)', 'guest');
  await db.guestMembership.upsert({ where: { orgId_userId: { orgId, userId: dana } }, create: { orgId, userId: dana, agencyId: meridian.id }, update: { agencyId: meridian.id } });
  printed.push(`${GUEST_EMAIL}  guest of ${org.name} for Meridian Creative`);
  printed.push(`${org.name}: ${p.states.length} requests, ${commitments.length} POs, ${matchedCount + p.unmatchedAges.length} invoices (${p.unmatchedAges.length} unmatched)`);
  return printed;
}
