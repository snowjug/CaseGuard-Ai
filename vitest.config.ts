import { defineConfig } from 'vitest/config';

// Each workspace package owns its vitest.config.ts; this root config aggregates them as projects.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts', '**/*.int.test.ts', '**/main.ts'],
    },
  },
});
