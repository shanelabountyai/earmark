import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ReauthRequired } from '@/core/auth/session';
import { requireOrg } from '@/core/authz/guards';
import { downloadExport } from '@/core/tenancy/export';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.delete');
  const p = await params;
  const id = z.uuid().safeParse(p.id);
  let e: Awaited<ReturnType<typeof downloadExport>> = null;
  try {
    e = id.success ? await downloadExport(ctx, id.data) : null;
  } catch (err) {
    // v1.6.5 (A-10): a stale session is told to sign in again, with the page to come back to; nothing is sent.
    if (err instanceof ReauthRequired) return new Response(`${err.message}\n`, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    throw err;
  }
  if (!e) notFound();
  const name = `${ctx.slug}-export-${e.createdAt.toISOString().slice(0, 10)}.zip`;
  return new Response(new Uint8Array(e.archive), {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
  });
}
