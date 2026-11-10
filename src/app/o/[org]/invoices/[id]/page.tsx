import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { approveInvoiceForPayment, matchInvoice } from '@/earmark/actions';
import { earmarkCan, isUuid } from '@/earmark/core';
import { suggestMatches } from '@/lib/earmark/match';
import { formatUsd, min } from '@/lib/earmark/money';

export const metadata = { title: 'Invoice' };

const day = (d: Date) => d.toISOString().slice(0, 10);
const TIER = { 1: 'PO number and agency', 2: 'PO number, other agency', 3: 'Agency, amount within 2 %', 4: 'Agency' } as const;
const REASON: Record<string, string> = {
  'po-number': 'PO number on the invoice', agency: 'same agency', 'agency-mismatch': 'different agency',
  'amount-within-2pct': 'amount within 2 % of remaining', 'exact-remaining': 'exactly what is left', 'would-overage': 'would overage',
};

// Demo step 9 (PRD §4): an invoice, the matches made, the engine's ranked suggestions with their reasons; a person
// picks one. A fully matched invoice is approved for payment by Finance (D-25). Staff only: a guest sees her
// invoices on the PO pages.
export default async function InvoicePage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (ctx.role === 'guest' || !isUuid(id)) notFound();
  const base = `/o/${ctx.slug}`;

  const { inv, commitments } = await withOrg(ctx, async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id, ...inOrg(ctx) },
      include: { agency: { select: { name: true } }, matches: { orderBy: { matchedAt: 'asc' }, include: { commitment: { select: { id: true, poNumber: true } } } } },
    });
    if (!inv) notFound();
    // The candidates: the agency's POs, and any PO carrying the number written on the invoice (tier 2, or closed).
    const commitments = await tx.commitment.findMany({
      where: { ...inOrg(ctx), OR: [{ agencyId: inv.agencyId, closedAt: null }, ...(inv.poNumber ? [{ poNumber: { equals: inv.poNumber.trim(), mode: 'insensitive' as const } }] : [])] },
      include: { agency: { select: { name: true } } },
    });
    return { inv, commitments };
  }, { atomic: false });

  const matchedCents = inv.matches.reduce((a, m) => a + m.amountCents, 0n);
  const leftCents = inv.amountCents - matchedCents;
  const byId = new Map(commitments.map((c) => [c.id, c]));
  const { suggestions, excluded } = suggestMatches(
    { id: inv.id, agencyId: inv.agencyId, amountCents: inv.amountCents, poNumber: inv.poNumber },
    commitments.map((c) => ({ id: c.id, agencyId: c.agencyId, poNumber: c.poNumber, amountCents: c.amountCents, remainingCents: c.remainingCents, state: c.closedAt ? 'closed' : 'open' })),
  );
  const canMatch = earmarkCan(ctx.role, 'invoice.match') && (inv.state === 'submitted' || inv.state === 'matched') && leftCents > 0n;

  return (
    <main>
      <p><Link href={`${base}/invoices`}>Invoices</Link></p>
      <h1>Invoice {inv.number}</h1>
      <dl aria-label="Invoice">
        <dt>Agency</dt><dd>{inv.agency.name}</dd>
        <dt>Amount</dt><dd>{formatUsd(inv.amountCents)}</dd>
        <dt>Unmatched</dt><dd>{formatUsd(leftCents)}</dd>
        <dt>PO on the invoice</dt><dd>{inv.poNumber ?? '—'}</dd>
        <dt>Invoiced</dt><dd>{day(inv.invoicedOn)} · due {day(inv.dueOn)}</dd>
        <dt>Status</dt><dd>{inv.state}{inv.approvedForPaymentAt && ` ${day(inv.approvedForPaymentAt)}`}</dd>
        {inv.fileRef && <><dt>File</dt><dd><a href={inv.fileRef} rel="noreferrer noopener" target="_blank">Open the invoice</a></dd></>}
      </dl>

      {inv.state === 'matched' && (
        <ActionForm action={approveInvoiceForPayment.bind(null, ctx.slug)}>
          <input type="hidden" name="invoiceId" value={inv.id} />
          <button type="submit">Approve for payment</button> <small>Finance seat only. Approved invoices count as actual.</small>
        </ActionForm>
      )}

      <h2>Matches</h2>
      <table aria-label="Matches">
        <thead><tr><th>PO</th><th>Amount</th><th>Result</th><th>Matched</th><th>Note</th></tr></thead>
        <tbody>
          {inv.matches.map((m) => (
            <tr key={m.id}>
              <td><Link href={`${base}/commitments/${m.commitment.id}`}>{m.commitment.poNumber}</Link></td>
              <td>{formatUsd(m.amountCents)}</td>
              <td>{m.variance}{m.overage && <> <mark>Overage</mark></>}</td>
              <td>{day(m.matchedAt)}</td>
              <td>{m.note || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {inv.matches.length === 0 && <p>None yet.</p>}

      {canMatch && (
        <>
          <h2>Suggested POs</h2>
          {suggestions.length === 0 && <p>No open PO from {inv.agency.name}.</p>}
          <table aria-label="Suggested POs">
            <thead><tr><th>Rank</th><th>PO</th><th>Agency</th><th>Why</th><th>Remaining</th><th>Difference</th><th>Match</th></tr></thead>
            <tbody>
              {suggestions.slice(0, 5).map((s) => {
                const c = byId.get(s.commitmentId)!;
                const amount = s.remainingCents > 0n ? min(leftCents, s.remainingCents) : leftCents;
                return (
                  <tr key={s.commitmentId}>
                    <td>{s.rank}</td>
                    <td><Link href={`${base}/commitments/${c.id}`}>{c.poNumber}</Link></td>
                    <td>{c.agency.name}</td>
                    <td>{TIER[s.tier]}: {s.reasons.map((r) => REASON[r] ?? r).join(', ')}</td>
                    <td>{formatUsd(s.remainingCents)}</td>
                    <td>{formatUsd(s.differenceCents)}</td>
                    <td>
                      <ActionForm action={matchInvoice.bind(null, ctx.slug)}>
                        <input type="hidden" name="invoiceId" value={inv.id} />
                        <input type="hidden" name="commitmentId" value={c.id} />
                        <label>Amount (USD) <input name="amount" inputMode="decimal" required maxLength={32} defaultValue={formatUsd(amount)} /></label>{' '}
                        <label>Note <input name="note" maxLength={2000} placeholder={s.wouldOverage ? 'Required for an overage' : ''} /></label>{' '}
                        <button type="submit">Match to {c.poNumber}</button>
                      </ActionForm>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {excluded.length > 0 && <p>Closed, so not offered: {excluded.map((e) => byId.get(e.commitmentId)!.poNumber).join(', ')}.</p>}
        </>
      )}
    </main>
  );
}
