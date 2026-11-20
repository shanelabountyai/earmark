'use client';
import Link from 'next/link';
import { useState, useTransition } from 'react';

/**
 * Earmark's form for its own actions (D-52): the same contract as the template's ActionForm (shows the `{ error }` a
 * refused action returns, or its `{ notice }`, and disables itself while pending), but a refused submit keeps what the
 * person typed and picked. A form action resets the form after every submit (React 19), which on a refusal silently
 * moved a request to the first budget line and threw away a rules edit. Cleared only on success.
 *
 * A successful action may also return `open: { href, label }` (D-64): a link shown inside the notice, for the thing
 * the action just made. Only a path on this site is rendered.
 */
function openLink(state: unknown): { href: string; label: string } | null {
  if (!state || typeof state !== 'object' || !('open' in state)) return null;
  const o = state.open;
  if (!o || typeof o !== 'object' || !('href' in o) || !('label' in o)) return null;
  const { href, label } = o;
  if (typeof href !== 'string' || typeof label !== 'string' || !/^\/(?!\/)/.test(href) || !label) return null;
  return { href, label };
}

export function Form({ action, children }: { action: (form: FormData) => Promise<unknown>; children: React.ReactNode }) {
  const [state, setState] = useState<unknown>(null);
  const [pending, start] = useTransition();
  const error = state && typeof state === 'object' && 'error' in state ? String(state.error) : null;
  const notice = state && typeof state === 'object' && 'notice' in state ? String(state.notice) : null;
  const open = notice ? openLink(state) : null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form, (e.nativeEvent as SubmitEvent).submitter);
        start(async () => {
          const out = await action(data);
          setState(out);
          if (!(out && typeof out === 'object' && 'error' in out)) form.reset();
        });
      }}
    >
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p role="status">
          {notice}
          {open && (
            <>
              {' '}
              <Link href={open.href} style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline' }}>
                {open.label}
              </Link>
            </>
          )}
        </p>
      )}
      <fieldset disabled={pending} style={{ border: 0, margin: 0, padding: 0 }}>
        {children}
      </fieldset>
    </form>
  );
}
