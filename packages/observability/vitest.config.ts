import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'observability',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
