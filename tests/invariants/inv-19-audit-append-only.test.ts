import { beforeEach, describe, expect, it } from 'vitest';
import { audit } from '@/core/audit';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { resetAuthTables } from '../helpers/auth';

beforeEach(resetAuthTables);

describe('INV-19 AuditEvent is append-only', () => {
  it('rejects UPDATE and DELETE, even from raw SQL', async () => {
    await audit({ userId: null }, 'test.event');
    await expect(db.$executeRawUnsafe(`UPDATE "AuditEvent" SET "action" = 'forged'`)).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.deleteMany()).rejects.toThrow(/append-only/);
    expect((await db.auditEvent.findFirstOrThrow()).action).toBe('test.event');
  });

  // v1.7.0 (audit A-12): row triggers do not fire on TRUNCATE, so a statement trigger refuses it. A *_test database is
  // exempt (resetAuthTables); app.truncate_guard = 'strict' lifts that exemption here to prove the refusal.
  it('rejects TRUNCATE outside a test database unless the session opts in', async () => {
    await audit({ userId: null }, 'test.event');
    const truncate = (...settings: string[]) =>
      db.$transaction([...settings.map((s) => db.$executeRawUnsafe(`SET LOCAL ${s}`)), db.$executeRawUnsafe(`TRUNCATE "AuditEvent"`)]);
    await expect(truncate(`app.truncate_guard = 'strict'`)).rejects.toThrow(/TRUNCATE refused/);
    expect(await db.auditEvent.count()).toBe(1);
    await truncate(`app.truncate_guard = 'strict'`, `app.allow_truncate = 'on'`);
    expect(await db.auditEvent.count()).toBe(0);
  });
});
