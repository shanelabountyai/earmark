import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireOrg } from '@/core/authz/guards';
import { downloadExport } from '@/core/tenancy/export';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.delete');
  const p = await params;
  const id = z.uuid().safeParse(p.id);
  const e = id.success ? await downloadExport(ctx, id.data) : null;
  if (!e) notFound();
  const name = `${ctx.slug}-export-${e.createdAt.toISOString().slice(0, 10)}.zip`;
  return new Response(new Uint8Array(e.archive), {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
  });
}
