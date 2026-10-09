import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Kernel components keep their data isolated (docs/M1/Kernel/Interaction.md 3.2): a component
// imports `interfaces/` only, never a sibling; only `run-actor/` and the package entry wire
// components together, and only through each component's `index.ts`.
const kernelComponents = ['core', 'execution', 'monitor', 'scheduler', 'gateway', 'supervisor'];
const providerSdk = {
  group: ['ai', 'ai/*', '@ai-sdk/*'],
  message: 'Provider SDKs are allowed only in packages/libraries/executor-set/src/model-call.',
};
const childProcess = {
  group: ['child_process', 'node:child_process'],
  message: 'Child processes are started only by packages/modules/kernel/src/supervisor.',
};
const siblingsOf = (component) => ({
  group: [...kernelComponents.filter((other) => other !== component), 'run-actor'].map(
    (other) => `**/${other}/*`,
  ),
  message: 'Kernel components must not import each other; depend on interfaces/ instead.',
});
const componentInternals = {
  group: kernelComponents.flatMap((component) => [
    `**/${component}/*`,
    `!**/${component}/index.js`,
  ]),
  message: 'Import a Kernel component only through its index.ts.',
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.multiagentos/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        onUnsupportedTypeScriptVersion: 'error',
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-restricted-imports': ['error', { patterns: [providerSdk, childProcess] }],
    },
  },
  {
    files: ['packages/libraries/executor-set/src/model-call/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [childProcess] }] },
  },
  {
    files: ['packages/modules/kernel/src/*.ts', 'packages/modules/kernel/src/run-actor/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [providerSdk, childProcess, componentInternals] },
      ],
    },
  },
  ...kernelComponents.map((component) => ({
    files: [`packages/modules/kernel/src/${component}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            providerSdk,
            ...(component === 'supervisor' ? [] : [childProcess]),
            siblingsOf(component),
          ],
        },
      ],
    },
  })),
);
