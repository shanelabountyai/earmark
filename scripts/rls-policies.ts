import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODULES } from './foundation-modules';

// `npm run rls:policies` (addendum §2): one migration enabling + forcing RLS on every model with an orgId column.
//  - required orgId: one FOR ALL policy, rows visible and writable only with app.org_id set to that org.
//  - nullable orgId (append-style: AuditEvent, Outbox): INSERT of a row with no org or the scoped org (v1.7.0, audit
//    A-11; was unrestricted), SELECT/UPDATE/DELETE scoped.
// nullif: after a transaction-local set_config ends, the setting reads '' (not NULL) on that connection, and
// ''::uuid throws (spike S4a). nullif makes "no org set" match no row instead of erroring.
// Idempotent (DROP POLICY IF EXISTS), so a clone re-running it over core tables recreates them unchanged.
// A removable module's tables are wrapped in a to_regclass guard: a clone that removed the module may have dropped them
// (README "Removing a module"), and a later policy migration must still apply (F-09). Core and clone tables stay
// unguarded on purpose, so a missing one fails the migration instead of silently getting no policy.

export type OrgTable = { model: string; table: string; column: string; nullable: boolean; module?: string };

export function orgTables(dir = 'prisma/schema'): OrgTable[] {
  const out: OrgTable[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.prisma')).sort()) {
    const file = f.replace(/\.prisma$/, '');
    for (const [, model = '', body = ''] of readFileSync(`${dir}/${f}`, 'utf8').matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const field = /^\s*orgId\s+String(\??)([^\n]*)/m.exec(body);
      if (!field) continue;
      out.push({
        model,
        table: /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? model,
        column: /@map\("([^"]+)"\)/.exec(field[2] ?? '')?.[1] ?? 'orgId',
        nullable: field[1] === '?',
        ...(file in MODULES ? { module: file } : {}),
      });
    }
  }
  return out;
}

const ORG = `nullif(current_setting('app.org_id', true), '')::uuid`;

export function policySql(tables: OrgTable[]): string {
  return tables
    .map(({ table: t, column: c, nullable, module }) => {
      const scoped = `"${c}" = ${ORG}`;
      const lines = [
        `-- ${t}${nullable ? ' (append-style: insert no-org or own-org, everything else scoped)' : ''}`,
        `ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`,
        `ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`,
        ...['org_isolation', 'org_insert', 'org_select', 'org_update', 'org_delete'].map((p) => `DROP POLICY IF EXISTS ${p} ON "${t}";`),
      ];
      if (!nullable) lines.push(`CREATE POLICY org_isolation ON "${t}" FOR ALL USING (${scoped}) WITH CHECK (${scoped});`);
      else
        lines.push(
          `CREATE POLICY org_insert ON "${t}" FOR INSERT WITH CHECK ("${c}" IS NULL OR ${scoped});`,
          `CREATE POLICY org_select ON "${t}" FOR SELECT USING (${scoped});`,
          `CREATE POLICY org_update ON "${t}" FOR UPDATE USING (${scoped}) WITH CHECK (${scoped});`,
          `CREATE POLICY org_delete ON "${t}" FOR DELETE USING (${scoped});`,
        );
      if (!module) return lines.join('\n');
      const [comment, ...body] = lines;
      return [`${comment} [module ${module}: skipped if the table was dropped]`, `DO $$ BEGIN IF to_regclass('"${t}"') IS NOT NULL THEN`, ...body.map((l) => `  ${l}`), 'END IF; END $$;'].join('\n');
    })
    .join('\n\n');
}

// v1.6.3: what is wrong with the module guard for a tree whose present modules are `present` (empty = correct). Every
// table of a present module must be guarded and no core or clone table may be; and each present module must contribute
// at least one table, so a missing or unparsed schema file fails instead of making the check pass on nothing. A removed
// module is simply not in `present`: its tables are gone with its schema file (README "Removing a module").
export function guardGaps(tables: OrgTable[], present: readonly string[], sql: (t: OrgTable[]) => string = policySql): string[] {
  const gaps: string[] = [];
  for (const t of tables) {
    const guarded = sql([t]).includes(`to_regclass('"${t.table}"')`);
    if (t.module && !guarded) gaps.push(`${t.table}: table of module ${t.module} has no to_regclass guard`);
    if (!t.module && guarded) gaps.push(`${t.table}: core/clone table is guarded (a missing one would silently get no policy)`);
  }
  for (const m of present) if (!tables.some((t) => t.module === m)) gaps.push(`module ${m} is present but none of its org tables was found`);
  return gaps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tables = orgTables();
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const dir = `prisma/migrations/${process.argv[2] ?? `${stamp}_rls_policies`}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/migration.sql`, `-- Generated by npm run rls:policies. Do not edit; re-run it after adding an org-owned model.\n\n${policySql(tables)}\n`);
  console.log(`${dir}: ${tables.length} tables (${tables.map((t) => t.table).join(', ')})`);
}
