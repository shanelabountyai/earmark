// public: 404s unless DEMO_MODE, same-origin only (INV-27)
import { demoEnabled, demoSignIn } from '@/core/auth/demo';
import { setSessionCookie } from '@/core/auth/session';
import { isSameOrigin } from '@/core/http';
import { demoLanding } from '@/earmark/demo-landing';

export async function POST(req: Request) {
  if (!demoEnabled()) return new Response(null, { status: 404 });
  if (!isSameOrigin(req.headers)) return new Response(null, { status: 403 });
  const id = (await req.formData()).get('userId');
  const token = typeof id === 'string' ? await demoSignIn(id) : null;
  if (!token) return new Response(null, { status: 404 });
  await setSessionCookie(token);
  return Response.redirect(new URL(await demoLanding(String(id)), req.url), 303); // Earmark D-58: a one-org account lands in its org
}
