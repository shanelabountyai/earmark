import Link from 'next/link';
import { requireUser } from '@/core/auth/session';
import { asSystem } from '@/core/db/rls';
import { pendingInvitesFor } from '@/core/tenancy/invites';
import { keepListedOrgs } from '@/core/tenancy/listed';
import { ActionForm } from '@/core/ui/action-form';
import { filterListedOrgs } from '@/app/org-hooks';
import { startOrg } from './actions';

export const metadata = { title: 'Your orgs' };

// Where every sign-in lands: the user's orgs (less any the clone's `filterListedOrgs` hides), invites waiting
// for them, and creating an org.
export default async function Onboarding() {
  const s = await requireUser();
  const [all, invites] = await Promise.all([
    // Cross-org (cross-org.ts): the user's memberships in every org.
    asSystem((sys) => sys.membership.findMany({ where: { userId: s.userId }, select: { role: true, org: { select: { id: true, slug: true, name: true } } }, orderBy: { createdAt: 'asc' } })),
    pendingInvitesFor(s),
  ]);
  const memberships = await keepListedOrgs(s.userId, all, filterListedOrgs);
  return (
    <main>
      <h1>Your orgs</h1>
      <p>Signed in as {s.email} · <Link href="/account/security">Account</Link></p>
      {memberships.length > 0 ? (
        <ul>
          {memberships.map((m) => (
            <li key={m.org.slug}><Link href={`/o/${m.org.slug}`}>{m.org.name}</Link> ({m.role})</li>
          ))}
        </ul>
      ) : (
        <p>You are not in an org yet. Create one, or open the invite link someone sent you.</p>
      )}
      {invites.length > 0 && (
        <>
          <h2>Invitations</h2>
          <ul>{invites.map((i) => <li key={i.id}>{i.org.name} ({i.role})</li>)}</ul>
          <p>To join, open the link in your invite email.</p>
        </>
      )}
      <h2>Create an org</h2>
      <ActionForm action={startOrg}>
        <label>
          Org name <input name="name" required maxLength={80} />
        </label>
        <button type="submit">Create org</button>
      </ActionForm>
    </main>
  );
}
