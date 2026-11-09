import { beforeEach, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { enrol, makeUser, resetAuthTables, signInAs } from '../helpers/auth';

beforeEach(resetAuthTables);

describe('INV-25 TOTP secrets are sealed at rest', () => {
  it('no base32 seed is stored', async () => {
    const u = await makeUser();
    await signInAs(u.id);
    const { secret } = await enrol();
    const rows = await db.user.findMany({ select: { totpSecretSealed: true } });
    for (const { totpSecretSealed } of rows) {
      expect(totpSecretSealed).not.toBeNull();
      expect(totpSecretSealed).not.toContain(secret);
      expect(totpSecretSealed).not.toMatch(/^[A-Z2-7]{16,}=*$/);
    }
  });
});
