// Vercel runs `npm run vercel-build` instead of `build` when this script exists. A production build applies pending
// migrations first, so the schema ships with the code that needs it (2026-11-18: v1.7.0 went live before its
// migrations). Preview builds never touch the production database. A failed migration fails the build, and the
// previous deployment keeps serving.
//
// MIGRATE_URL (Vercel, Production only): the database OWNER's direct (unpooled) connection string. Missing on a
// production build is a failed build, not a silent skip.
import { execSync } from 'node:child_process';

const run = (cmd, extra = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...extra } });

if (process.env.VERCEL_ENV === 'production') {
  const url = process.env.MIGRATE_URL;
  if (!url) {
    console.error('vercel-build: MIGRATE_URL is not set for Production. Refusing to deploy code ahead of its migrations.');
    process.exit(1);
  }
  run('npx prisma migrate deploy', { DATABASE_URL: url, DIRECT_URL: url });
} else {
  console.log(`vercel-build: VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}, no migrations.`);
}
run('npm run build');
