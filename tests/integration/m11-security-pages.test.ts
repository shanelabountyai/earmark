import { beforeEach, describe, expect, it } from 'vitest';
import { audit, auditEvents, auditFilter, toCsv } from '@/core/audit';
import { createSession, currentSession, listSessions, revokeSession, sessionFor } from '@/core/auth/session';
import { advanceClock } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { Refused } from '@/core/errors';
import { hashToken } from '@/core/tokens';
import { makeUser, resetAuthTables, signInAs } from '../helpers/auth';
import { makeOrg } from '../helpers/org';

beforeEach(resetAuthTables);

// Addendum §4 (M11): the account sessions list and the data behind the org security page and audit viewer.
describe('sessions list', () => {
  it('records how and when a user signed in, and marks the current session', async () => {
    const u = await makeUser();
    await createSession(u.id, { method: 'sso' });
    await signInAs(u.id);
    const user = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(user.lastSignInMethod).toBe('link');
    expect(user.lastSignInAt).not.toBeNull();
    const list = await listSessions((await currentSession())!);
    expect(list.map((s) => [s.method, s.current])).toEqual(expect.arrayContaining([['sso', false], ['link', true]]));
  });

  it('revokes one other session, refuses the current one, and cannot reach another user', async () => {
    const u = await makeUser();
    const other = await createSession(u.id);
    const stranger = await createSession((await makeUser('eve@example.test')).id);
    await signInAs(u.id);
    const s = (await currentSession())!;
    await expect(revokeSession(s, s.hash)).rejects.toBeInstanceOf(Refused);
    await revokeSession(s, hashToken(stranger));
    expect(await sessionFor(stranger)).not.toBeNull();
    await revokeSession(s, hashToken(other));
    expect(await sessionFor(other)).toBeNull();
    expect((await listSessions(s)).length).toBe(1);
  });

  it('updates last seen at most every 5 minutes', async () => {
    const token = await createSession((await makeUser()).id);
    const seen = async () => (await db.session.findUniqueOrThrow({ where: { hash: hashToken(token) } })).lastSeenAt!.getTime();
    const first = await seen();
    advanceClock(60_000);
    await sessionFor(token);
    expect(await seen()).toBe(first);
    advanceClock(6 * 60_000);
    await sessionFor(token);
    expect(await seen()).toBeGreaterThan(first);
  });
});

describe('audit viewer query', () => {
  it('filters by actor, action prefix and day, newest first, and pages with before', async () => {
    const org = await makeOrg();
    const ada = await makeUser('ada@example.test');
    await audit({ orgId: org.id, userId: ada.id }, 'member.invited');
    await audit({ orgId: org.id, userId: null }, 'org.created');
    await audit({ orgId: (await makeOrg('other')).id, userId: ada.id }, 'member.invited');
    const day = (d: Date) => d.toISOString().slice(0, 10);

    expect((await auditEvents(db, org.id)).map((e) => e.action)).toEqual(['org.created', 'member.invited']);
    expect((await auditEvents(db, org.id, await auditFilter({ actor: 'ADA@example.test' }))).length).toBe(1);
    expect((await auditEvents(db, org.id, await auditFilter({ actor: 'nobody@example.test' }))).length).toBe(0);
    expect((await auditEvents(db, org.id, await auditFilter({ action: 'member.' }))).length).toBe(1);
    // `at` is the database's now(), not the test clock: filter by the real day.
    const today = day(new Date());
    const yesterday = day(new Date(Date.now() - 86_400_000));
    expect((await auditEvents(db, org.id, await auditFilter({ from: today, to: today }))).length).toBe(2);
    expect((await auditEvents(db, org.id, await auditFilter({ to: yesterday }))).length).toBe(0);
    const [newest] = await auditEvents(db, org.id);
    expect((await auditEvents(db, org.id, {}, { before: newest!.id })).map((e) => e.action)).toEqual(['member.invited']);
  });

  it('writes CSV that quotes and defuses spreadsheet formulas', () => {
    expect(toCsv([['a', '=SUM(A1)', 'x,"y"', null, { k: 1 }]])).toBe(`a,'=SUM(A1),"x,""y""",,"{""k"":1}"\r\n`);
  });
});
