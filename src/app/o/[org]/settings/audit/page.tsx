import Link from 'next/link';
import { actorEmails, AUDIT_PAGE, auditEvents, auditFilter } from '@/core/audit';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';

export const metadata = { title: 'Audit log' };

type Q = Record<string, string | string[] | undefined>;

// F-01 (addendum §4). Read-only: the trigger refuses UPDATE and DELETE (INV-19) and nothing here offers either.
export default async function AuditLog({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Q> }) {
  const ctx = await requireOrg((await params).org, 'audit.read');
  const q = await searchParams;
  const f = await auditFilter(q);
  const before = typeof q.before === 'string' && /^\d+$/.test(q.before) ? BigInt(q.before) : undefined;
  const rows = await withOrg(ctx, (tx) => auditEvents(tx, ctx.orgId, f, { before, take: AUDIT_PAGE + 1 }), { atomic: false });
  const more = rows.length > AUDIT_PAGE;
  const page = rows.slice(0, AUDIT_PAGE);
  const emails = await actorEmails(page.map((r) => r.actorUserId));
  const kept = Object.fromEntries(['actor', 'action', 'from', 'to'].flatMap((k) => (typeof q[k] === 'string' && q[k] ? [[k, q[k] as string]] : [])));
  const base = `/o/${ctx.slug}/settings/audit`;
  return (
    <main>
      <h1>Audit log</h1>
      <form method="get">
        <label>Actor email <input name="actor" type="email" defaultValue={kept.actor} /></label>{' '}
        <label>Action <input name="action" defaultValue={kept.action} placeholder="member." /></label>{' '}
        <label>From <input name="from" type="date" defaultValue={kept.from} /></label>{' '}
        <label>To <input name="to" type="date" defaultValue={kept.to} /></label>{' '}
        <button type="submit">Filter</button> <Link href={base}>Clear</Link>
      </form>
      <p>
        <a href={`${base}/csv?${new URLSearchParams(kept)}`} download>Download CSV</a> (every event matching the filter)
      </p>
      {page.length === 0 ? (
        <p>No events match.</p>
      ) : (
        <table>
          <thead>
            <tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr>
          </thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.id.toString()}>
                <td>{r.at.toISOString().slice(0, 19).replace('T', ' ')}</td>
                <td>{r.actorUserId ? (emails.get(r.actorUserId) ?? 'deleted user') : 'system'}</td>
                <td><code>{r.action}</code></td>
                <td>{r.targetType ? `${r.targetType} ${r.targetId ?? ''}` : ''}</td>
                <td>{r.data != null && <details><summary>meta</summary><pre>{JSON.stringify(r.data, null, 2)}</pre></details>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {more && <p><Link href={`${base}?${new URLSearchParams({ ...kept, before: page.at(-1)!.id.toString() })}`}>Older events</Link></p>}
    </main>
  );
}
