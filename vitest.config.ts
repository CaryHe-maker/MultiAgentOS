import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/*.test.ts',
      'apps/**/*.spec.ts',
      'packages/**/*.test.ts',
      'packages/**/*.spec.ts',
    ],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
