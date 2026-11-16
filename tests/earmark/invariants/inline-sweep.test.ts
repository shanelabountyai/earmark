// D-40: Earmark's emit sweeps the org's webhooks in after(), once the response is out. A throw in that sweep must be
// logged, not left as an unhandled rejection, and the inline sweep sends a small batch (the daily cron is the backstop).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decideStep, submitRequest } from '@/earmark/actions';
import { resetAuthTables } from '../../helpers/auth';
import { as, world } from './world';

const h = vi.hoisted(() => ({ deferred: [] as Array<() => unknown>, sweep: vi.fn() }));
// This file keeps what after() schedules (the shared setup drops it) so the test can run it as Next would.
vi.mock('next/server', async (orig) => ({ ...(await orig<object>()), after: (fn: () => unknown) => void h.deferred.push(fn) }));
vi.mock('@/modules/apikeys/webhooks', async (orig) => ({ ...(await orig<object>()), sweepWebhooks: h.sweep }));

beforeEach(async () => {
  await resetAuthTables();
  h.deferred.length = 0;
  h.sweep.mockReset();
});
afterEach(() => vi.restoreAllMocks());

/** Approves a one-step request, which emits request.approved and commitment.issued. */
async function approveOne() {
  const w = await world('northwind');
  const { id } = (await as(w.requester.id, () => submitRequest(w.slug, { budgetLineId: w.line.id, agencyId: w.agency.id, amount: '7,500.00', description: 'Q4 paid social' }))) as { id: string };
  h.deferred.length = 0;
  expect(await as(w.budgetOwner.id, () => decideStep(w.slug, { requestId: id, decision: 'approve' }))).toEqual({ state: 'approved' });
  return w;
}

const logged = (spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

it('a throwing inline sweep is logged as webhooks.inline_failed and does not reject', async () => {
  h.sweep.mockRejectedValue(new TypeError('fetch failed'));
  const w = await approveOne();
  expect(h.deferred).toHaveLength(2);
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const fn of h.deferred) await expect(Promise.resolve(fn())).resolves.toBeUndefined();
  expect(logged(out).filter((l) => l.event === 'webhooks.inline_failed')).toEqual([
    expect.objectContaining({ orgId: w.orgId, error: 'TypeError' }),
    expect.objectContaining({ orgId: w.orgId, error: 'TypeError' }),
  ]);
});

it('the inline sweep is scoped to the org and sends a small batch (maxSends 5)', async () => {
  h.sweep.mockResolvedValue({ queued: 0, succeeded: 1, failed: 0, dead: 0 });
  const w = await approveOne();
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const fn of h.deferred) await fn();
  expect(h.sweep.mock.calls).toEqual([[{ orgId: w.orgId, maxSends: 5 }], [{ orgId: w.orgId, maxSends: 5 }]]);
  expect(logged(out).filter((l) => l.event === 'webhooks.inline')).toHaveLength(2);
});
