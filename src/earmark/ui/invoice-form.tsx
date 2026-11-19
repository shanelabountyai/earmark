import { Form as ActionForm } from '@/earmark/ui/form';
import { submitInvoice } from '@/earmark/actions';
import { formatUsd } from '@/lib/earmark/money';

/**
 * The invoice form (design: docs/design/Guest.dc.html), on a guest's PO list (pick the PO) and on a PO's page (that
 * PO). Both post to submitInvoice, so the rules are the action's, not the form's.
 */
export function InvoiceForm({ slug, agencyId, pos }: { slug: string; agencyId: string; pos: { poNumber: string; remainingCents: string }[] }) {
  const one = pos.length === 1 ? pos[0] : null;
  return (
    <ActionForm action={submitInvoice.bind(null, slug)}>
      <input type="hidden" name="agencyId" value={agencyId} />
      {one ? (
        <>
          <input type="hidden" name="poNumber" value={one.poNumber} />
          <p className="note">Against {one.poNumber} · {formatUsd(BigInt(one.remainingCents))} left to bill</p>
        </>
      ) : (
        <label>PO to bill
          <select name="poNumber" required>
            {pos.map((p) => <option key={p.poNumber} value={p.poNumber}>{p.poNumber} · {formatUsd(BigInt(p.remainingCents))} left</option>)}
          </select>
        </label>
      )}
      <label>Invoice number <input name="number" required maxLength={64} autoComplete="off" /></label>
      <label>Amount (USD) <input name="amount" inputMode="decimal" required maxLength={32} placeholder="4,000.00" autoComplete="off" /></label>
      <div className="pair">
        <label>Invoice date <input name="invoicedOn" type="date" required /></label>
        <label>Due date <input name="dueOn" type="date" required /></label>
      </div>
      <label>Link to the invoice file <input name="fileRef" type="url" maxLength={2000} placeholder="https://" aria-describedby="file-hint" /></label>
      <span className="note" id="file-hint">Optional. Paste a link; uploads aren’t supported yet.</span>
      <button type="submit">Submit invoice</button>
    </ActionForm>
  );
}
