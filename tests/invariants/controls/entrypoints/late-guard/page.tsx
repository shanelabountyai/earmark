// Control (FR-06): reads before it guards.
import { requireOrg } from '@/core/authz/guards';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export default async function Late({ params }: { params: Promise<{ org: string }> }) {
  const rows = await db.project.findMany();
  await requireOrg((await params).org);
  return <main>{rows.length}</main>;
}
