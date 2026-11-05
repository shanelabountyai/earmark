// Loads fixtures/<engine>/*.json and gives the tests one subset matcher for their hand-written `expect` blocks.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Engine, RUNNERS } from '@/lib/earmark/cases';

export type Fixture = { engine: Engine; name: string; note?: string; input: Record<string, unknown>; expect: unknown; file: string };

export const FIXTURES_DIR = join(process.cwd(), 'fixtures');

export function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const engine of Object.keys(RUNNERS) as Engine[]) {
    const dir = join(FIXTURES_DIR, engine);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Omit<Fixture, 'file'>;
      if (doc.engine !== engine) throw new Error(`${engine}/${f}: engine field says ${doc.engine}`);
      out.push({ ...doc, file: `${engine}/${f}` });
    }
  }
  return out;
}

/** Every key in `expected` must be present and equal in `actual`; lists must match in length, element by element. */
export function subsetMismatches(expected: unknown, actual: unknown, path = '$'): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected a list`];
    if (expected.length !== actual.length) return [`${path}: expected ${expected.length} items, got ${actual.length}`];
    return expected.flatMap((e, i) => subsetMismatches(e, actual[i], `${path}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: expected an object`];
    const a = actual as Record<string, unknown>;
    return Object.entries(expected).flatMap(([k, v]) => (k in a ? subsetMismatches(v, a[k], `${path}.${k}`) : [`${path}.${k}: missing`]));
  }
  return Object.is(expected, actual) ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

/** Free-text fields the two implementations word independently; everything else must match exactly. */
const FREE_TEXT = new Set(['message', 'refused']);
export function stripFreeText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFreeText);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !FREE_TEXT.has(k))
        .map(([k, v]) => [k, stripFreeText(v)]),
    );
  return value;
}
