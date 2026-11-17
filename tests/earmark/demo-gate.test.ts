import { describe, expect, it } from 'vitest';
import { gate, ownCredential } from '@/earmark/demo-gate';

const basic = (pw: string) => 'Basic ' + Buffer.from(`any:${pw}`).toString('base64');

describe('demo gate (D-42)', () => {
  it('is open locally, fails closed on Vercel, and challenges without a credential', () => {
    expect(gate(null, {})).toBe('open');
    expect(gate(null, { VERCEL: '1' })).toBe('misconfigured');
    expect(gate(null, { DEMO_ACCESS_PASSWORD: 'pw' })).toBe('challenge');
  });
  it('allows only the right password', () => {
    expect(gate(basic('pw'), { DEMO_ACCESS_PASSWORD: 'pw' })).toBe('allowed');
    expect(gate(basic('nope'), { DEMO_ACCESS_PASSWORD: 'pw' })).toBe('challenge');
    expect(gate('Bearer pw', { DEMO_ACCESS_PASSWORD: 'pw' })).toBe('challenge');
  });
  it('exempts only routes that carry their own credential', () => {
    for (const p of ['/api/cron', '/api/demo/webhook', '/api/v1/invoices']) expect(ownCredential(p)).toBe(true);
    for (const p of ['/demo', '/api/health', '/api/v1', '/o/northwind']) expect(ownCredential(p)).toBe(false);
  });
});
