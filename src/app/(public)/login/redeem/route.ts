// public: the token is the credential; same-origin POST (INV-17)
import '@/app/modules'; // registers the sso module's hooks with core (INV-36)
import { redeemLink } from '@/core/auth/link';
import { setSessionCookie } from '@/core/auth/session';
import { isSameOrigin } from '@/core/http';

// POST-to-spend (INV-17): the emailed GET only renders a button that posts here.
export async function POST(req: Request) {
  if (!isSameOrigin(req.headers)) return new Response(null, { status: 403 });
  const token = (await req.formData()).get('token');
  const session = typeof token === 'string' ? await redeemLink(token) : null;
  if (!session) return Response.redirect(new URL('/login?expired=1', req.url), 303);
  await setSessionCookie(session);
  return Response.redirect(new URL('/onboarding', req.url), 303);
}
