import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/next.ts'],
    fileParallelism: false, // one local Postgres, shared state
    hookTimeout: 20_000,
    testTimeout: 20_000,
    // Earmark (PRD §7 row 1 gate): `npm run test:engines` measures src/lib/earmark and fails below 95 %.
    coverage: { provider: 'v8', include: ['src/lib/earmark/**'], thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 } },
  },
});
