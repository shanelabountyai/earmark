import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { drift, hashOf, patchedHash, type Change } from '../../scripts/foundation-drift';
import { MARKED_FILES, MODULES, modulesToRemove, presentModules, removeModule } from '../../scripts/foundation-modules';
import { portInUse, rewrite } from '../../scripts/new-project';
import { guardGaps, orgTables, policySql, type OrgTable } from '../../scripts/rls-policies';

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

describe('rls:policies module guard (F-09; v1.6.3: present modules only)', () => {
  // The real tree: whatever modules it still has (all four in the template; fewer in a clone that removed some by the
  // recipe, e.g. housefile without billing). v1.6.2 asserted all four were present, so this failed in every such clone.
  it('guards every table of each present module, and no core table', () => {
    const tables = orgTables();
    expect(tables.some((t) => !t.module)).toBe(true); // core has org tables (Membership, ...): the check never runs on nothing
    expect(guardGaps(tables, presentModules())).toEqual([]);
  });

  // A fixture tree in the template's shape, so the three cases below hold in every clone whatever it removed.
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'module-guard-'));
    mkdirSync(join(root, 'prisma/schema'), { recursive: true });
    for (const m of Object.keys(MODULES)) mkdirSync(join(root, MODULES[m]![0]!), { recursive: true });
    const write = (f: string, text: string) => writeFileSync(join(root, 'prisma/schema', f), text);
    write('core.prisma', [
      'model Org {',
      '  id             String          @id @db.Uuid',
      '  billingAccount BillingAccount? // billing',
      '  outbox         Outbox[] // notifications',
      '}',
      '',
      'model Membership {',
      '  id    String @id @db.Uuid',
      '  orgId String @db.Uuid',
      '}',
      '',
    ].join('\n'));
    write('billing.prisma', 'model BillingAccount {\n  orgId String @id @db.Uuid\n  plan  String?\n}\n');
    write('notifications.prisma', 'model Outbox {\n  id    String  @id @db.Uuid\n  orgId String? @db.Uuid\n}\n');
    write('sso.prisma', 'model SsoConnection {\n  id    String @id @db.Uuid\n  orgId String @unique @db.Uuid\n}\n');
    write('apikeys.prisma', 'model ApiKey {\n  id    String @id @db.Uuid\n  orgId String @db.Uuid\n}\n');
    return root;
  };
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
  const tree = () => {
    const root = fixture();
    roots.push(root);
    return root;
  };

  it('(1) with every module present, billing\'s tables are guarded', () => {
    const root = tree();
    const tables = orgTables(join(root, 'prisma/schema'));
    expect(presentModules(root)).toEqual(Object.keys(MODULES));
    expect(tables.filter((t) => t.module === 'billing').map((t) => t.table)).toEqual(['BillingAccount']);
    expect(policySql(tables.filter((t) => t.module === 'billing'))).toContain(`to_regclass('"BillingAccount"')`);
    expect(guardGaps(tables, presentModules(root))).toEqual([]);
  });

  it('(2) with billing removed by the recipe, it passes on the modules left', () => {
    const root = tree();
    removeModule(root, 'billing', ['prisma/schema/core.prisma']); // the same code foundation:check-modules runs
    const tables = orgTables(join(root, 'prisma/schema'));
    expect(presentModules(root)).toEqual(['notifications', 'sso', 'apikeys']);
    expect(tables.some((t) => t.module === 'billing')).toBe(false);
    expect(readFileSync(join(root, 'prisma/schema/core.prisma'), 'utf8')).not.toContain('// billing');
    expect(guardGaps(tables, presentModules(root))).toEqual([]);
    // what v1.6.2 asserted (all four modules have tables) is exactly what fails here
    expect([...new Set(tables.map((t) => t.module).filter(Boolean))].sort()).not.toEqual(Object.keys(MODULES).sort());
  });

  it('(3) mutation: an unguarded table of a present module still fails, and so does a guarded core table', () => {
    const tables = orgTables(join(tree(), 'prisma/schema'));
    const present = Object.keys(MODULES);
    const unguard = (m: string) => (ts: OrgTable[]) => policySql(ts.map((t) => (t.module === m ? { ...t, module: undefined } : t)));
    expect(guardGaps(tables, present, unguard('billing'))).toEqual(['BillingAccount: table of module billing has no to_regclass guard']);
    expect(guardGaps(tables, present, unguard('sso'))).toEqual(['SsoConnection: table of module sso has no to_regclass guard']);
    const guardCore = (ts: OrgTable[]) => policySql(ts.map((t) => ({ ...t, module: t.module ?? 'core' })));
    expect(guardGaps(tables, present, guardCore)).toEqual(['Membership: core/clone table is guarded (a missing one would silently get no policy)']);
  });

  it('(3) mutation: a present module whose tables are not found fails (the check is not vacuous)', () => {
    const root = tree();
    rmSync(join(root, 'prisma/schema/billing.prisma')); // schema gone, module directory still there: billing is present
    expect(guardGaps(orgTables(join(root, 'prisma/schema')), presentModules(root))).toEqual(['module billing is present but none of its org tables was found']);
  });
});
