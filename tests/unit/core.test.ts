import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceClock, now } from '@/core/clock';
import { log } from '@/core/log';
import { fields } from '@/core/authz/action';

afterEach(() => {
  advanceClock(0);
  vi.restoreAllMocks();
});

describe('clock', () => {
  it('advances', () => {
    const before = now().getTime();
    advanceClock(60_000);
    expect(now().getTime() - before).toBeGreaterThanOrEqual(60_000);
  });
});

describe('log', () => {
  it('writes one JSON line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('x.happened', { n: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]![0])).toMatchObject({ event: 'x.happened', n: 1 });
  });
});

describe('form fields (orgAction / userAction input)', () => {
  it('a name posted twice keeps its last value; only a `[]` name arrives as every value', () => {
    const f = new FormData();
    f.append('on', '0'); // the hidden-"0"-before-a-checkbox pattern clones use
    f.append('on', '1');
    f.append('scopes[]', 'read');
    f.append('scopes[]', 'write');
    f.append('one[]', 'x');
    expect(fields(f)).toEqual({ on: '1', scopes: ['read', 'write'], one: ['x'] });
    expect(fields({ a: 1 })).toEqual({ a: 1 });
  });
});
