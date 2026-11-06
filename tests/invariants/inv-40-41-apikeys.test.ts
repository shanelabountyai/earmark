import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { currentSession } from '@/core/auth/session';
import { advanceClock, now } from '@/core/clock';
import { deleteAccount } from '@/core/tenancy/delete';
import { removeMember } from '@/core/tenancy/orgs';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { emit } from '@/core/events';
import { createKey, revokeKey } from '@/modules/apikeys/keys';
import {
  BACKOFF_MS,
  checkUrl,
  createEndpoint,
  MAX_ATTEMPTS,
  PAUSE_AFTER,
  replayDelivery,
  rotateSecret,
  SIGNATURE_HEADER,
  sweepWebhooks,
  transport,
  verifySignature,
} from '@/modules/apikeys/webhooks';
import * as eventsRoute from '@/app/api/v1/events/route';
import * as one from '@/app/api/v1/projects/[id]/route';
import * as projects from '@/app/api/v1/projects/route';
import { resetAuthTables } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

const real = { ...transport };
beforeEach(async () => {
  await resetAuthTables();
  transport.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
});
afterEach(() => {
  Object.assign(transport, real);
  advanceClock(0);
});

async function org(slug: string) {
  const o = await makeOrg(slug);
  const owner = await addMember(o.id, 'owner', `owner@${slug}.test`);
  return { orgId: o.id, slug, owner: await actAs(owner.id, slug) };
}

const URL_ = 'http://app.test/api/v1';
const req = (path: string, key: string | null, init: RequestInit & { idem?: string } = {}) =>
  new Request(`${URL_}${path}`, {
    ...init,
    headers: { ...(key && { authorization: `Bearer ${key}` }), ...(init.idem && { 'idempotency-key': init.idem }), 'content-type': 'application/json' },
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('INV-40 an API key resolves only its own org, carries only its scopes, and is refused once revoked', () => {
  it("a key for org A gets 404 for org B's project, the same answer as an id that does not exist", async () => {
    const a = await org('acme');
    const b = await org('globex');
    const theirs = await db.project.create({ data: { orgId: b.orgId, name: 'Globex secret plan' } });
    const ours = await db.project.create({ data: { orgId: a.orgId, name: 'Acme roadmap' } });
    const key = await createKey(a.owner, { label: 'crm', scopes: ['read'] });

    const cross = await one.GET(req(`/projects/${theirs.id}`, key), params(theirs.id));
    const missing = await one.GET(req('/projects/00000000-0000-4000-8000-000000000999', key), params('00000000-0000-4000-8000-000000000999'));
    expect(cross.status).toBe(404);
    expect(await cross.text()).toBe(await missing.text());
    expect((await one.GET(req(`/projects/${ours.id}`, key), params(ours.id))).status).toBe(200);

    const list = await (await projects.GET(req('/projects', key))).json();
    expect(list.data.map((p: { name: string }) => p.name)).toEqual(['Acme roadmap']);
    expect(JSON.stringify(list)).not.toContain('notes');
  });

  it('a read-only key on a write route is 403 and writes nothing', async () => {
    const a = await org('acme');
    const key = await createKey(a.owner, { label: 'reader', scopes: ['read'] });
    const res = await projects.POST(req('/projects', key, { method: 'POST', idem: 'k1', body: JSON.stringify({ name: 'x' }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_SCOPE');
    expect(await db.project.count()).toBe(0);
  });

  it('a revoked key is refused on its next request; a missing or unknown key gets the same 401', async () => {
    const a = await org('acme');
    const key = await createKey(a.owner, { label: 'crm', scopes: ['read'] });
    expect((await projects.GET(req('/projects', key))).status).toBe(200);
    const { id } = await db.apiKey.findFirstOrThrow();
    await revokeKey(a.owner, id);
    for (const k of [key, null, 'api_unknown', 'not-a-key']) {
      const res = await projects.GET(req('/projects', k));
      expect(res.status, String(k)).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it("ending a membership revokes the keys that person created, in the same transaction, and no one else's", async () => {
    const a = await org('acme');
    const admin = await addMember(a.orgId, 'admin', 'admin@acme.test');
    const leaver = await addMember(a.orgId, 'admin', 'leaver@acme.test');
    const theirs = await createKey(await actAs(admin.id, 'acme'), { label: 'admin crm', scopes: ['read'] });
    const leavers = await createKey(await actAs(leaver.id, 'acme'), { label: 'leaver crm', scopes: ['read'] });
    const owners = await createKey(a.owner, { label: 'owner crm', scopes: ['read'] });

    await removeMember(await actAs(a.owner.userId, 'acme'), admin.id, onMembershipEnded);
    await removeMember(await actAs(leaver.id, 'acme'), leaver.id, onMembershipEnded); // leaving counts too
    expect((await projects.GET(req('/projects', theirs))).status).toBe(401);
    expect((await projects.GET(req('/projects', leavers))).status).toBe(401);
    expect((await projects.GET(req('/projects', owners))).status).toBe(200);
    expect(await db.auditEvent.count({ where: { action: 'apikey.revoked_with_member' } })).toBe(2);
  });

  it('deleting an account revokes its keys in every org', async () => {
    const a = await org('acme');
    const user = await addMember(a.orgId, 'admin', 'admin@acme.test');
    const key = await createKey(await actAs(user.id, 'acme'), { label: 'crm', scopes: ['read'] });
    await deleteAccount((await currentSession())!, 'admin@acme.test', onMembershipEnded);
    expect((await projects.GET(req('/projects', key))).status).toBe(401);
  });

  it('only the hash and a short prefix are stored; the key is not in any row', async () => {
    const a = await org('acme');
    const key = await createKey(a.owner, { label: 'crm', scopes: ['read', 'write'] });
    const row = await db.apiKey.findFirstOrThrow();
    expect(key.startsWith(row.prefix)).toBe(true);
    expect(row.prefix.length).toBeLessThan(12);
    expect(JSON.stringify(await db.auditEvent.findMany({ select: { data: true, targetId: true } }))).not.toContain(key);
  });

  it('per-key rate limit: the 121st read in a minute is 429 with Retry-After', async () => {
    const a = await org('acme');
    const key = await createKey(a.owner, { label: 'crm', scopes: ['read'] });
    for (let i = 0; i < 120; i++) expect((await projects.GET(req('/projects', key))).status).toBe(200);
    const res = await projects.GET(req('/projects', key));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('writes are idempotent: no key is refused, a replay returns the stored answer, a reused key with another body is 422', async () => {
    const a = await org('acme');
    const key = await createKey(a.owner, { label: 'crm', scopes: ['write'] });
    const post = (idem: string | undefined, body: object) => projects.POST(req('/projects', key, { method: 'POST', idem, body: JSON.stringify(body) }));

    expect((await (await post(undefined, { name: 'x' })).json()).code).toBe('IDEMPOTENCY_REQUIRED');
    const first = await post('k1', { name: 'Roadmap' });
    expect(first.status).toBe(201);
    const again = await post('k1', { name: 'Roadmap' });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.text()).toBe(await first.text());
    expect((await post('k1', { name: 'Other' })).status).toBe(422);
    expect(await db.project.count()).toBe(1);
    expect(await db.orgEvent.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'project.created' } })).toBe(1);

    const bad = await post('k2', { name: '' }); // a refusal is stored and replayed too, and wrote nothing
    expect(bad.status).toBe(400);
    expect((await post('k2', { name: '' })).headers.get('idempotent-replayed')).toBe('true');
    expect(await db.project.count()).toBe(1);
  });

  it('GET /events returns committed events after `since`, in seq order, with the webhook body', async () => {
    const a = await org('acme');
    const key = await createKey(a.owner, { label: 'crm', scopes: ['read', 'write'] });
    for (const n of ['one', 'two', 'three']) await projects.POST(req('/projects', key, { method: 'POST', idem: n, body: JSON.stringify({ name: n }) }));
    const page = await (await eventsRoute.GET(req('/events?since=1&limit=1', key))).json();
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ seq: 2, type: 'project.created', apiVersion: 'v1', replayed: false, data: { project: { name: 'two' } } });
    const next = await (await eventsRoute.GET(req(`/events?limit=5&cursor=${page.nextCursor}`, key))).json();
    expect(next.data.map((e: { seq: number }) => e.seq)).toEqual([3]);
    expect(next.nextCursor).toBeNull();
  });
});

// ---- INV-41 and the outbound half of INV-12 (signature)

type Sent = { url: string; headers: Record<string, string>; body: string };
function receiver(statuses: number[]) {
  const sent: Sent[] = [];
  transport.fetch = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response('ok', { status: statuses.shift() ?? 200 });
  });
  return sent;
}

async function endpoint(slug = 'acme') {
  const o = await org(slug);
  const secret = await createEndpoint(o.owner, { url: 'https://hooks.example.test/in', eventTypes: [] });
  const ep = await db.webhookEndpoint.findFirstOrThrow({ where: { orgId: o.orgId } });
  const publish = (key?: string) => withOrg(o, (tx) => emit(o, 'project.created', { project: { name: 'Roadmap' } }, tx, { key }));
  return { ...o, secret, ep, publish };
}

describe('INV-41 webhook deliveries: retried after a failure, sent once per event, dead-lettered, replayable', () => {
  it('a failed delivery is re-sent after its backoff, and succeeds', async () => {
    const e = await endpoint();
    const sent = receiver([500, 200]);
    await e.publish();
    expect(await sweepWebhooks()).toMatchObject({ queued: 1, failed: 1 });
    expect(await sweepWebhooks()).toMatchObject({ succeeded: 0, failed: 0 }); // not before its backoff
    advanceClock(BACKOFF_MS[0]);
    expect(await sweepWebhooks()).toMatchObject({ succeeded: 1 });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers['Webhook-Attempt']).toBe('2');
    expect(await db.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('a true duplicate is sent once: the same dedupe key twice, and two sweeps racing', async () => {
    const e = await endpoint();
    const sent = receiver([]);
    await e.publish('order-42');
    await e.publish('order-42');
    expect(await db.orgEvent.count()).toBe(1);
    await Promise.all([sweepWebhooks(), sweepWebhooks()]);
    expect(sent).toHaveLength(1);
    expect(await db.webhookDelivery.count()).toBe(1);
  });

  it('six failures make it dead; a replay sends it again flagged replayed: true', async () => {
    const e = await endpoint();
    const sent = receiver(Array(MAX_ATTEMPTS).fill(500));
    await e.publish();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sweepWebhooks();
      advanceClock(BACKOFF_MS.slice(0, i + 1).reduce((x, y) => x + y, 0));
    }
    const d = await db.webhookDelivery.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, nextAttemptAt: null });
    expect(JSON.parse(sent[0]!.body).replayed).toBe(false);

    await replayDelivery(e.owner, d.id);
    expect(await sweepWebhooks()).toMatchObject({ succeeded: 1 });
    const body = JSON.parse(sent.at(-1)!.body);
    expect(body).toMatchObject({ replayed: true, type: 'project.created', seq: 1, data: { project: { name: 'Roadmap' } } });
  });

  it('a 410 disables the endpoint; ten failures in a row pause it', async () => {
    const e = await endpoint();
    receiver([410]);
    await e.publish();
    await sweepWebhooks();
    expect(await db.webhookEndpoint.findFirstOrThrow()).toMatchObject({ status: 'disabled' });

    const f = await endpoint('globex');
    receiver(Array(PAUSE_AFTER).fill(503));
    for (let i = 0; i < PAUSE_AFTER; i++) await f.publish();
    for (let i = 0; i < PAUSE_AFTER; i++) {
      await sweepWebhooks({ orgId: f.orgId }); // one attempt per sweep: a failing endpoint is skipped for the rest of it
    }
    expect(await db.webhookEndpoint.findUniqueOrThrow({ where: { id: f.ep.id } })).toMatchObject({ status: 'paused', consecutiveFailures: PAUSE_AFTER });
  });

  it('an endpoint starts at the current seq: events from before it was added are not pushed', async () => {
    const o = await org('acme');
    await withOrg(o, (tx) => emit(o, 'project.created', { n: 1 }, tx));
    await createEndpoint(o.owner, { url: 'https://hooks.example.test/in', eventTypes: [] });
    const sent = receiver([]);
    await withOrg(o, (tx) => emit(o, 'project.created', { n: 2 }, tx));
    await sweepWebhooks();
    expect(sent.map((s) => JSON.parse(s.body).seq)).toEqual([2]);
  });

  it('INV-12 outbound: HMAC over timestamp + body, stale timestamps rejected, both secrets sign during a rotation', async () => {
    const e = await endpoint();
    const sent = receiver([]);
    await e.publish();
    await sweepWebhooks();
    const { headers, body } = sent[0]!;
    const sig = headers[SIGNATURE_HEADER]!;
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    expect(sig).toContain(`v1=${createHmac('sha256', e.secret).update(`${t}.${body}`).digest('hex')}`); // independent of verifySignature
    expect(verifySignature(e.secret, sig, body)).toBe(true);
    expect(verifySignature(e.secret, sig, body.replace('Roadmap', 'Roadmaq'))).toBe(false);
    expect(verifySignature('whsec_wrong', sig, body)).toBe(false);
    expect(verifySignature(e.secret, sig, body, t + 301)).toBe(false);

    const fresh = await rotateSecret(e.owner, e.ep.id);
    await e.publish();
    await sweepWebhooks();
    const rotated = sent[1]!;
    expect(rotated.headers[SIGNATURE_HEADER]!.match(/v1=/g)).toHaveLength(2);
    expect(verifySignature(e.secret, rotated.headers[SIGNATURE_HEADER]!, rotated.body)).toBe(true);
    expect(verifySignature(fresh, rotated.headers[SIGNATURE_HEADER]!, rotated.body)).toBe(true);

    advanceClock(24 * 3_600_000 + 1);
    await e.publish();
    await sweepWebhooks();
    const after = sent[2]!;
    expect(verifySignature(e.secret, after.headers[SIGNATURE_HEADER]!, after.body, Math.floor(now().getTime() / 1000))).toBe(false);
    expect(verifySignature(fresh, after.headers[SIGNATURE_HEADER]!, after.body, Math.floor(now().getTime() / 1000))).toBe(true);
  });

  it('endpoints are https and public only, checked at save and again at send', async () => {
    await expect(checkUrl('http://hooks.example.test/in')).rejects.toThrow(/https/);
    await expect(checkUrl('https://169.254.169.254/latest')).rejects.toThrow(/private/);
    await expect(checkUrl('https://localhost/in')).rejects.toThrow(/private/);
    await expect(checkUrl('https://user:pw@hooks.example.test/in')).rejects.toThrow(/password/);
    transport.lookup = async () => [{ address: '10.0.0.5', family: 4 }];
    await expect(checkUrl('https://hooks.example.test/in')).rejects.toThrow(/private/);

    transport.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const e = await endpoint();
    const sent = receiver([]);
    await e.publish();
    transport.lookup = async () => [{ address: '169.254.169.254', family: 4 }]; // re-pointed after it was saved
    expect(await sweepWebhooks()).toMatchObject({ failed: 1 });
    expect(sent).toHaveLength(0);
    expect((await db.webhookDelivery.findFirstOrThrow()).lastError).toMatch(/private/);
  });
});
