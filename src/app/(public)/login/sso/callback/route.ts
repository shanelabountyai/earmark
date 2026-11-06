// public: the provider's redirect; the state cookie plus the single-use state row are the credential (INV-37)
import { setSessionCookie } from '@/core/auth/session';
import { finishSso } from '@/modules/sso/flow';

// A route handler, like /login/redeem, so INV-01 keeps no exemptions. Every refusal is the same 404 (addendum §3 step 4).
export async function GET(req: Request) {
  const done = await finishSso(new URL(req.url).searchParams);
  if (!done) return new Response('Not found', { status: 404 });
  if (done.kind === 'test') return Response.redirect(new URL(`/o/${done.slug}/settings/sso?test=${encodeURIComponent(done.result)}`, req.url), 303);
  await setSessionCookie(done.token);
  return Response.redirect(new URL('/onboarding', req.url), 303);
}
