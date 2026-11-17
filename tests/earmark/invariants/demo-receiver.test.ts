// Phase 4 item 3 (D-31): the demo webhook receiver verifies the signature with its own secret, and is a 404 off demo.
import { afterEach, expect, it } from 'vitest';
import { env } from '@/core/env';
import { POST } from '@/app/api/demo/webhook/route';
import { demoReceiverSecret } from '@/earmark/demo-receiver';
import { SIGNATURE_HEADER, signatureHeader } from '@/modules/apikeys/webhooks';

const was = env.DEMO_MODE; // .env.test sets it
afterEach(() => { env.DEMO_MODE = was; });

const body = JSON.stringify({ id: 'evt-1', type: 'commitment.issued' });
const send = (secret: string) =>
  POST(new Request('http://app.test/api/demo/webhook', { method: 'POST', headers: { [SIGNATURE_HEADER]: signatureHeader([secret], Math.floor(Date.now() / 1000), body) }, body }));

it('answers 200 to its own secret, 401 to any other, and 404 outside DEMO_MODE', async () => {
  env.DEMO_MODE = undefined;
  expect((await send(demoReceiverSecret())).status).toBe(404);
  env.DEMO_MODE = '1';
  const ok = await send(demoReceiverSecret());
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ received: 'evt-1', type: 'commitment.issued', verified: true });
  expect((await send('whsec_someone_else')).status).toBe(401);
});
