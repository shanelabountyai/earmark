import Link from 'next/link';
import { listSessions, requireUser } from '@/core/auth/session';
import { pendingEnrolment } from '@/core/auth/totp';
import { ActionForm } from '@/core/ui/action-form';
import { changeEmail, deleteMyAccount, signOutAll, signOutHere, signOutSession, startEnrol, turnOffTotp } from './actions';
import { ConfirmForm } from './confirm-form';

export const metadata = { title: 'Security' };

export default async function Security({ searchParams }: { searchParams: Promise<{ mfa?: string; email?: string }> }) {
  const s = await requireUser();
  const [pending, sessions] = await Promise.all([pendingEnrolment(s), listSessions(s)]);
  const q = await searchParams;
  return (
    <main>
      <h1>Security</h1>
      <p>Signed in as {s.email} · <Link href="/onboarding">Your orgs</Link></p>
      {q.mfa === 'required' && !s.totpEnrolled && <p role="alert">Owners and admins must turn on two-factor sign-in before opening their org.</p>}
      {q.email === 'sent' && <p role="status">Check the new address for a confirmation link.</p>}
      {q.email === 'changed' && <p role="status">Your email address was changed. Other devices were signed out.</p>}

      <h2>Two-factor sign-in</h2>
      {/* Always mounted at this spot: confirming deletes the pending cookie, which refreshes the page,
          and the recovery codes live in this component's state. Unmounted, they would never be seen. */}
      <ConfirmForm pending={!!pending} />
      {pending ? (
        <>
          <p>Add this key to your authenticator app, then enter the code it shows.</p>
          <p><code data-testid="totp-secret">{pending.secret}</code></p>
          <p><a href={pending.uri}>Open in authenticator app</a></p>
        </>
      ) : (
        <>
          <p>{s.totpEnrolled ? 'On.' : 'Off.'}</p>
          <ActionForm action={startEnrol}>
            <button type="submit">{s.totpEnrolled ? 'Move to a new device' : 'Turn on'}</button>
          </ActionForm>
          {s.totpEnrolled && (
            <ActionForm action={turnOffTotp}>
              <button type="submit">Turn off</button>
            </ActionForm>
          )}
        </>
      )}

      <h2>Email address</h2>
      <ActionForm action={changeEmail}>
        <label>
          New email <input name="email" type="email" required />
        </label>
        <button type="submit">Send confirmation link</button>
      </ActionForm>

      <h2>Sessions</h2>
      <table>
        <thead>
          <tr><th>Signed in (UTC)</th><th>Last seen</th><th>Where</th><th>How</th><th></th></tr>
        </thead>
        <tbody>
          {sessions.map((x) => (
            <tr key={x.hash}>
              <td>{x.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>{x.lastSeenAt ? x.lastSeenAt.toISOString().slice(0, 16).replace('T', ' ') : ''}</td>
              <td>{x.country ?? 'unknown'}</td>
              <td>{x.method}</td>
              <td>
                {x.current ? (
                  <strong>This session</strong>
                ) : (
                  <ActionForm action={signOutSession}>
                    <input type="hidden" name="hash" value={x.hash} />
                    <button type="submit">Sign out</button>
                  </ActionForm>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ActionForm action={signOutHere}>
        <button type="submit">Sign out</button>
      </ActionForm>
      <ActionForm action={signOutAll}>
        <button type="submit">Sign out everywhere</button>
      </ActionForm>

      <h2>Delete account</h2>
      <p>This cannot be undone. You cannot delete your account while you are the only owner of an org.</p>
      <ActionForm action={deleteMyAccount}>
        <label>
          Type your email to confirm <input name="confirm" autoComplete="off" required />
        </label>
        <button type="submit">Delete my account</button>
      </ActionForm>
    </main>
  );
}
