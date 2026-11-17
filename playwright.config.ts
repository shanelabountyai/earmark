import { defineConfig } from '@playwright/test';

// Template port (see ~/.claude/CLAUDE.md port table). Clones get their own via new-project.
const PORT = Number(process.env.PORT ?? 7600);

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts', // seeds the demo once (DEMO_MODE specs read it)
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: process.env.E2E_DEV ? 'npm run dev:test' : 'npm run e2e:server',
    url: `http://localhost:${PORT}/api/health`,
    env: { DEMO_MODE: '1', SSO_ENABLED: '1', WEBHOOK_ALLOW_PRIVATE: '1', ANTHROPIC_API_KEY: '' }, // e2e/demo.spec.ts drives /demo; e2e/sso.spec.ts the sso module; the demo receiver is http://localhost; the explainer stub, never a billed model
    reuseExistingServer: false, // a stale server on this port would test the wrong app
    timeout: 300_000, // a cold production build outruns the 120s default
  },
});
