'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requestEmailChange } from '@/core/auth/link';
import { assertNotDemo, revokeSession, signOut, signOutEverywhere } from '@/core/auth/session';
import { confirmTotp, disableTotp, enrolTotp } from '@/core/auth/totp';
import { userAction } from '@/core/authz/action';
import { deleteAccount } from '@/core/tenancy/delete';
import { onMembershipEnded } from '@/app/org-hooks';

// Thin calls into core (D-12). A refusal (stale sign-in, owner turning TOTP off) comes back as { error }.
const none = z.object({});

export const startEnrol = userAction(none, async () => {
  await enrolTotp();
  redirect('/account/security');
});

export const finishEnrol = userAction(z.object({ code: z.string() }), async (_, { code }) => {
  const codes = await confirmTotp(code);
  return codes ? { codes } : { error: 'That code did not match. Try the next one from your app.' };
});

export const turnOffTotp = userAction(none, async () => {
  await disableTotp();
  redirect('/account/security');
});

export const signOutHere = userAction(none, async () => {
  await signOut();
  redirect('/');
});

export const signOutSession = userAction(z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }), async (s, { hash }) => {
  await revokeSession(s, hash);
  redirect('/account/security');
});

export const signOutAll = userAction(none, async (s) => {
  assertNotDemo(s); // every /demo visitor shares the account: this would sign them all out
  await signOutEverywhere(s.userId);
  redirect('/');
});

export const changeEmail = userAction(z.object({ email: z.string() }), async (s, { email }) => {
  await requestEmailChange(s, email);
  redirect('/account/security?email=sent');
});

export const deleteMyAccount = userAction(z.object({ confirm: z.string() }), async (s, { confirm }) => {
  await deleteAccount(s, confirm, onMembershipEnded);
  redirect('/');
});
