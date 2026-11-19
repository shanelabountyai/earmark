import { notFound } from 'next/navigation';
import { actorEmails } from '@/core/audit';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Form as ActionForm } from '@/earmark/ui/form';
import { editRules } from '@/earmark/actions';
import { earmarkCan, rulesOf } from '@/earmark/core';
import { orgName } from '@/earmark/ui/org-name';
import { Card, PageHead, TableWrap } from '@/earmark/ui/kit';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Approval rules' };

type Step = { seat: string; fromCents: number | string };
type Json = { default?: Step[]; reallocation?: Step[]; overrides?: { when?: Record<string, string>; append?: Step[] }[]; [k: string]: unknown };
type Change = { chain: string; kind: string; seat: string | null; before: string | number | null; after: string | number | null };
const usd = (c: number | string | null) => (c === null ? '' : formatUsd(BigInt(String(c))));

// Demo step 5 (design: docs/design/Rules.dc.html): the approval chains as data (D-03). The rules stay a JSON textarea
// (D-24, owner call) with a read-only chain view beside it, read from the same JSON. Edits apply to requests submitted
// after; open requests keep the chain frozen at their submit. Who may change what is authorizeRuleEdit's call.
export default async function Rules({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();
  const editable = earmarkCan(ctx.role, 'rules.edit');

  const { json, edits } = await withOrg(ctx, async (tx) => ({
    json: (await rulesOf(tx, ctx)).json as unknown as Json,
    edits: await tx.auditEvent.findMany({ where: { ...inOrg(ctx), action: 'rules.edited' }, orderBy: { id: 'desc' }, take: 20 }),
  }));
  const emails = await actorEmails(edits.map((e) => e.actorUserId));
  const text = JSON.stringify(json, null, 2);
  const chain = (steps?: Step[]) => (steps ?? []).map((s) => `${s.seat} from ${usd(s.fromCents)}`).join(', ');

  return (
    <main className="stack">
      <PageHead
        eyebrow={`${await orgName(ctx.orgId)} · Settings · Rules`}
        title="Approval rules"
        lede="A threshold change is a data edit with an audit entry, never a deploy. Requests already submitted keep the chain they were given."
      />
      <div className="row">
        <Card id="chain-h" title={<>Default chain <span className="note" style={{ fontWeight: 500 }}>read from the JSON</span></>} className="narrow">
          <ol className="rules-chain" aria-label="Default chain">
            {(json.default ?? []).map((s, i) => (
              <li key={`${s.seat}-${i}`}><span aria-hidden="true" className="n">{i + 1}</span><strong>{s.seat}</strong><span className="from">from {usd(s.fromCents)}</span></li>
            ))}
          </ol>
          <p className="note">A request goes through every step whose threshold it reaches, in order.
            {(json.overrides ?? []).map((o, i) => <span key={i}> {Object.entries(o.when ?? {}).map(([k, v]) => `${k === 'costCenter' ? 'Cost center' : k} ${v}`).join(', ')} also adds {chain(o.append)}.</span>)}
            {json.reallocation && <> Reallocations use their own chain: {chain(json.reallocation)}.</>}
          </p>
          <p className="note"><em>Budget Owner</em> means the owner seat named on the request’s budget line. Admins edit thresholds below the top step. Only an owner edits the top step or adds and removes seats.</p>
        </Card>

        <section className="card wide form-stack">
          <h2>Rules JSON</h2>
          <p className="note">Thresholds are in cents: <code>1500000</code> is $15,000. A change applies to requests submitted after it.</p>
          {editable ? (
            <ActionForm action={editRules.bind(null, ctx.slug)}>
              <textarea className="mono" name="rules" defaultValue={text} rows={Math.min(text.split('\n').length + 2, 40)} maxLength={20_000} aria-label="Rules JSON" spellCheck={false} />
              <button type="submit">Save rules</button>
              <p className="note">Rules that don’t parse are refused, and nothing is saved.</p>
            </ActionForm>
          ) : <pre aria-label="Rules JSON">{text}</pre>}
        </section>
      </div>

      <Card id="ed-h" title="Rule edits">
        {edits.length === 0 ? <p className="note">No edits yet.</p> : (
          <TableWrap label="Rule edits">
            <table aria-label="Rule edits">
              <thead><tr><th scope="col">When (UTC)</th><th scope="col">By</th><th scope="col">Changes</th></tr></thead>
              <tbody>
                {edits.map((e) => {
                  const changes = (e.data as { changes?: Change[] } | null)?.changes;
                  return (
                    <tr key={e.id.toString()}>
                      <td style={{ whiteSpace: 'nowrap' }}>{e.at.toISOString().slice(0, 16).replace('T', ' ')}</td>
                      <td>{e.actorUserId ? (emails.get(e.actorUserId) ?? 'former user') : '—'}</td>
                      <td>
                        {Array.isArray(changes) ? (
                          <div className="diff">
                            {changes.map((c, i) => c.kind === 'threshold' ? (
                              <span key={i}><span className="minus"><span className="sr-only">Before: </span>− {c.chain} {c.seat} from {usd(c.before)}</span>{' '}<span className="plus"><span className="sr-only">After: </span>+ {c.chain} {c.seat} from {usd(c.after)}</span></span>
                            ) : (
                              <span key={i} className="other">{c.kind.replace('-', ' ')}{c.seat ? ` ${c.seat}` : ''} in {c.chain}{c.after !== null ? ` from ${usd(c.after)}` : ''}</span>
                            ))}
                          </div>
                        ) : <code>{JSON.stringify(e.data)}</code>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </main>
  );
}
