import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__fixtures__/**', 'src/**/index.ts'],
      reporter: ['text', 'json-summary'],
      // Set just under the current numbers; the remainder is unreachable
      // defensive code (see the uncovered lines in a `pnpm test:coverage` run).
      thresholds: { statements: 99, branches: 94, functions: 100, lines: 99 },
    },
  },
});
