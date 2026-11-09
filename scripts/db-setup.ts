import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import pg from 'pg';

// One command from a fresh clone to a migrated local database (spec §13). Creates the dev and test databases,
// writes .env.local and .env.test if missing (both gitignored; values are local-only), and applies migrations.
// Two roles (addendum §2): the owner migrates and is the system client (DATABASE_URL_SYSTEM, DIRECT_URL); `<name>_app_rw`
// (NOBYPASSRLS) is the app's DATABASE_URL. The role is per project: roles are shared by every database on the server.
// Never touches a file that exists, and never prints a value. Postgres must be running locally.
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; scripts: Record<string, string> };
const name = pkg.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
const port = /-p (\d+)/.exec(pkg.scripts['dev:template'] ?? pkg.scripts.dev ?? '')?.[1] ?? '4100';
// A Homebrew Postgres trusts the OS user. Set PGUSER/PGPASSWORD or LOCAL_PG_URL_BASE for anything else.
const base = process.env.LOCAL_PG_URL_BASE ?? `postgresql://${process.env.PGUSER ?? userInfo().username}${process.env.PGPASSWORD ? `:${process.env.PGPASSWORD}` : ''}@localhost:5432`;
const pool = '?connection_limit=10&pool_timeout=20'; // per-project cap on the shared max_connections
const appRole = `${name}_app_rw`;

/** Creates the app role on first run and returns its password; null when it already exists (its URL is in the env files). */
async function ensureAppRole(): Promise<string | null> {
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  try {
    if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole])).rowCount) return null;
    const pw = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${appRole}" LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${pw}'`);
    return pw;
  } finally {
    await admin.end();
  }
}

async function grantApp(dbName: string) {
  const c = new pg.Client({ connectionString: `${base}/${dbName}` });
  await c.connect();
  try {
    await c.query(`GRANT USAGE ON SCHEMA public TO "${appRole}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRole}";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRole}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appRole}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${appRole}";`);
  } finally {
    await c.end();
  }
}
const appPw = await ensureAppRole();
const appBase = base.replace(/\/\/[^@/]*@/, `//${appRole}:${appPw}@`);

const targets = [
  { file: '.env.local', db: name, extra: ['DEMO_MODE=1'] },
  { file: '.env.test', db: `${name}_test`, extra: [] },
];

async function ensureDb(dbName: string) {
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

for (const t of targets) {
  // The pool cap is split: 8 app + 2 system (addendum §10.1); db/index.ts sets the same split for the pg pools.
  const url = `${base}/${t.db}?connection_limit=2&pool_timeout=20`;
  await ensureDb(t.db);
  if (!existsSync(t.file)) {
    // RLS starts off, and off mode is the role (addendum §2, D-31): the app connects as the owner, which bypasses the
    // always-on policies. The app_rw login sits beside it; to enforce, make it DATABASE_URL and set RLS_MODE=enforce.
    // (app_rw with RLS off would see no org rows at all: off mode sets no app.org_id.)
    // A role made by an earlier run has a password only that run knew, so then there is no app_rw line.
    const appRw = appPw ? [`DATABASE_URL_APP_RW=${appBase}/${t.db}?connection_limit=8&pool_timeout=20`] : [];
    writeFileSync(
      t.file,
      [`DATABASE_URL=${base}/${t.db}${pool}`, `DATABASE_URL_SYSTEM=${url}`, `DIRECT_URL=${url}`, ...appRw, '# RLS_MODE=enforce', `AUTH_SECRET=${randomBytes(32).toString('hex')}`, `APP_URL=http://localhost:${port}`, ...t.extra, ''].join('\n'),
    );
    console.log(`wrote ${t.file}`);
  }
  // .env.test first: dotenv-cli lets the first file win, so the test file's database beats .env.local's.
  const envFiles = t.file === '.env.test' ? '-e .env.test -e .env.local' : '-e .env.local';
  execSync(`npx dotenv ${envFiles} -- prisma migrate deploy`, { stdio: 'inherit' });
  await grantApp(t.db);
  console.log(`${t.db}: migrated`);
}
