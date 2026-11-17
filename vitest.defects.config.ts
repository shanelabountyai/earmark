import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// NON-GATING. Runs only the proven-defect tests of an audit (tests/defects/*.defects.ts): each one states the correct
// behaviour and fails until its finding is fixed. `npm test` and CI use vitest.config.ts, which does not include them.
//   npx dotenv -e .env.test -e .env.local -- vitest run --config vitest.defects.config.ts
// Same settings as vitest.config.ts; only `include` differs.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/defects/**/*.defects.ts'],
    setupFiles: ['tests/helpers/next.ts'],
    fileParallelism: false,
    hookTimeout: 20_000,
    testTimeout: 20_000,
  },
});
