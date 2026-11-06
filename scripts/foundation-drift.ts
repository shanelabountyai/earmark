import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODULES } from './foundation-modules';

// Plan §3.2: a clone never edits these. `npm run foundation:drift` diffs them against the release named in
// FOUNDATION_VERSION and fails on any difference the rules below do not excuse.
export const OWNED = [
  'src/core', 'src/modules', 'src/proxy.ts', 'prisma/schema', 'prisma/migrations', 'tests/invariants', 'scripts/foundation-*.ts', 'FOUNDATION_VERSION',
  'src/app/(public)/login', 'src/app/(public)/demo', 'src/app/onboarding', 'src/app/account', 'src/app/s/[token]',
  'src/app/o/[org]/settings/members', 'src/app/o/[org]/settings/security', 'src/app/o/[org]/settings/audit', 'src/app/o/[org]/settings/billing', 'src/app/o/[org]/settings/danger', 'src/app/o/[org]/settings/sso',
  'src/app/api/health', 'src/app/api/cron', 'src/app/api/webhooks/stripe',
];
// A clone owns its own tables: `prisma/schema/<app>.prisma` and its migrations are additions, not drift.
const CLONE_OWNED = /^prisma\/schema\/(?!core\.prisma$|billing\.prisma$|notifications\.prisma$|sso\.prisma$)/;

export type Change = { status: 'A' | 'M' | 'D'; path: string; lines: string[] }; // lines: the +/- lines of a changed file

// `// module` in plain files; `{/* module */}` in a .tsx file, where a trailing `//` would render as literal JSX text.
// `// module` in plain files; `{/* module */}` in a .tsx file, where a trailing `//` would render as literal JSX text.
const markerOf = (l: string) => /\/\/ (\w+)\s*$/.exec(l)?.[1] ?? /\{\/\* (\w+) \*\/\}\s*$/.exec(l)?.[1];

/** Fingerprint of a change's actual diff content, so a patch excuse stops applying once the diff moves on. */
export const hashOf = (c: Change) => createHash('sha256').update(c.lines.join('\n')).digest('hex').slice(0, 12);

// FOUNDATION_PATCHES.md line format: `path` `hash12` — reason. Reading the hash back (rather than just
// checking the path is mentioned) is the FR-09 fix: the excuse stops matching once that path's diff moves on.
export const patchedHash = (patches: string, path: string): string | undefined =>
  new RegExp('`' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`\\s+`([0-9a-f]{12})`').exec(patches)?.[1];

/** The changes that are real drift. `absent` = modules whose directory is gone; `patched` = a path+hash still listed in FOUNDATION_PATCHES.md. */
export function drift(changes: Change[], absent: Set<string>, patched: (c: Change) => boolean): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (patched(c) || CLONE_OWNED.test(c.path)) continue;
    if (c.status === 'A' && c.path.startsWith('prisma/migrations/')) continue; // a clone's own migrations
    const gone = [...absent].some((m) => MODULES[m]!.some((p) => c.path === p || c.path.startsWith(`${p}/`)));
    if (gone && c.status === 'D') continue; // a deleted module stays deleted
    if (c.status === 'M') {
      const real = c.lines.filter((l) => {
        const m = markerOf(l);
        if (m === 'app' && l.startsWith('+')) return false; // D-13: a clone's app back-relation
        return !(m && absent.has(m) && l.startsWith('-')); // the removed lines of an absent module
      });
      if (!real.length) continue;
    }
    out.push(`${c.status} ${c.path}`);
  }
  return out;
}

const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 << 20 });

function collect(base: string): Change[] {
  const changes: Change[] = [];
  for (const row of git('diff', '--name-status', '--no-renames', base, '--', ...OWNED.map((p) => (p.includes('*') ? `:(glob)${p}` : `:(literal)${p}`))).split('\n')) {
    const [status, path] = row.split('\t');
    if (!status || !path) continue;
    // -U0 diff works for A and D too (all + or all - lines), so hashOf() fingerprints the whole change, not just edits.
    const lines = git('diff', '-U0', base, '--', `:(literal)${path}`).split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
    changes.push({ status: status as Change['status'], path, lines });
  }
  return changes; // ponytail: untracked files are not in `git diff`; commit or `git add -N` before checking
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--base');
  const base = i > 0 ? process.argv[i + 1]! : readFileSync('FOUNDATION_VERSION', 'utf8').trim();
  if (i < 0 && JSON.parse(readFileSync('package.json', 'utf8')).name === 'saas-foundation') {
    console.log('foundation:drift: this is the template itself; nothing to compare against.');
    process.exit(0);
  }
  const absent = new Set(Object.keys(MODULES).filter((m) => !existsSync(MODULES[m]![0]!)));
  const patches = existsSync('FOUNDATION_PATCHES.md') ? readFileSync('FOUNDATION_PATCHES.md', 'utf8') : '';
  const changes = collect(base);
  const bad = drift(changes, absent, (c) => patchedHash(patches, c.path) === hashOf(c));
  if (bad.length) {
    const byPath = new Map(changes.map((c) => [c.path, c]));
    const detail = bad.map((b) => {
      const c = byPath.get(b.slice(2))!;
      const hash = hashOf(c);
      const stale = patchedHash(patches, c.path);
      return stale
        ? `  ${b}\n    FOUNDATION_PATCHES.md is stale here (excused ${stale}, now ${hash}) — update the hash`
        : `  ${b}\n    add: \`${c.path}\` \`${hash}\` — <reason>`;
    });
    console.error(`foundation:drift: template-owned files differ from ${base}:\n${detail.join('\n')}\nMove the change upstream, or list the path and hash in FOUNDATION_PATCHES.md.`);
    process.exit(1);
  }
  console.log(`foundation:drift: clean against ${base}${absent.size ? ` (modules removed: ${[...absent].join(', ')})` : ''}`);
}
