// D-76 / D-87: *Billed, awaiting match* on a PO page is the engine's unmatched rest (D-69: a submitted invoice's amount
// minus what is matched to it) over the invoices of this PO's agency that name this PO, and nothing else.
import { expect, it } from 'vitest';
import { awaitingMatchCents } from '@/earmark/awaiting';

const po = { agencyId: 'a1', poNumber: 'PO-0007' };
const inv = (o: Partial<{ agencyId: string; poNumber: string; state: string; amountCents: bigint; matches: { amountCents: bigint }[] }>) =>
  ({ agencyId: 'a1', poNumber: 'PO-0007', state: 'submitted', amountCents: 100_00n, matches: [], ...o });

it('counts the unmatched rest of submitted invoices that name this PO', () => {
  expect(awaitingMatchCents(po, [inv({}), inv({ poNumber: ' po-0007 ', matches: [{ amountCents: 40_00n }] })])).toBe(160_00n);
});

it('skips approved, rejected and fully matched invoices', () => {
  expect(awaitingMatchCents(po, [inv({ state: 'approved' }), inv({ state: 'rejected' }), inv({ matches: [{ amountCents: 100_00n }] })])).toBe(0n);
});

it('does not count an invoice that names another PO, even when part of it is matched to this one', () => {
  expect(awaitingMatchCents(po, [inv({ poNumber: 'PO-0008', matches: [{ amountCents: 30_00n }] })])).toBe(0n);
});

it("does not count another agency's invoice naming the same number (D-71)", () => {
  expect(awaitingMatchCents(po, [inv({ agencyId: 'a2' })])).toBe(0n);
});
