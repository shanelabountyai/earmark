'use server';
import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction } from '@/core/authz/action';
import { deleteOrg } from '@/core/tenancy/delete';
import { buildExport, requestExport } from '@/core/tenancy/export';
import { exportTables } from '@/app/export-hooks';
import { beforeOrgDelete } from '@/app/org-hooks';

export const destroyOrg = orgAction('org.delete', z.object({ confirm: z.string() }), async (ctx, { confirm }) => {
  await deleteOrg(ctx, confirm, beforeOrgDelete);
  redirect('/onboarding');
});

// Owner only (org.delete is the owner's alone). Built after the response; /api/cron builds any that did not finish.
export const startExport = orgAction('org.delete', z.object({}), async (ctx) => {
  const id = await requestExport(ctx);
  after(() => buildExport({ orgId: ctx.orgId }, id, exportTables));
  redirect(`/o/${ctx.slug}/settings/danger/export/${id}`);
});
