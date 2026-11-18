import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMembershipEnded, onRoleChanged } from '@/app/org-hooks';
import { currentSession } from '@/core/auth/session';
import { advanceClock, now } from '@/core/clock';
import { deleteAccount } from '@/core/tenancy/delete';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { emit } from '@/core/events';
import { BAD_KEY_PER_IP } from '@/modules/apikeys/api';
import { createKey, resolveKey, revokeKey } from '@/modules/apikeys/keys';
import {
  BACKOFF_MS,
  checkUrl,
  createEndpoint,
  ENDPOINT_CREATOR_DEMOTED,
  ENDPOINT_CREATOR_LEFT,
  isPrivateAddress,
  MAX_ATTEMPTS,
  PAUSE_AFTER,
  replayDelivery,
  rotateSecret,
  setEndpointStatus,
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

  it('the send dials the address the check judged, not a second DNS answer (v1.7.0, DNS rebinding)', async () => {
    transport.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const e = await endpoint();
    receiver([]);
    await e.publish();
    transport.lookup = async () => [{ address: '93.184.216.35', family: 4 }]; // public, but not what was saved
    await sweepWebhooks();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.fetch).mock.calls[0]![2]).toEqual({ address: '93.184.216.35', family: 4 }); // checked at send, then pinned
    expect(readFileSync('src/modules/apikeys/webhooks.ts', 'utf8')).toMatch(/pin \? fetchPinned\(url, init, pin\)/); // the real transport uses it
  });
});

// v1.6.4 (audit 2026-11-17, A-01 and A-13; moved from tests/defects when fixed).
describe('INV-41 v1.6.4: an IPv6 spelling of a private IPv4 address is still private', () => {
  it.each([
    ['loopback, IPv4-mapped', 'https://[::ffff:127.0.0.1]/in'],
    ['cloud metadata, IPv4-mapped', 'https://[::ffff:169.254.169.254]/latest/meta-data/'],
    ['RFC 1918, IPv4-mapped', 'https://[::ffff:10.0.0.5]/in'],
    ['RFC 1918, IPv4-mapped, already hex', 'https://[::ffff:c0a8:1]/in'],
    ['cloud metadata through NAT64 (64:ff9b::/96)', 'https://[64:ff9b::a9fe:a9fe]/in'],
  ])('A-01 %s: %s is refused at save', async (_, url) => {
    const o = await org('acme');
    await expect(createEndpoint(o.owner, { url, eventTypes: [] })).rejects.toThrow(/private address/);
    await expect(checkUrl(url, false)).rejects.toThrow(/private address/);
  });

  it('A-01 a DNS answer in the hex-mapped form is private too, at save and at send', async () => {
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    transport.lookup = async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }];
    await expect(checkUrl('https://hooks.example.test/in', false)).rejects.toThrow(/private address/);
  });
});

describe('INV-41 v1.6.4: what a receiver can make the sender do (A-13)', () => {
  it('reads at most 1 KiB of the answer, however much the receiver streams', async () => {
    const e = await endpoint();
    let pulled = 0;
    transport.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1;
          if (pulled > 1000) return c.close(); // ~16 MiB if read to the end
          c.enqueue(new Uint8Array(16 * 1024).fill(0x61));
        },
      });
      return new Response(stream, { status: 500 });
    });
    await e.publish();
    await sweepWebhooks();
    const d = await db.webhookDelivery.findFirstOrThrow();
    expect(d.lastResponseExcerpt).toHaveLength(1024);
    expect(pulled, 'chunks pulled from the receiver').toBeLessThan(10);
  });

  it('never posts unsigned: when no secret opens, nothing is sent and the delivery fails with the reason', async () => {
    const e = await endpoint();
    const sent = receiver([200]);
    await db.webhookEndpoint.update({ where: { id: e.ep.id }, data: { secretSealed: 'v1.not-a-sealed-secret' } });
    await e.publish();
    expect(await sweepWebhooks()).toMatchObject({ failed: 1, succeeded: 0 });
    expect(sent).toEqual([]);
    expect((await db.webhookDelivery.findFirstOrThrow()).lastError).toMatch(/signing secret/);
  });

  it('a missing or wrong key is metered per client address before the lookup', async () => {
    const bad = () =>
      projects.GET(new Request(`${URL_}/projects`, { headers: { authorization: 'Bearer api_wrong', 'x-forwarded-for': '203.0.113.9' } }));
    for (let i = 0; i < BAD_KEY_PER_IP.limit; i++) expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(429);
    // another address is not affected
    const other = await projects.GET(new Request(`${URL_}/projects`, { headers: { authorization: 'Bearer api_wrong', 'x-forwarded-for': '198.51.100.7' } }));
    expect(other.status).toBe(401);
  });
});

// ---- v1.7.0: a credential does not outlive the right that made it (audit A-04, A-08; owner decisions 2026-11-17)

describe('INV-40 v1.7.0: keys and webhook endpoints end with their creator’s membership or apikeys.manage', () => {
  const sending = () => {
    const sent: string[] = [];
    transport.fetch = vi.fn(async (url: string) => (sent.push(url), new Response('ok')));
    return sent;
  };
  const publish = (o: { orgId: string }) => withOrg(o, (tx) => emit(o, 'project.created', { project: { name: 'Later' } }, tx));

  it("A-04 removing a member disables the endpoints they created, and no one else's; nothing more is sent to them", async () => {
    const a = await org('acme');
    const admin = await addMember(a.orgId, 'admin', 'leaver@acme.test');
    await createEndpoint(await actAs(admin.id, 'acme'), { url: 'https://leaver-controlled.example.test/collect', eventTypes: [] });
    await createEndpoint(await actAs(a.owner.userId, 'acme'), { url: 'https://hooks.example.test/owner', eventTypes: [] });

    await removeMember(await actAs(a.owner.userId, 'acme'), admin.id, onMembershipEnded);
    const theirs = await db.webhookEndpoint.findFirstOrThrow({ where: { createdById: admin.id } });
    expect(theirs).toMatchObject({ status: 'disabled', disabledReason: ENDPOINT_CREATOR_LEFT });
    expect((await db.webhookEndpoint.findFirstOrThrow({ where: { createdById: a.owner.userId } })).status).toBe('active');
    expect(await db.auditEvent.count({ where: { action: 'webhook.disabled_with_member', targetId: admin.id } })).toBe(1);

    const sent = sending();
    await publish(a);
    await sweepWebhooks();
    expect(sent).toEqual(['https://hooks.example.test/owner']);
  });

  it('A-04 leaving, and deleting the account, disable them too', async () => {
    const a = await org('acme');
    const leaver = await addMember(a.orgId, 'admin', 'leaver@acme.test');
    const deleter = await addMember(a.orgId, 'admin', 'admin@acme.test');
    await createEndpoint(await actAs(leaver.id, 'acme'), { url: 'https://hooks.example.test/a', eventTypes: [] });
    await createEndpoint(await actAs(deleter.id, 'acme'), { url: 'https://hooks.example.test/b', eventTypes: [] });

    await removeMember(await actAs(leaver.id, 'acme'), leaver.id, onMembershipEnded);
    await actAs(deleter.id, 'acme');
    await deleteAccount((await currentSession())!, 'admin@acme.test', onMembershipEnded);
    expect(await db.webhookEndpoint.count({ where: { status: 'disabled', disabledReason: ENDPOINT_CREATOR_LEFT } })).toBe(2);
  });

  it('A-04 an owner who switches it back on takes it over: it then lives and dies with them', async () => {
    const a = await org('acme');
    const admin = await addMember(a.orgId, 'admin', 'leaver@acme.test');
    await createEndpoint(await actAs(admin.id, 'acme'), { url: 'https://hooks.example.test/kept', eventTypes: [] });
    await removeMember(await actAs(a.owner.userId, 'acme'), admin.id, onMembershipEnded);
    const ep = await db.webhookEndpoint.findFirstOrThrow();

    await setEndpointStatus(await actAs(a.owner.userId, 'acme'), ep.id, 'active');
    expect(await db.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ status: 'active', createdById: a.owner.userId, disabledReason: null });
    const sent = sending();
    await publish(a);
    await sweepWebhooks();
    expect(sent).toEqual(['https://hooks.example.test/kept']);
  });

  it('A-08 admin → member: the keys they created stop resolving and their endpoints are disabled', async () => {
    const a = await org('acme');
    const admin = await addMember(a.orgId, 'admin', 'demoted@acme.test');
    const ctx = await actAs(admin.id, 'acme');
    const key = await createKey(ctx, { label: 'crm', scopes: ['read', 'write'] });
    await createEndpoint(ctx, { url: 'https://hooks.example.test/demoted', eventTypes: [] });
    const ownerKey = await createKey(await actAs(a.owner.userId, 'acme'), { label: 'owner crm', scopes: ['read'] });

    await changeRole(await actAs(a.owner.userId, 'acme'), admin.id, 'member', onRoleChanged);
    expect(await resolveKey(`Bearer ${key}`)).toBeNull();
    expect((await projects.GET(req('/projects', key))).status).toBe(401);
    expect(await resolveKey(`Bearer ${ownerKey}`)).not.toBeNull();
    expect(await db.webhookEndpoint.findFirstOrThrow()).toMatchObject({ status: 'disabled', disabledReason: ENDPOINT_CREATOR_DEMOTED });
    expect(await db.auditEvent.count({ where: { action: 'apikey.revoked_with_role', targetId: admin.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'webhook.disabled_with_role', targetId: admin.id } })).toBe(1);
  });

  it('A-08 any role without apikeys.manage ends them (scorekeeper); a move that keeps it (admin → owner → admin) does not', async () => {
    const a = await org('acme');
    const keeper = await addMember(a.orgId, 'admin', 'keeper@acme.test');
    const scorer = await addMember(a.orgId, 'admin', 'scorer@acme.test');
    const kept = await createKey(await actAs(keeper.id, 'acme'), { label: 'kept', scopes: ['read'] });
    const ended = await createKey(await actAs(scorer.id, 'acme'), { label: 'ended', scopes: ['read'] });

    const owner = await actAs(a.owner.userId, 'acme');
    await changeRole(owner, keeper.id, 'owner', onRoleChanged);
    await changeRole(await actAs(a.owner.userId, 'acme'), keeper.id, 'admin', onRoleChanged);
    await changeRole(await actAs(a.owner.userId, 'acme'), scorer.id, 'scorekeeper', onRoleChanged);
    expect(await resolveKey(`Bearer ${kept}`)).not.toBeNull();
    expect(await resolveKey(`Bearer ${ended}`)).toBeNull();
  });

  it('a refused role change ends nothing: the hook runs inside the change, after its checks', async () => {
    const a = await org('acme');
    const admin = await addMember(a.orgId, 'admin', 'admin@acme.test');
    const other = await addMember(a.orgId, 'admin', 'other@acme.test');
    const key = await createKey(await actAs(other.id, 'acme'), { label: 'crm', scopes: ['read'] });
    // an admin cannot demote an owner (INV-28) and the change is refused before the hook
    await expect(changeRole(await actAs(admin.id, 'acme'), a.owner.userId, 'member', onRoleChanged)).rejects.toThrow();
    // a hook that throws rolls the whole change back, so the role and the credentials move together or not at all
    await expect(changeRole(await actAs(a.owner.userId, 'acme'), other.id, 'member', async () => { throw new Error('hook failed'); })).rejects.toThrow('hook failed');
    expect((await db.membership.findFirstOrThrow({ where: { userId: other.id } })).role).toBe('admin');
    expect(await resolveKey(`Bearer ${key}`)).not.toBeNull();
  });
});

