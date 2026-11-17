import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modulesToRemove, removeModule } from './foundation-modules';
import { REQUIRED_MODULES } from '../src/app/required-modules';

// Spec §4 / §13.3: delete the modules by the manifest, then the tree must still validate, typecheck, pass the module-tooling
// unit tests and build, and foundation:drift must accept the deletions. Runs in a scratch copy, once per release (CI job `modules-removed`).
const root = process.cwd();
const work = join(mkdtempSync(join(tmpdir(), 'modules-removed-')), 'app');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV')) as NodeJS.ProcessEnv; // a dotenv-loaded NODE_ENV=test would break `next build`
// The build parses env at import but never connects, so throwaway values are enough.
env.DATABASE_URL ??= 'postgresql://localhost:5432/unused';
env.AUTH_SECRET ??= 'modules-removed-check-not-a-real-secret-000';
env.APP_URL ??= 'http://localhost:4100';
const sh = (cmd: string) => execSync(cmd, { cwd: work, stdio: 'inherit', env });

execFileSync('rsync', ['-a', '--exclude', '.next', '--exclude', 'src/generated', '--exclude', 'spikes', '--exclude', 'audit', '--exclude', 'test-results', '--exclude', '.git', `${root}/`, `${work}/`], { stdio: 'inherit' });
// A fresh repo, never the real one's .git: in a worktree .git is a pointer file, and the scratch commit landed on the real branch (F-11).
sh('git init -q && git add -A >/dev/null && git -c user.email=ci@local -c user.name=ci commit -qm scratch --allow-empty'); // the base for the drift check

const removed = modulesToRemove(REQUIRED_MODULES);
for (const [name] of removed) removeModule(work, name);
sh('npx prisma validate && npx prisma generate');
sh('npx tsc --noEmit');
// v1.6.3: the module-tooling unit tests must hold in a tree with modules removed, as they must in every such clone
// (the F-09 guard test asserted all four modules present and failed in housefile; this leg never ran it).
sh('npx vitest run tests/unit/foundation-tools.test.ts');
sh('npx next build');
sh('npx tsx scripts/foundation-drift.ts --base HEAD');
const kept = REQUIRED_MODULES.length ? `; ${REQUIRED_MODULES.join(', ')} required, left in place` : '';
console.log(`modules removed (${removed.map(([name]) => name).join(', ')}${kept}): validate, generate, typecheck, unit tests, build and drift all pass`);
rmSync(join(work, '..'), { recursive: true, force: true });
