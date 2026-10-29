import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'security',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
