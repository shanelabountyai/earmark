// public: the demo webhook receiver (PRD §9 step 6); a 404 unless DEMO_MODE, and it only verifies a signature and answers
import { env } from '@/core/env';
import { log } from '@/core/log';
import { demoReceiverSecret } from '@/earmark/demo-receiver';
import { SIGNATURE_HEADER, verifySignature } from '@/modules/apikeys/webhooks';

export const dynamic = 'force-dynamic';

/** The answer lands in the delivery's response excerpt, which is what the settings page and step 6 read back. */
export async function POST(req: Request) {
  if (env.DEMO_MODE !== '1') return new Response('Not found', { status: 404 });
  const body = await req.text();
  if (!verifySignature(demoReceiverSecret(), req.headers.get(SIGNATURE_HEADER), body)) return Response.json({ verified: false }, { status: 401 });
  const { id, type } = JSON.parse(body) as { id: string; type: string };
  log('demo.webhook_received', { id, type });
  return Response.json({ received: id, type, verified: true });
}
