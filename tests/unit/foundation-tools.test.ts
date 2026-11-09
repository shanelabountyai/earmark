import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drift, hashOf, patchedHash, type Change } from '../../scripts/foundation-drift';
import { MARKED_FILES, MODULES, modulesToRemove } from '../../scripts/foundation-modules';
import { portInUse, rewrite } from '../../scripts/new-project';

const none = () => false;
const edit = (path: string, ...lines: string[]): Change => ({ status: 'M', path, lines });

describe('foundation:drift rules', () => {
  it('flags an edit to core, and a new file in core', () => {
    expect(drift([edit('src/core/tokens.ts', '+x')], new Set(), none)).toEqual(['M src/core/tokens.ts']);
    expect(drift([{ status: 'A', path: 'src/core/mine.ts', lines: [] }], new Set(), none)).toEqual(['A src/core/mine.ts']);
  });
  it('flags a deleted core file', () => {
    expect(drift([{ status: 'D', path: 'src/core/cron.ts', lines: [] }], new Set(), none)).toHaveLength(1);
  });
  it('allows a clone-owned back-relation line marked // app, but not the unmarked line beside it', () => {
    expect(drift([edit('prisma/schema/core.prisma', '+  tasks Task[] // app')], new Set(), none)).toEqual([]);
    expect(drift([edit('prisma/schema/core.prisma', '+  tasks Task[] // app', '-  name String')], new Set(), none)).toHaveLength(1);
  });
  it('allows removed // billing lines only once the billing directory is gone', () => {
    const c = edit('prisma/schema/core.prisma', '-  billingAccount BillingAccount? // billing');
    expect(drift([c], new Set(), none)).toHaveLength(1);
    expect(drift([c], new Set(['billing']), none)).toEqual([]);
    expect(drift([edit('prisma/schema/core.prisma', '-  outbox Outbox[] // notifications')], new Set(['billing']), none)).toHaveLength(1);
  });
  it('allows the {/* billing */} nav-link line in layout.tsx to go once billing is absent (FR-10)', () => {
    const c = edit('src/app/o/[org]/layout.tsx', "-        {can(ctx.role, 'billing.manage') && <> · <Link href={`${base}/settings/billing`}>Billing</Link></>} {/* billing */}");
    expect(drift([c], new Set(), none)).toHaveLength(1); // still there while billing exists: real drift
    expect(drift([c], new Set(['billing']), none)).toEqual([]); // billing's own removal, not a clone edit
  });
  it('allows a deleted module to stay deleted, and only that module', () => {
    const del = (path: string): Change => ({ status: 'D', path, lines: [] });
    expect(drift([del('src/modules/billing/webhook.ts'), del('src/app/o/[org]/settings/billing/page.tsx')], new Set(['billing']), none)).toEqual([]);
    expect(drift([del('src/modules/notifications/sms.ts')], new Set(['billing']), none)).toHaveLength(1);
  });
  it("allows a clone's own migrations and schema file, but not an edited template migration", () => {
    expect(drift([{ status: 'A', path: 'prisma/migrations/20270101000000_tasks/migration.sql', lines: [] }, { status: 'A', path: 'prisma/schema/app.prisma', lines: [] }], new Set(), none)).toEqual([]);
    expect(drift([edit('prisma/migrations/20260923000000_core_init/migration.sql', '+x')], new Set(), none)).toHaveLength(1);
  });
  it('allows a path listed in FOUNDATION_PATCHES.md with its current hash', () => {
    const c = edit('src/core/tokens.ts', '+x');
    const patches = `- \`src/core/tokens.ts\` \`${hashOf(c)}\` — urgent fix, moves upstream next release`;
    expect(drift([c], new Set(), (x) => patchedHash(patches, x.path) === hashOf(x))).toEqual([]);
  });
  it('flags it again once the diff moves on from the excused hash (FR-09)', () => {
    const excusedAt = edit('src/core/tokens.ts', '+x');
    const patches = `- \`src/core/tokens.ts\` \`${hashOf(excusedAt)}\` — urgent fix`;
    const furtherEdit = edit('src/core/tokens.ts', '+x', '+y'); // same path, edited again since the patch was written
    expect(drift([furtherEdit], new Set(), (c) => patchedHash(patches, c.path) === hashOf(c))).toEqual(['M src/core/tokens.ts']);
  });
  it('patchedHash reads the hash back for its path only', () => {
    const patches = '- `src/core/tokens.ts` `abc123def456` — reason\n- `src/core/cron.ts` `111111111111` — other reason';
    expect(patchedHash(patches, 'src/core/tokens.ts')).toBe('abc123def456');
    expect(patchedHash(patches, 'src/core/cron.ts')).toBe('111111111111');
    expect(patchedHash(patches, 'src/core/other.ts')).toBeUndefined();
  });
});

describe('modulesToRemove (F-03)', () => {
  it('removes every module when none is required', () => {
    expect(modulesToRemove([]).map(([name]) => name)).toEqual(Object.keys(MODULES));
  });
  it('leaves a required module out of the removal list, and still removes the rest', () => {
    expect(modulesToRemove(['notifications']).map(([name]) => name)).toEqual(['billing', 'sso', 'apikeys']);
  });
  it('throws on a name that is not a real module, instead of silently doing nothing', () => {
    expect(() => modulesToRemove(['typo'])).toThrow(/unknown module "typo"/);
  });
});

describe('new-project rewrite', () => {
  const files = {
    pkg: JSON.stringify({ name: 'saas-foundation', scripts: { dev: 'next dev -p __PORT__', 'dev:template': 'next dev -p 4100', 'predev:template': 'x', 'dev:test': 'next dev -p 4100' } }),
    playwright: 'const PORT = Number(process.env.PORT ?? 4100);',
    ci: 'APP_URL: http://localhost:4100\nsaas_foundation_test',
    readme: '# SaaS Foundation\n\nbody',
  };
  it('renames, moves the port everywhere, drops the template script', () => {
    const o = rewrite(files, 'my-app', '4200', 'v1.0.0');
    const pkg = JSON.parse(o.pkg);
    expect(pkg.name).toBe('my-app');
    expect(pkg.scripts).toEqual({ dev: 'next dev -p 4200', 'dev:test': 'next dev -p 4200' });
    expect(o.playwright).toContain('4200');
    expect(o.ci).toBe('APP_URL: http://localhost:4200\nmy_app_test');
    expect(o.readme).toMatch(/^# my-app\n\n> Cloned from saas-foundation v1\.0\.0\. Port 4200/);
  });
  it('refuses a second run: once package.json is already renamed (FR-11)', () => {
    const ranOnce = { ...files, pkg: JSON.stringify({ name: 'my-app', scripts: { dev: 'next dev -p 4200' } }) };
    expect(() => rewrite(ranOnce, 'my-app', '4200', 'v1.0.0')).toThrow(/already run here/);
  });
  it('portInUse flags "in use" and "reserved" rows, but not "free" (FR-11)', () => {
    const claudeMd = '| storage business | **3000** | in use | ... |\n| `devdash` | **4400** | reserved | ... |\n| *next project* | **4700** | free | take it |\n';
    expect(portInUse(claudeMd, '3000')).toBe(true);
    expect(portInUse(claudeMd, '4400')).toBe(true);
    expect(portInUse(claudeMd, '4700')).toBe(false); // the next free port must stay pickable
    expect(portInUse(claudeMd, '4800')).toBe(false); // not in the table at all
  });
});

// v1.6.1: check-modules removes modules and runs typecheck, build and drift, but not the invariants, so a module
// reference left unmarked in a MARKED_FILES file survives removal and only fails later in a clone (INV-32 named the
// deleted billing/notifications files as stale cross-org entries). Every line in a marked file that names a module's
// path must carry that module's marker, so the removal recipe takes it with the module.
describe('marked files (v1.6.1)', () => {
  const marker = (m: string) => new RegExp(`(// ${m}|\\{/\\* ${m} \\*/\\})\\s*$`);
  const unmarked = (files: { f: string; text: string }[]) =>
    files.flatMap(({ f, text }) =>
      text.split('\n').flatMap((line, i) =>
        Object.keys(MODULES)
          .filter((m) => line.includes(`modules/${m}/`) || line.includes(`modules/${m}'`) || line.includes(`schema/${m}.prisma`))
          .filter((m) => !marker(m).test(line))
          .map((m) => `${f}:${i + 1} names ${m} without // ${m}`),
      ),
    );
  it('every line that names a module path carries that module\'s marker', () => {
    expect(unmarked(MARKED_FILES.map((f) => ({ f, text: readFileSync(f, 'utf8') })))).toEqual([]);
  });
  it('negative control: the v1.6.0 cross-org line without its marker is caught', () => {
    const planted = [{ f: 'src/core/db/cross-org.ts', text: "  'src/modules/billing/webhook.ts': 'Stripe webhook: the event names the org'," }];
    expect(unmarked(planted)).toHaveLength(1);
  });
});
