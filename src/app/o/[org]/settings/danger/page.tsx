import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { destroyOrg, startExport } from './actions';

export const metadata = { title: 'Export or delete org' };

export default async function Danger({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.delete');
  const exports = await withOrg(ctx, (tx) => tx.orgExport.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, createdAt: true } }), { atomic: false });
  return (
    <main>
      <h1>Export this org</h1>
      <p>One zip of everything the org owns, as JSON Lines with a manifest. We email you a link when it is ready; it can be downloaded for 24 hours. Needs a sign-in within the last 5 minutes.</p>
      <ActionForm action={startExport.bind(null, ctx.slug)}>
        <button type="submit">Export data</button>
      </ActionForm>
      {exports.length > 0 && (
        <ul>
          {exports.map((e) => (
            <li key={e.id}>
              <Link href={`/o/${ctx.slug}/settings/danger/export/${e.id}`}>{e.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</Link>: {e.status}
            </li>
          ))}
        </ul>
      )}

      <h1>Delete this org</h1>
      <p>Every row the org owns is deleted, now and for good. The audit log keeps a record that it happened.</p>
      <ActionForm action={destroyOrg.bind(null, ctx.slug)}>
        <label>
          Type <code>{ctx.slug}</code> to confirm <input name="confirm" autoComplete="off" required />
        </label>
        <button type="submit">Delete org</button>
      </ActionForm>
    </main>
  );
}
