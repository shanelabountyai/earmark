import Link from 'next/link';
import { notFound } from 'next/navigation';
import { actorEmails } from '@/core/audit';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { approveInvoiceForPayment, matchInvoice } from '@/earmark/actions';
import { earmarkCan, isUuid } from '@/earmark/core';
import { Card, day, InvoiceState, Money, PageHead, Pill, TableWrap } from '@/earmark/ui/kit';
import { suggestMatches } from '@/lib/earmark/match';
import { formatUsd, min } from '@/lib/earmark/money';

export const metadata = { title: 'Invoice' };

const TIER = { 1: 'PO number and agency', 2: 'PO number, other agency', 3: 'Agency, amount within 2 %', 4: 'Agency' } as const;
const REASON: Record<string, string> = {
  'po-number': 'PO number on the invoice', agency: 'same agency', 'agency-mismatch': 'different agency',
  'amount-within-2pct': 'amount within 2 % of remaining', 'exact-remaining': 'exactly what is left', 'would-overage': 'would overage',
};
const QUEUE: Record<string, string> = { submitted: 'To match', matched: 'To approve for payment', approved: 'Approved for payment' };

// Demo step 9 (PRD §4; design: docs/design/Invoice.dc.html): an invoice, the matches made, the engine's ranked
// suggestions with their reasons; a person picks one. A fully matched invoice is approved for payment by Finance
// (D-25); approveInvoiceForPayment is what refuses anyone else. Staff only: a guest sees her invoices on PO pages.
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

  const emails = await actorEmails([inv.submittedById]);
  const matchedCents = inv.matches.reduce((a, m) => a + m.amountCents, 0n);
  const leftCents = inv.amountCents - matchedCents;
  const byId = new Map(commitments.map((c) => [c.id, c]));
  const { suggestions, excluded } = suggestMatches(
    { id: inv.id, agencyId: inv.agencyId, amountCents: inv.amountCents, poNumber: inv.poNumber },
    commitments.map((c) => ({ id: c.id, agencyId: c.agencyId, poNumber: c.poNumber, amountCents: c.amountCents, remainingCents: c.remainingCents, state: c.closedAt ? 'closed' : 'open' })),
  );
  const canMatch = earmarkCan(ctx.role, 'invoice.match') && (inv.state === 'submitted' || inv.state === 'matched') && leftCents > 0n;

  return (
    <main className="stack">
      <PageHead
        eyebrow={<><Link href={`${base}/invoices`}>Invoices</Link>{QUEUE[inv.state] && <> · {QUEUE[inv.state]}</>}</>}
        title={<>{inv.number} · <Money cents={inv.amountCents} /></>}
        lede={<>{inv.agency.name} · submitted by {emails.get(inv.submittedById) ?? 'an API key'} · PO on the invoice: {inv.poNumber ?? 'none'}</>}
        aside={<p style={{ margin: 0 }}><span className="sr-only">Status: </span><InvoiceState state={inv.state} big /></p>}
      />

      <Card id="facts-h" title="Invoice">
        <dl aria-label="Invoice" className="facts">
          <dt>Agency</dt><dd>{inv.agency.name}</dd>
          <dt>Amount</dt><dd><Money cents={inv.amountCents} /></dd>
          <dt>Unmatched</dt><dd><Money cents={leftCents} /></dd>
          <dt>Invoiced</dt><dd>{day(inv.invoicedOn)} · due {day(inv.dueOn)}</dd>
          <dt>Status</dt><dd>{inv.state}{inv.approvedForPaymentAt && ` ${day(inv.approvedForPaymentAt)}`}</dd>
          {inv.fileRef && <><dt>File</dt><dd><a href={inv.fileRef} rel="noreferrer noopener" target="_blank">Open the invoice<span className="sr-only"> (opens in a new tab)</span></a></dd></>}
        </dl>
      </Card>

      {canMatch && (
        <Card id="sug-h" title="Suggested POs" aside={<span className="note">Ranked by the matcher with its reasons. A person picks.</span>}>
          {suggestions.length === 0 ? <p className="note">No open PO from {inv.agency.name}.</p> : (
            <TableWrap label="Suggested POs">
              <table aria-label="Suggested POs">
                <thead><tr><th scope="col">#</th><th scope="col">PO</th><th scope="col" className="num">Left on PO</th><th scope="col">Why</th><th scope="col">Match</th></tr></thead>
                <tbody>
                  {suggestions.slice(0, 5).map((s, k) => {
                    const c = byId.get(s.commitmentId)!;
                    const amount = s.remainingCents > 0n ? min(leftCents, s.remainingCents) : leftCents;
                    return (
                      <tr key={s.commitmentId} className={k === 0 ? 'hi' : undefined}>
                        <td><strong>{s.rank}</strong></td>
                        <td className="nowrap"><Link href={`${base}/commitments/${c.id}`}><strong>{c.poNumber}</strong></Link>{c.agencyId !== inv.agencyId && <div className="muted">{c.agency.name}</div>}</td>
                        <td className="num"><Money cents={s.remainingCents} /></td>
                        <td><strong>{TIER[s.tier]}:</strong> {s.reasons.filter((x) => x !== 'would-overage').map((x) => REASON[x] ?? x).join(', ')}{s.wouldOverage && <>, <span className="bad-text"><span aria-hidden="true">✕ </span>would overage</span></>}</td>
                        <td className="inline-form">
                          <ActionForm action={matchInvoice.bind(null, ctx.slug)}>
                            <input type="hidden" name="invoiceId" value={inv.id} />
                            <input type="hidden" name="commitmentId" value={c.id} />
                            <label>Amount<span className="sr-only"> to match to {c.poNumber}</span> (USD) <input name="amount" inputMode="decimal" required maxLength={32} defaultValue={formatUsd(amount)} size={10} autoComplete="off" /></label>
                            <label>Note<span className="sr-only"> for {c.poNumber}</span> <input name="note" maxLength={2000} placeholder={s.wouldOverage ? 'Required for an overage' : 'Optional'} size={14} /></label>
                            <button type="submit" className={k === 0 ? undefined : 'btn-secondary'}>Match to {c.poNumber}</button>
                          </ActionForm>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
          <p className="note">A match that takes a PO below zero is an overage: it needs a Finance seat holder and a note.{excluded.length > 0 && <> Closed, so not offered: {excluded.map((e) => byId.get(e.commitmentId)!.poNumber).join(', ')}.</>}</p>
        </Card>
      )}

      <Card id="m-h" title="Matches">
        {inv.matches.length === 0 ? <p className="note">None yet.</p> : (
          <TableWrap label="Matches">
            <table aria-label="Matches">
              <thead><tr><th scope="col">PO</th><th scope="col" className="num">Amount</th><th scope="col">Result</th><th scope="col">Matched</th><th scope="col">Note</th></tr></thead>
              <tbody>
                {inv.matches.map((m) => (
                  <tr key={m.id}>
                    <td className="nowrap"><Link href={`${base}/commitments/${m.commitment.id}`}>{m.commitment.poNumber}</Link></td>
                    <td className="num"><Money cents={m.amountCents} /></td>
                    <td><span className="pills">{m.variance === 'exact' ? <Pill tone="good">Exact</Pill> : m.variance === 'under' ? <Pill tone="info" glyph="▼">Under</Pill> : <Pill tone="hold" glyph="▲">Over</Pill>}{m.overage && <Pill tone="bad">Overage</Pill>}</span></td>
                    <td className="nowrap">{day(m.matchedAt)}</td>
                    <td>{m.note || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {inv.state === 'matched' && (
        <Card id="pay-h" title="Approve for payment">
          <div className="inline-form">
            <ActionForm action={approveInvoiceForPayment.bind(null, ctx.slug)}>
              <input type="hidden" name="invoiceId" value={inv.id} />
              <button type="submit">Approve for payment</button>
            </ActionForm>
          </div>
          <p className="note">Finance seat only. Approved invoices count as actual. Earmark stops at “approved for payment” and sends the event; it doesn’t move money.</p>
        </Card>
      )}
    </main>
  );
}
