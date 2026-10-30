import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ai',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Same allowance as the API and web suites: a test must not fail only because a CI runner is slow.
    testTimeout: 30_000,
  },
});
