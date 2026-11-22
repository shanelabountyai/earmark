// D-76 (review U8), D-87: what has been invoiced on a PO but not yet matched, so its page never says "nothing billed"
// with an invoice sitting under it. The same rest the engine counts as provision (D-69, rollup.ts): a submitted invoice's
// amount minus every match on it (a submitted invoice's matches are all pending). Only invoices of the PO's own agency
// that name the PO count (D-71); an invoice that names another PO but is partly matched here is that PO's to await.
import { normalizePo } from '@/lib/earmark/match';

type Inv = { agencyId: string | null; poNumber: string | null; state: string; amountCents: bigint; matches: { amountCents: bigint }[] };

export function awaitingMatchCents(po: { agencyId: string; poNumber: string }, invoices: readonly Inv[]): bigint {
  const number = normalizePo(po.poNumber);
  let total = 0n;
  for (const i of invoices) {
    if (i.state !== 'submitted' || i.agencyId !== po.agencyId || normalizePo(i.poNumber) !== number) continue;
    const rest = i.amountCents - i.matches.reduce((a, m) => a + m.amountCents, 0n);
    if (rest > 0n) total += rest;
  }
  return total;
}
