import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envSchema, parseEnv } from '@/core/env';

const valid = {
  DATABASE_URL: 'postgresql://u@localhost:5432/x',
  AUTH_SECRET: 'x'.repeat(32),
  APP_URL: 'http://localhost:4100',
};

describe('INV-14 env', () => {
  it.each(['DATABASE_URL', 'AUTH_SECRET', 'APP_URL'])('boot fails when %s is missing', (key) => {
    const rest = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
    expect(() => parseEnv(rest)).toThrow(key);
  });

  it('rejects a short AUTH_SECRET without echoing it', () => {
    expect(() => parseEnv({ ...valid, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
    expect(() => parseEnv({ ...valid, AUTH_SECRET: 'short' })).not.toThrow(/short/);
  });

  it('an empty value is unset, and still fails a required key', () => {
    expect(parseEnv({ ...valid, RESEND_API_KEY: '' }).RESEND_API_KEY).toBeUndefined();
    expect(() => parseEnv({ ...valid, AUTH_SECRET: '' })).toThrow(/AUTH_SECRET/);
  });

  it('.env.example names exactly the schema keys', () => {
    const example = readFileSync('.env.example', 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split('=')[0])
      .sort();
    expect(example).toEqual(Object.keys(envSchema.shape).sort());
  });
});
