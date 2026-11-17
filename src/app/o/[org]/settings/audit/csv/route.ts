import { auditCsv, auditFilter } from '@/core/audit';
import { requireOrg } from '@/core/authz/guards';

export const dynamic = 'force-dynamic';

// F-01's Download CSV (core/audit.ts auditCsv: capped at 10,000 newest events and audited, v1.6.5).
export async function GET(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org, 'audit.read');
  const csv = await auditCsv(ctx, await auditFilter(Object.fromEntries(new URL(req.url).searchParams)));
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${ctx.slug}-audit.csv"`, 'Cache-Control': 'no-store' },
  });
}
