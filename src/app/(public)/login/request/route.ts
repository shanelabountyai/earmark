// public: sends a link; rate-limited (INV-09)
import '@/app/modules'; // registers the sso module's hooks with core
import { normalizeEmail, requestLink } from '@/core/auth/link';
import { resolveSso } from '@/core/auth/sso-hook';
import { clientIp, isSameOrigin } from '@/core/http';

export async function POST(req: Request) {
  if (!isSameOrigin(req.headers)) return new Response(null, { status: 403 });
  const input = (await req.formData()).get('email');
  const email = typeof input === 'string' ? input : '';
  // Addendum §3 step 1: an email on an org's verified SSO domain goes to that org's provider. This says the domain
  // uses SSO, never whether the address has an account (D-10).
  const normalized = normalizeEmail(email);
  const slug = normalized ? await resolveSso(normalized) : null;
  if (slug) return Response.redirect(new URL(`/login/sso/start?${new URLSearchParams({ org: slug, hint: normalized! })}`, req.url), 303);
  await requestLink(email, clientIp(req.headers));
  return Response.redirect(new URL('/login?sent=1', req.url), 303);
}
