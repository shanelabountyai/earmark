'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { audit } from '@/core/audit';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { emit } from '@/core/events';
import { createShareLink, revokeShareLink } from '@/core/share/links';

// The example resource and its share links (spec §7c). A clone replaces Project with its own.
const page = (ctx: OrgCtx) => `/o/${ctx.slug}/projects`;

export const addProject = orgAction(
  null,
  z.object({ name: z.string().trim().min(1, 'Give the project a name.').max(120), notes: z.string().max(2000).default('') }),
  async (ctx, i) => {
    await withOrg(ctx, async (tx) => {
      const p = await tx.project.create({ data: { ...inOrg(ctx), name: i.name, notes: i.notes } });
      await audit(ctx, 'project.created', { targetType: 'project', targetId: p.id }, tx);
      await emit(ctx, 'project.created', { project: { id: p.id, name: p.name, createdAt: p.createdAt.toISOString() } }, tx); // never notes (INV-08)
    });
    redirect(page(ctx));
  },
);

export const shareProject = orgAction('share.create', z.object({ id: ref('project'), days: z.enum(['1', '7', '30']) }), async (ctx, i) => {
  const url = await createShareLink(ctx, 'project', i.id, Number(i.days));
  revalidatePath(page(ctx));
  return { notice: url }; // the raw token exists only in this response
});

export const revokeShare = orgAction('share.revoke', z.object({ id: ref('shareLink') }), async (ctx, { id }) => {
  await revokeShareLink(ctx, id);
  redirect(page(ctx));
});
