import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real-system and child-process tests share OS resources; running files sequentially keeps
    // their timing deterministic on the Ubuntu quality gate.
    fileParallelism: false,
    include: [
      'apps/**/*.test.ts',
      'apps/**/*.spec.ts',
      'packages/**/*.test.ts',
      'packages/**/*.spec.ts',
    ],
    // Repositories under analysis in the acceptance tasks carry their own tests.
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/control-plane/test/acceptance/repos/**'],
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
