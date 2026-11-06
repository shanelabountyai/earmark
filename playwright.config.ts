import { defineConfig } from '@playwright/test';

// Template port (see ~/.claude/CLAUDE.md port table). Clones get their own via new-project.
const PORT = Number(process.env.PORT ?? 7600);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: process.env.E2E_DEV ? 'npm run dev:test' : 'npm run e2e:server',
    url: `http://localhost:${PORT}/api/health`,
    env: { DEMO_MODE: '1', SSO_ENABLED: '1' }, // e2e/demo.spec.ts drives /demo; e2e/sso.spec.ts the sso module
    reuseExistingServer: false, // a stale server on this port would test the wrong app
    timeout: 300_000, // a cold production build outruns the 120s default
  },
});
