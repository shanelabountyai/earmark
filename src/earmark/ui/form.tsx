'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, useTransition } from 'react';

/**
 * Earmark's form for its own actions (D-52): the same contract as the template's ActionForm (shows the `{ error }` a
 * refused action returns, or its `{ notice }`, and disables itself while pending), but a refused submit keeps what the
 * person typed and picked. A form action resets the form after every submit (React 19), which on a refusal silently
 * moved a request to the first budget line and threw away a rules edit. Cleared only on success.
 *
 * A successful action may also return `open: { href, label }` (D-64): a link shown inside the notice, for the thing
 * the action just made. Only a path on this site is rendered.
 *
 * Accessibility (PRD-C C3, C4; review A1, A4, A5; D-81): the message is cleared when a submit starts and focus moves to
 * the new alert or status once the action settles (the disabled fieldset had dropped focus to the page body), so a
 * second identical refusal is a new alert and is read again. A refusal that starts with a field's label ("Amount must
 * be …", "Due date cannot …") marks that field `aria-invalid` and points its `aria-describedby` at the alert.
 */
/** The label's words before any "(USD)"-style aside: what a refusal names the field by. */
const labelHead = (el: Element) => ((el as HTMLInputElement).labels?.[0]?.textContent ?? '').replace(/\(.*$/, '').trim();

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
  const formRef = useRef<HTMLFormElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const alertId = useId();
  const error = state && typeof state === 'object' && 'error' in state ? String(state.error) : null;
  const notice = state && typeof state === 'object' && 'notice' in state ? String(state.notice) : null;
  const open = notice ? openLink(state) : null;

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    for (const el of form.querySelectorAll('[data-earmark-invalid]')) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('data-earmark-invalid');
      const rest = (el.getAttribute('aria-describedby') ?? '').split(' ').filter((x) => x && x !== alertId).join(' ');
      if (rest) el.setAttribute('aria-describedby', rest);
      else el.removeAttribute('aria-describedby');
    }
    if (error) {
      const field = [...form.elements].find((el) => el.matches('input, select, textarea') && labelHead(el) && error.startsWith(labelHead(el)));
      if (field) {
        field.setAttribute('aria-invalid', 'true');
        field.setAttribute('data-earmark-invalid', '');
        field.setAttribute('aria-describedby', [field.getAttribute('aria-describedby'), alertId].filter(Boolean).join(' '));
      }
    }
    if (error || notice) messageRef.current?.focus();
  }, [state, error, notice, alertId]);

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form, (e.nativeEvent as SubmitEvent).submitter);
        setState(null); // a repeated refusal is a new alert, read again (A4)
        start(async () => {
          const out = await action(data);
          setState(out);
          if (!(out && typeof out === 'object' && 'error' in out)) form.reset();
        });
      }}
    >
      {error && <p role="alert" id={alertId} ref={messageRef} tabIndex={-1}>{error}</p>}
      {notice && (
        <p role="status" ref={messageRef} tabIndex={-1}>
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
