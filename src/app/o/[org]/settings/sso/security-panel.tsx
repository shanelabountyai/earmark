import Link from 'next/link';
import type { OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { setSsoRequired } from './actions';

// The SSO part of /o/[org]/settings/security (addendum §4): status for owners and admins, and the Require SSO switch,
// moved here from the SSO page. The switch is the owner's alone (setRequired checks it too). Goes with the module.
export async function SsoSecurityPanel({ ctx }: { ctx: OrgCtx }) {
  const c = await withOrg(ctx, (tx) => tx.ssoConnection.findUnique({ where: { orgId: ctx.orgId }, select: { enabledAt: true, required: true } }), { atomic: false });
  return (
    <>
      <h2>Single sign-on</h2>
      <p>
        {!c ? 'Not set up.' : c.enabledAt ? `On. Required: ${c.required ? 'yes' : 'no'}.` : 'Set up, but off.'}
        {ctx.role === 'owner' && <> <Link href={`/o/${ctx.slug}/settings/sso`}>SSO settings</Link></>}
      </p>
      {ctx.role === 'owner' && c?.enabledAt && (
        <ActionForm action={setSsoRequired.bind(null, ctx.slug)}>
          <p>When SSO is required, members cannot use an email sign-in link. You keep yours for 24 hours, in case the provider is misconfigured.</p>
          <input type="hidden" name="on" value={c.required ? '0' : '1'} />
          <button type="submit">{c.required ? 'Stop requiring SSO' : 'Require SSO'}</button>
        </ActionForm>
      )}
    </>
  );
}
