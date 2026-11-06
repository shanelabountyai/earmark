import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { Role } from '@/generated/prisma/enums';
import { callbackUrl } from '@/modules/sso/flow';
import { txtName, txtValue } from '@/modules/sso/settings';
import { addSsoDomain, removeSsoDomain, saveSsoConnection, setSsoEnabled, verifySsoDomain } from './actions';

export const metadata = { title: 'Single sign-on' };

// What the owner's Test sign-in found (src/modules/sso/flow.ts). Nothing here is shown to anyone signing in.
const TEST_RESULT: Record<string, string> = {
  ok: 'Test sign-in worked. The provider did not report MFA, so owners and admins will still use TOTP.',
  'ok-mfa': 'Test sign-in worked, and the provider reported MFA.',
  token: 'Test sign-in failed: the provider refused the code or the ID token did not check out (issuer, client ID, secret or redirect URI).',
  email_unverified: 'Test sign-in failed: the provider did not say the email address is verified.',
  hd: 'Test sign-in failed: the Google account is not in this Workspace domain (hd).',
  domain: "Test sign-in failed: the email's domain is not one of this org's verified domains.",
};

export default async function Sso({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ test?: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.update');
  if (ctx.role !== 'owner') notFound();
  const [[c, domains], { test }] = await Promise.all([
    withOrg(ctx, (tx) => Promise.all([tx.ssoConnection.findUnique({ where: { orgId: ctx.orgId } }), tx.ssoDomain.findMany({ where: { orgId: ctx.orgId }, orderBy: { domain: 'asc' } })]), { atomic: false }),
    searchParams,
  ]);
  const slug = ctx.slug;

  return (
    <main>
      <h1>Single sign-on</h1>
      {test && <p role="status">{TEST_RESULT[test] ?? 'Test sign-in finished.'}</p>}
      <p>
        Members whose email is on a verified domain sign in through your identity provider (OIDC). In the provider, set the redirect URI to <code>{callbackUrl()}</code>.
      </p>

      <h2>Connection</h2>
      <ActionForm action={saveSsoConnection.bind(null, slug)}>
        <label>
          Issuer URL <input name="issuer" type="url" required defaultValue={c?.issuer ?? ''} placeholder="https://example.okta.com/oauth2/default" />
        </label>
        <label>
          Client ID <input name="clientId" required defaultValue={c?.clientId ?? ''} autoComplete="off" />
        </label>
        <label>
          Client secret <input name="clientSecret" type="password" autoComplete="off" required={!c} placeholder={c ? 'unchanged' : ''} />
        </label>
        <label>
          Join automatically from these domains <input name="allowedDomains" defaultValue={c?.allowedDomains.join(', ') ?? ''} placeholder="example.com" />
        </label>
        <p>Leave empty for invite-only: a person then needs a pending invite before their first sign-in.</p>
        <label>
          New members join as{' '}
          <select name="defaultRole" defaultValue={c?.defaultRole ?? 'member'}>
            {Object.values(Role).filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <button type="submit">Save connection</button>
      </ActionForm>

      {c && (
        <>
          <p>
            Status: <strong>{c.enabledAt ? 'on' : 'off'}</strong>.{' '}
            <a href={`/login/sso/start?${new URLSearchParams({ org: slug, test: '1' })}`} target="_blank" rel="noopener">
              Test sign-in
            </a>{' '}
            (opens the provider; no one is signed in).
          </p>
          <ActionForm action={setSsoEnabled.bind(null, slug)}>
            <input type="hidden" name="on" value={c.enabledAt ? '0' : '1'} />
            <button type="submit">{c.enabledAt ? 'Turn SSO off' : 'Turn SSO on'}</button>
          </ActionForm>
          {c.enabledAt && (
            <p>
              Require SSO: <strong>{c.required ? 'yes' : 'no'}</strong>. The switch is on the <Link href={`/o/${slug}/settings/security`}>Security</Link> page.
            </p>
          )}
        </>
      )}

      <h2>Domains</h2>
      <ul>
        {domains.map((d) => (
          <li key={d.id}>
            <strong>{d.domain}</strong> {d.verifiedAt ? '(verified)' : '(not verified)'}
            {!d.verifiedAt && (
              <>
                <p>
                  Add a TXT record named <code>{txtName(d.domain)}</code> with the value <code>{txtValue(ctx.orgId, d.domain)}</code>, then verify.
                </p>
                <ActionForm action={verifySsoDomain.bind(null, slug)}>
                  <input type="hidden" name="id" value={d.id} />
                  <button type="submit">Verify</button>
                </ActionForm>
              </>
            )}
            <ActionForm action={removeSsoDomain.bind(null, slug)}>
              <input type="hidden" name="id" value={d.id} />
              <button type="submit">Remove</button>
            </ActionForm>
          </li>
        ))}
      </ul>
      <ActionForm action={addSsoDomain.bind(null, slug)}>
        <label>
          Domain <input name="domain" required placeholder="example.com" />
        </label>
        <button type="submit">Add domain</button>
      </ActionForm>
    </main>
  );
}
