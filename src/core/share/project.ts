import { withOrg } from '@/core/db/rls';
import type { Project } from '@/generated/prisma/client';

// The example shareable resource (spec §7c). The projection starts empty and each public field
// is opted in by name, so a column added to Project later stays private until someone adds it here.
export type PublicProject = { name: string };

export const blankPublicProject = (): PublicProject => ({ name: '' });

export function toPublicProject(row: Project): PublicProject {
  return { ...blankPublicProject(), name: row.name };
}

/** Loads by the share link's own org, never by an id alone. */
export async function loadPublicProject(orgId: string, id: string) {
  const row = await withOrg({ orgId }, (tx) => tx.project.findFirst({ where: { id, orgId } }), { atomic: false });
  return row && toPublicProject(row);
}
