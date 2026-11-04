import { UnitDefinitionSchema, type UnitDefinition } from '../catalog/definition-schemas.js';
import { FileReadOutputSchema, type FileReadOutput } from '../executor/file-read.js';
import { ArtifactRefSchema, type ArtifactRef } from '../platform-common/common-schemas.js';
import { REPOSITORY_KINDS, type ExecutionKind } from '../platform-common/execution-kind.js';
import { assertValid } from '../platform-common/validation.js';

/**
 * Valid test data for every package, built once here. Each builder validates what it returns
 * against the Schema, so a test never runs on data no producer could send, and no test needs a
 * cast to make up a value.
 */

/** A stable, valid identifier, such as `testId('req', 1)` → `req_test0001`. */
export const testId = (prefix: string, n = 1): string =>
  `${prefix}_test${String(n).padStart(4, '0')}`;

const sha256Of = (seed: string): string => seed.repeat(64).slice(0, 64);

export function testArtifactRef(mediaType = 'text/plain', seed = 'a'): ArtifactRef {
  const sha256 = sha256Of(seed);
  return assertValid(ArtifactRefSchema, {
    artifactId: `art_${sha256}`,
    sha256,
    size: 1,
    mediaType,
  });
}

const READS_REPOSITORY: ReadonlySet<ExecutionKind> = new Set(REPOSITORY_KINDS);

/**
 * A `v1` Unit of the given kind. It declares `repo.read` exactly when the kind reads the
 * repository, the same rule the catalog checks on load (AgentToolPool 5).
 */
export function testUnitDefinition(
  executionKind: ExecutionKind,
  overrides: Partial<UnitDefinition> = {},
): UnitDefinition {
  const name = executionKind.toLowerCase().replaceAll('_', '-');
  return assertValid(UnitDefinitionSchema, {
    schemaVersion: 'v1',
    kind: 'UNIT',
    id: name,
    version: 'v1.0.0',
    digest: sha256Of('d'),
    description: `Test Unit ${name}`,
    executionKind,
    protectedCapabilities: READS_REPOSITORY.has(executionKind) ? ['repo.read'] : [],
    inputContract: { kind: 'contract', id: `test.${name}`, version: 'v1' },
    outputContract: { kind: 'contract', id: `test.${name}`, version: 'v1' },
    toolRefs: [],
    effect: 'READ_ONLY',
    isIdempotent: true,
    failurePolicy: {},
    ...overrides,
  });
}

export function testFileReadOutput(overrides: Partial<FileReadOutput> = {}): FileReadOutput {
  return assertValid(FileReadOutputSchema, {
    path: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    contentSha256: sha256Of('c'),
    fileSha256: sha256Of('f'),
    ...overrides,
  });
}
