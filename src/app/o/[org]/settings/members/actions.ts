'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import type { OrgCtx } from '@/core/authz/guards';
import { createInvite, revokeInvite } from '@/core/tenancy/invites';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { onMembershipEnded } from '@/app/org-hooks';
import { Role } from '@/generated/prisma/enums';

// Thin calls into core/tenancy (D-12), where the role rules (D-11) and the last-owner rule live.
const back = (ctx: OrgCtx) => redirect(`/o/${ctx.slug}/settings/members`);
const role = z.enum(Role);

export const inviteMember = orgAction('members.manage', z.object({ email: z.string(), role }), async (ctx, i) => {
  await createInvite(ctx, i.email, i.role);
  back(ctx);
});

export const cancelInvite = orgAction('members.manage', z.object({ id: ref('invite') }), async (ctx, { id }) => {
  await revokeInvite(ctx, id);
  back(ctx);
});

export const setRole = orgAction('members.manage', z.object({ userId: ref('member'), role }), async (ctx, i) => {
  await changeRole(ctx, i.userId, i.role);
  back(ctx);
});

export const removeFromOrg = orgAction('members.manage', z.object({ userId: ref('member') }), async (ctx, { userId }) => {
  await removeMember(ctx, userId, onMembershipEnded);
  back(ctx);
});

export const leaveOrg = orgAction(null, z.object({}), async (ctx) => {
  await removeMember(ctx, ctx.userId, onMembershipEnded);
  redirect('/onboarding');
});
