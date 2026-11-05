// Oracle parity (PRD §8): every fixture through the TypeScript engine and through its Python oracle, diffed.
// Also checks each fixture's hand-written `expect` block against the TypeScript output.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNERS } from '@/lib/earmark/cases';
import { loadFixtures, stripFreeText, subsetMismatches } from './fixtures';

const fixtures = loadFixtures();

function oracle(engine: string, input: unknown): unknown {
  const r = spawnSync('python3', [join('tools', `${engine}_oracle.py`)], { input: JSON.stringify(input), encoding: 'utf8', cwd: process.cwd() });
  if (r.status !== 0) throw new Error(`tools/${engine}_oracle.py exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('fixtures', () => {
  it('cover every engine with hand-written cases', () => {
    const counts = Object.fromEntries(Object.keys(RUNNERS).map((e) => [e, fixtures.filter((f) => f.engine === e).length]));
    for (const [engine, n] of Object.entries(counts)) expect(n, `${engine} fixtures`).toBeGreaterThan(0);
    expect(fixtures.length).toBeGreaterThanOrEqual(100);
  });
});

describe('TypeScript engine vs Python oracle, per fixture', () => {
  for (const f of fixtures) {
    it(`${f.file}${f.note ? ` — ${f.note}` : ''}`, () => {
      const ts = JSON.parse(JSON.stringify(RUNNERS[f.engine](f.input))) as unknown;
      const mismatches = subsetMismatches(f.expect, ts);
      expect(mismatches, `expect block vs TypeScript output`).toEqual([]);
      const py = oracle(f.engine, f.input);
      expect(stripFreeText(ts)).toEqual(stripFreeText(py));
    });
  }
});
