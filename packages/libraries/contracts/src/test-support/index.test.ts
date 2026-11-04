import { describe, expect, it } from 'vitest';
import {
  EXECUTION_KINDS,
  REPOSITORY_KINDS,
  WRITE_KINDS,
} from '../platform-common/execution-kind.js';
import { testArtifactRef, testFileReadOutput, testId, testUnitDefinition } from './index.js';

describe('test fixtures', () => {
  it('builds valid identifiers', () => {
    expect(testId('req', 7)).toBe('req_test0007');
  });

  it.each(EXECUTION_KINDS)('builds a valid %s Unit with the catalog capability rule', (kind) => {
    const unit = testUnitDefinition(kind);
    const reads = (REPOSITORY_KINDS as readonly string[]).includes(kind);
    const writes = (WRITE_KINDS as readonly string[]).includes(kind);
    expect(unit.protectedCapabilities).toEqual(
      reads ? ['repo.read'] : writes ? ['workspace.write'] : [],
    );
  });

  it('refuses an override no producer could send', () => {
    expect(() => testUnitDefinition('MODEL', { version: 'latest' })).toThrow();
    expect(() => testFileReadOutput({ startLine: 0 })).toThrow();
    expect(() => testArtifactRef('')).toThrow();
  });
});
