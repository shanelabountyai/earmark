// public: starts an SSO sign-in; rate-limited per IP (INV-09). Test mode checks for an owner itself.
import { requireOrg } from '@/core/authz/guards';
import { clientIp } from '@/core/http';
import { startSso } from '@/modules/sso/flow';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const org = q.get('org') ?? '';
  const test = q.get('test') === '1';
  if (test && (await requireOrg(org, 'org.update')).role !== 'owner') return new Response('Not found', { status: 404 });
  const url = await startSso(org, { ip: clientIp(req.headers), hint: q.get('hint') ?? undefined, test });
  return url ? Response.redirect(url, 303) : new Response('Not found', { status: 404 });
}
