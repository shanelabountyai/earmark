import { notFound } from 'next/navigation';
import { actorEmails } from '@/core/audit';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { editRules } from '@/earmark/actions';
import { earmarkCan, rulesOf } from '@/earmark/core';

export const metadata = { title: 'Approval rules' };

// Demo step 5: the approval chains as data (D-03). Edits apply to requests submitted after; open requests keep the
// chain frozen at their submit. Who may change what is authorizeRuleEdit's call; each edit's diff is in the audit.
export default async function Rules({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();
  const editable = earmarkCan(ctx.role, 'rules.edit');

  const { json, edits } = await withOrg(ctx, async (tx) => ({
    json: (await rulesOf(tx, ctx)).json,
    edits: await tx.auditEvent.findMany({ where: { ...inOrg(ctx), action: 'rules.edited' }, orderBy: { id: 'desc' }, take: 20 }),
  }));
  const emails = await actorEmails(edits.map((e) => e.actorUserId));
  const text = JSON.stringify(json, null, 2);

  return (
    <main>
      <h1>Approval rules</h1>
      <p>Thresholds are in cents: <code>1500000</code> is $15,000. A change applies to requests submitted after it.</p>
      {editable ? (
        <ActionForm action={editRules.bind(null, ctx.slug)}>
          <textarea name="rules" defaultValue={text} rows={text.split('\n').length + 2} cols={80} maxLength={20_000} aria-label="Rules JSON" spellCheck={false} />
          <br />
          <button type="submit">Save rules</button>
        </ActionForm>
      ) : <pre>{text}</pre>}

      <h2>Edits</h2>
      {edits.length === 0 ? <p>No edits yet.</p> : (
        <table aria-label="Rule edits">
          <thead><tr><th>When (UTC)</th><th>By</th><th>Changes</th></tr></thead>
          <tbody>
            {edits.map((e) => (
              <tr key={e.id.toString()}>
                <td>{e.at.toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td>{e.actorUserId ? (emails.get(e.actorUserId) ?? 'former user') : '—'}</td>
                <td><code>{JSON.stringify((e.data as { changes?: unknown } | null)?.changes ?? e.data)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
