/**
 * Dangerous-file rules hard-coded into the Executors (docs/M1/Library/ExecutorSet.md 3.2).
 * They are the last line of defence after Core's permission decision: Core can append rules
 * through `scope.exclusions` but can never remove one of these.
 */
export const DEFAULT_EXCLUSIONS: readonly string[] = Object.freeze([
  '.git/**',
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/node_modules/**',
]);
