// public: 404s unless DEMO_MODE (INV-27)
// Earmark override (PRD-B B2, Shane's decisions 3 (c) and 4 (b), D-75): the README's six walk accounts as cards, Start
// here on the owner, every other seeded account under a fold. The data, the form and the /demo/signin route are the
// template's, unchanged. Listed in FOUNDATION_PATCHES.md; proposed upstream as a clone hook for the demo account list.
import { notFound } from 'next/navigation';
import { demoEnabled, listDemoUsers } from '@/core/auth/demo';
import { keepListedOrgs } from '@/core/tenancy/listed';
import { filterListedOrgs } from '@/app/org-hooks';
import { WALK_ACCOUNTS } from '@/earmark/demo-accounts';

export const metadata = { title: 'Demo sign-in' };
export const dynamic = 'force-dynamic';

function SignIn({ userId, email, primary, orgs }: { userId: string; email: string; primary?: boolean; orgs?: string }) {
  return (
    <form method="post" action="/demo/signin" style={{ margin: 0 }}>
      <input type="hidden" name="userId" value={userId} />
      <button type="submit" className={primary ? undefined : 'btn-secondary'}>{email}</button>{orgs !== undefined && <> {orgs}</>}
    </form>
  );
}

export default async function Demo() {
  if (!demoEnabled()) notFound();
  // Each account's orgs go through the clone's `filterListedOrgs`, as on /onboarding.
  const users = await Promise.all((await listDemoUsers()).map(async (u) => ({ ...u, memberships: await keepListedOrgs(u.id, u.memberships, filterListedOrgs) })));
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const walk = WALK_ACCOUNTS.flatMap((a) => (byEmail.has(a.email) ? [{ ...a, user: byEmail.get(a.email)! }] : []));
  const rest = users.filter((u) => !WALK_ACCOUNTS.some((a) => a.email === u.email));
  return (
    <main className="stack" style={{ maxWidth: '52rem' }}>
      <p className="eyebrow"><span aria-hidden="true" className="logo on-paper" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />Earmark demo</p>
      <h1>Demo sign-in</h1>
      <p className="lede" style={{ color: 'var(--muted)', fontSize: 18, margin: 0 }}>
        Pick an account to sign in; no email or password. The README&rsquo;s five-minute walk uses these six, in this order. Everything is invented, and the demo is replanted every night.
      </p>
      {users.length === 0 && <p role="status">No demo users yet. Run <code>npm run seed:demo</code>.</p>}
      {walk.length > 0 && (
        <ol aria-label="Accounts for the walk" className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 12 }}>
          {walk.map((a) => (
            <li key={a.email} className="card" style={{ gap: 8 }}>
              {a.start && <p className="eyebrow" style={{ margin: 0 }}>Start here</p>}
              <SignIn userId={a.user.id} email={a.email} primary={a.start} />
              <p style={{ margin: 0 }}>{a.who}</p>
              <p className="note" style={{ margin: 0 }}>{a.steps}</p>
            </li>
          ))}
        </ol>
      )}
      {rest.length > 0 && (
        <details className="card">
          <summary>Every other seeded account ({rest.length})</summary>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rest.map((u) => (
              <li key={u.id}>
                <SignIn userId={u.id} email={u.email} orgs={u.memberships.map((m) => `${m.role} of ${m.org.name}`).join(', ')} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
