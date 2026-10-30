import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ui',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    // axe-core walks the whole DOM in jsdom, which is slow for the 40-node graph.
    testTimeout: 30_000,
  },
});
