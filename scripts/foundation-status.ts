import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Plan §3.3: where this clone stands, and any `security:` changelog entries between it and the latest release.
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remote = git('remote').split('\n').includes('template') ? 'template' : 'origin';
const current = readFileSync('FOUNDATION_VERSION', 'utf8').trim();

git('fetch', remote, '--tags', '--quiet');
const latest = git('tag', '-l', 'v*', '--sort=-v:refname').split('\n')[0] ?? '';
console.log(`current ${current}, latest ${latest || '(no release tags)'}`);
if (!latest || latest === current) process.exit(0);

const ver = (v: string) => v.replace(/^v/, '').split('.').map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [ver(a), ver(b)];
  const k = [0, 1, 2].find((i) => x[i] !== y[i]);
  return k !== undefined && x[k]! > y[k]!;
};
if (!newer(latest, current)) process.exit(0);

let inRange = false;
const security: string[] = [];
for (const line of git('show', `${latest}:CHANGELOG.md`).split('\n')) {
  const h = /^## (v?\d+\.\d+\.\d+)/.exec(line);
  if (h) inRange = newer(h[1]!, current);
  else if (inRange && /^security:/i.test(line.trim())) security.push(line.trim());
}
console.log(security.length ? `SECURITY entries since ${current} (upgrade within 7 days):\n  ${security.join('\n  ')}` : 'no security: entries in between');
