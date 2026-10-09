import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUSIONS } from './default-exclusions.js';

describe('DEFAULT_EXCLUSIONS', () => {
  it('is exactly the rule list of ExecutorSet 3.2 and cannot be changed at run time', () => {
    expect(DEFAULT_EXCLUSIONS).toEqual([
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
    expect(Object.isFrozen(DEFAULT_EXCLUSIONS)).toBe(true);
  });
});
