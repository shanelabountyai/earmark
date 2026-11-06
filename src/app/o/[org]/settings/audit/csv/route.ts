import { actorEmails, auditEvents, auditFilter, toCsv } from '@/core/audit';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';

export const dynamic = 'force-dynamic';

// F-01's Download CSV: the viewer's filter over the same query the data export uses (addendum §4, one exporter).
export async function GET(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org, 'audit.read');
  const f = await auditFilter(Object.fromEntries(new URL(req.url).searchParams));
  const rows = await withOrg(ctx, (tx) => auditEvents(tx, ctx.orgId, f), { atomic: false });
  const emails = await actorEmails(rows.map((r) => r.actorUserId));
  const csv = toCsv([
    ['id', 'at', 'actor', 'action', 'targetType', 'targetId', 'data'],
    ...rows.map((r) => [r.id, r.at, r.actorUserId ? (emails.get(r.actorUserId) ?? r.actorUserId) : 'system', r.action, r.targetType, r.targetId, r.data]),
  ]);
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${ctx.slug}-audit.csv"`, 'Cache-Control': 'no-store' },
  });
}
