// Phase 4 item 2 (D-31): the Earmark API. A key reads a commitment only in its own org, through the guest projection,
// and another client's id is the same 404 body as a missing one (PRD §9 step 8). POST /invoices needs the `invoices`
// scope and keeps the guest form's rules (fileInvoice).
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { createKey } from '@/modules/apikeys/keys';
import * as commitment from '@/app/api/v1/commitments/[id]/route';
import * as invoices from '@/app/api/v1/invoices/route';
import { submitInvoice } from '@/earmark/actions';
import { resetAuthTables } from '../../helpers/auth';
import { actAs } from '../../helpers/org';
import { as, commitmentFor, world } from './world';

beforeEach(resetAuthTables);

const get = (id: string, key: string) => commitment.GET(new Request(`http://app.test/api/v1/commitments/${id}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ id }) });
const post = (body: unknown, key: string, idem = randomUUID()) =>
  invoices.POST(new Request('http://app.test/api/v1/invoices', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const keyFor = async (w: { owner: { id: string }; slug: string }, scopes: string[]) => createKey(await actAs(w.owner.id, w.slug), { label: 'finance sync', scopes });

it("a key reads its own commitment through the guest projection; another client's id is the same 404 as a missing one", async () => {
  const north = await world('northwind');
  const contoso = await world('contoso');
  const ours = await commitmentFor(north, north.agency.id, 500_000n, 'PO-N1');
  const northKey = await keyFor(north, ['read']);
  const contosoKey = await keyFor(contoso, ['read']);

  const own = await get(ours.id, northKey);
  expect(own.status).toBe(200);
  expect(await own.json()).toEqual({ id: ours.id, poNumber: 'PO-N1', amountCents: '500000', remainingCents: '500000', issuedAt: expect.any(String), closedAt: null, matchStatus: 'unmatched', invoiceDueDates: [] });

  const foreign = await get(ours.id, contosoKey);
  const missing = await get(randomUUID(), contosoKey);
  expect(foreign.status).toBe(404);
  expect([missing.status, await missing.text()]).toEqual([foreign.status, await foreign.text()]);
});

it('POST /invoices needs the invoices scope and files under the key creator, with the guest form rules', async () => {
  const w = await world('northwind');
  const other = await world('contoso');
  await commitmentFor(w, w.agency.id, 500_000n, 'PO-N1'); // D-70: the PO an invoice names must exist for its agency
  const body = { agencyId: w.agency.id, number: 'INV-1', poNumber: 'PO-N1', amountCents: '125000', invoicedOn: '2026-11-01', dueOn: '2026-12-01' };

  expect((await post(body, await keyFor(w, ['read', 'write']))).status).toBe(403);

  const key = await keyFor(w, ['invoices']);
  const idem = randomUUID();
  const made = await post(body, key, idem);
  expect(made.status).toBe(201);
  const inv = await made.json();
  expect(inv).toMatchObject({ number: 'INV-1', amountCents: '125000', invoicedOn: '2026-11-01', dueOn: '2026-12-01', state: 'submitted' });
  expect(await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ orgId: w.orgId, submittedById: w.owner.id });
  expect(await db.auditEvent.count({ where: { orgId: w.orgId, action: 'invoice.submitted', targetId: inv.id } })).toBe(1);

  const replay = await post(body, key, idem);
  expect([replay.status, replay.headers.get('idempotent-replayed'), (await replay.json()).id]).toEqual([201, 'true', inv.id]);

  const refused = async (b: unknown) => {
    const r = await post(b, key);
    return [r.status, (await r.json()).detail];
  };
  expect(await refused(body)).toEqual([422, 'Invoice INV-1 is already in.']);
  expect(await refused({ ...body, number: 'INV-2', dueOn: '2026-13-01' })).toEqual([422, 'Due date must be a date (YYYY-MM-DD).']);
  expect((await post({ ...body, number: 'INV-3', amountCents: '0' }, key)).status).toBe(400);

  // Another client's agency answers as one that does not exist.
  const foreign = await post({ ...body, number: 'INV-4', agencyId: other.agency.id }, key);
  const missing = await post({ ...body, number: 'INV-4', agencyId: randomUUID() }, key);
  expect(foreign.status).toBe(404);
  expect([missing.status, await missing.text()]).toEqual([foreign.status, await foreign.text()]);

  await db.agency.update({ where: { id: w.agency.id }, data: { offboardedAt: new Date() } });
  expect(await refused({ ...body, number: 'INV-5' })).toEqual([422, 'Meridian Creative has been offboarded.']);
  expect(await db.invoice.count({ where: { orgId: w.orgId } })).toBe(1);
});

it('D-33/D-41: a malformed amount on a foreign agency is the same 404 as any foreign id; on our own agency it is a 400', async () => {
  const w = await world('northwind');
  const other = await world('contoso');
  const key = await keyFor(w, ['invoices']);
  const body = { agencyId: w.agency.id, number: 'INV-1', poNumber: '', amountCents: '125000', invoicedOn: '2026-11-01', dueOn: '2026-12-01' };
  const answer = async (b: unknown) => {
    const r = await post(b, key);
    return [r.status, await r.text()];
  };

  const foreignId = await answer({ ...body, agencyId: other.agency.id });
  const missingId = await answer({ ...body, agencyId: randomUUID() });
  expect(foreignId[0]).toBe(404);
  for (const amountCents of ['12.50', '0', 'abc', '-5']) {
    expect(await answer({ ...body, agencyId: other.agency.id, amountCents })).toEqual(foreignId);
    expect(await answer({ ...body, agencyId: randomUUID(), amountCents })).toEqual(missingId);
    const own = await post({ ...body, amountCents }, key);
    expect([own.status, (await own.json()).detail]).toEqual([400, 'amountCents: a positive whole number of cents, as a string']);
  }
  expect(await db.invoice.count({ where: { orgId: w.orgId } })).toBe(0);
});

// Live gate (D-60, PRD §11 open item UX S10): one rule in fileInvoice, so the API and the guest form answer alike.
it('D-60: an invoice due before its invoice date is refused on both paths; the same day is accepted; a foreign agency is still the 404', async () => {
  const w = await world('northwind');
  const other = await world('contoso');
  const key = await keyFor(w, ['invoices']);
  const body = { agencyId: w.agency.id, number: 'INV-1', poNumber: '', amountCents: '125000', invoicedOn: '2026-11-10', dueOn: '2026-11-01' };

  const api = await post(body, key);
  expect([api.status, (await api.json()).detail]).toEqual([422, 'Due date cannot be before the invoice date.']);
  const form = () => submitInvoice(w.slug, { agencyId: w.agency.id, number: 'INV-1', amount: '1,250.00', invoicedOn: '2026-11-10', dueOn: '2026-11-01' });
  expect(await as(w.owner.id, form)).toEqual({ error: 'Due date cannot be before the invoice date.' });
  expect(await db.invoice.count({ where: { orgId: w.orgId } })).toBe(0);

  // Ids resolve first (D-19): the rule never tells a foreign agency from a missing one.
  const foreign = await post({ ...body, agencyId: other.agency.id }, key);
  const missing = await post({ ...body, agencyId: randomUUID() }, key);
  expect(foreign.status).toBe(404);
  expect([missing.status, await missing.text()]).toEqual([foreign.status, await foreign.text()]);

  // Due on receipt (the same day) is a real term and stays allowed.
  expect((await post({ ...body, dueOn: '2026-11-10' }, key)).status).toBe(201);
});

// D-70 (review S2): the PO an invoice names resolves to a PO of the same org and the invoice's agency, or it is refused.
it("D-70: an invoice naming another agency's PO, or no PO at all, is refused on both paths; its own PO is stored canonical", async () => {
  const w = await world('northwind');
  const other = await db.agency.create({ data: { orgId: w.orgId, name: 'Harbor Media', domains: ['harbor.test'] } });
  await commitmentFor(w, other.id, 500_000n, 'PO-HARBOR-1');
  await commitmentFor(w, w.agency.id, 500_000n, 'PO-MER-1');
  const key = await keyFor(w, ['invoices']);
  const body = { agencyId: w.agency.id, number: 'INV-1', poNumber: 'PO-HARBOR-1', amountCents: '125000', invoicedOn: '2026-11-01', dueOn: '2026-12-01' };

  const api = await post(body, key);
  expect([api.status, (await api.json()).detail]).toEqual([422, 'No PO PO-HARBOR-1 for Meridian Creative.']);
  expect((await post({ ...body, poNumber: 'PO-NOPE' }, key)).status).toBe(422);
  const form = (poNumber: string, number = 'INV-1') => submitInvoice(w.slug, { agencyId: w.agency.id, number, poNumber, amount: '1,250.00', invoicedOn: '2026-11-01', dueOn: '2026-12-01' });
  expect(await as(w.owner.id, () => form('PO-HARBOR-1'))).toEqual({ error: 'No PO PO-HARBOR-1 for Meridian Creative.' });
  expect(await db.invoice.count({ where: { orgId: w.orgId } })).toBe(0);

  // Its own PO, typed loosely, is stored as the PO's own number; no PO at all stays allowed (the control exception).
  const made = await post({ ...body, poNumber: ' po-mer-1 ' }, key);
  expect([made.status, (await made.json()).poNumber]).toEqual([201, 'PO-MER-1']);
  expect(await as(w.owner.id, () => form('', 'INV-2'))).toMatchObject({ notice: expect.any(String) });
});

// PRD-A A5 (review S6, D-75): an invoice's file reference is an https URL or nothing, on both paths.
it('D-75: a file reference must be https on the API and the guest form', async () => {
  const w = await world('northwind');
  const key = await keyFor(w, ['invoices']);
  const body = { agencyId: w.agency.id, number: 'INV-1', poNumber: '', amountCents: '125000', invoicedOn: '2026-11-01', dueOn: '2026-12-01' };
  for (const fileRef of ['javascript:alert(1)', 'data:text/html,hi', 'http://example.test/inv.pdf'])
    expect([fileRef, (await post({ ...body, fileRef }, key)).status]).toEqual([fileRef, 400]);
  const form = (fileRef: string) => as(w.owner.id, () => submitInvoice(w.slug, { agencyId: w.agency.id, number: 'INV-2', amount: '10.00', invoicedOn: '2026-11-01', dueOn: '2026-12-01', fileRef }));
  expect(await form('http://example.test/inv.pdf')).toMatchObject({ error: expect.stringContaining('https') });
  expect(await db.invoice.count({ where: { orgId: w.orgId } })).toBe(0);
  expect((await post({ ...body, fileRef: 'https://files.example.test/inv.pdf' }, key)).status).toBe(201);
});
