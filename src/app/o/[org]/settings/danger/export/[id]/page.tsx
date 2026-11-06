import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';

export const metadata = { title: 'Data export' };

// The page the export email links to (addendum §5): sign-in and the owner role, never a bare file URL.
export default async function ExportPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.delete');
  const p = await params;
  const id = z.uuid().safeParse(p.id);
  if (!id.success) notFound();
  const e = await withOrg(ctx, (tx) => tx.orgExport.findFirst({ where: { id: id.data, orgId: ctx.orgId }, select: { status: true, bytes: true, sha256: true, expiresAt: true } }), { atomic: false });
  if (!e) notFound();
  return (
    <main>
      <h1>Data export</h1>
      {e.status === 'ready' ? (
        <>
          <p>
            <a href={`/o/${ctx.slug}/settings/danger/export/${p.id}/download`} download>Download the zip</a> ({Math.ceil((e.bytes ?? 0) / 1024)} KB). Available until{' '}
            {e.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.
          </p>
          <p>manifest.json sha256: <code>{e.sha256}</code></p>
        </>
      ) : e.status === 'too_large' ? (
        <p role="alert">This export is over 500 MB, so it was stopped. Contact support for a full copy.</p>
      ) : e.status === 'failed' ? (
        <p role="alert">This export failed. Request a new one from the previous page in an hour.</p>
      ) : (
        <p role="status">Being built. We will email you when it is ready; reload to check.</p>
      )}
    </main>
  );
}
