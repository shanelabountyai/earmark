import { describe, expect, it } from 'vitest';
import { CORE_OWN_CREDENTIAL, gate, gateResponse } from '@/core/demo-gate';

// src/core/demo-gate.ts (v1.6.5): ported from the clones, now read through @/core/env.
const basic = (userPass: string) => `Basic ${Buffer.from(userPass).toString('base64')}`;
const env = { DEMO_ACCESS_PASSWORD: 'correct horse', VERCEL: '1' };

describe('the demo gate', () => {
  it('admits the right password under any username, and challenges everything else', () => {
    expect(gate(basic('anyone:correct horse'), env)).toBe('allowed');
    expect(gate(basic(':correct horse'), env)).toBe('allowed');
    expect(gate(basic('a:pass:with:colons'), { DEMO_ACCESS_PASSWORD: 'pass:with:colons' })).toBe('allowed');
    for (const h of [null, '', 'Bearer x', basic('anyone:wrong'), basic('correct horse'), basic('anyone:correct horse '), 'Basic !!!'])
      expect(gate(h, env)).toBe('challenge');
  });

  it('fails closed on Vercel without a password, and is open only off Vercel', () => {
    expect(gate(basic('a:b'), { VERCEL: '1' })).toBe('misconfigured');
    expect(gate(null, {})).toBe('open');
  });

  it('answers 401 with a Basic challenge, or 503 when misconfigured', () => {
    const r = gateResponse('challenge');
    expect(r.status).toBe(401);
    expect(r.headers.get('WWW-Authenticate')).toMatch(/^Basic /);
    expect(gateResponse('misconfigured').status).toBe(503);
  });

  it('core leaves open only the cron, which answers to CRON_SECRET', () => {
    expect([...CORE_OWN_CREDENTIAL]).toEqual(['/api/cron']);
  });

  it('reads its keys from @/core/env, never process.env (K11)', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/core/demo-gate.ts', 'utf8')).not.toMatch(/process\.env/);
  });
});
