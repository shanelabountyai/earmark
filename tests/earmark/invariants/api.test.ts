// Phase 4 item 2 (D-31): the Earmark API. A key reads a commitment only in its own org, through the guest projection,
// and another client's id is the same 404 body as a missing one (PRD §9 step 8). POST /invoices needs the `invoices`
// scope and keeps the guest form's rules (fileInvoice).
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { createKey } from '@/modules/apikeys/keys';
import * as commitment from '@/app/api/v1/commitments/[id]/route';
import * as invoices from '@/app/api/v1/invoices/route';
import { resetAuthTables } from '../../helpers/auth';
import { actAs } from '../../helpers/org';
import { commitmentFor, world } from './world';

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
