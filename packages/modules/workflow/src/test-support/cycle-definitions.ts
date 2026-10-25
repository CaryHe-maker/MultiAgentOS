import type { PinnedDefinitionSet, UnitDefinition } from '@multiagentos/contracts';
import { repositoryDefinitions } from './definitions.js';

/** Adds the orchestration Units required by the cycle to the read-tool fixture. */
export function cycleDefinitions(hasStartup = false): PinnedDefinitionSet {
  const base = repositoryDefinitions();
  const prototype = base.units[0];
  if (prototype === undefined) throw new Error('Missing model Unit fixture');
  const addUnit = (
    id: string,
    executionKind: UnitDefinition['executionKind'],
    input: string,
    output: string,
  ): UnitDefinition => ({
    ...prototype,
    id,
    executionKind,
    isIdempotent: true,
    inputContract: { kind: 'contract', id: input, version: 'v0' },
    outputContract: { kind: 'contract', id: output, version: 'v0' },
    failurePolicy: executionKind === 'REPOSITORY_ORIENT' ? { USER_DECLINED: 'FINAL_CALL' } : {},
    protectedCapabilities: executionKind === 'REPOSITORY_ORIENT' ? ['repo.read'] : [],
  });
  const units = [
    ...base.units,
    ...(hasStartup
      ? [
          addUnit(
            'repository-orient',
            'REPOSITORY_ORIENT',
            'context.RepositoryOrientInput',
            'context.RepositoryOrientOutput',
          ),
        ]
      : []),
  ];
  return {
    ...base,
    agent: {
      ...base.agent,
      unitRefs: units.map(({ id, version }) => ({ id, version })),
      startUnitRefs: hasStartup ? [{ id: 'repository-orient', version: 'v1.1.0' }] : [],
    },
    units,
    refs: [
      ...base.refs,
      ...units
        .slice(base.units.length)
        .map(({ kind, id, version, digest }) => ({ kind, id, version, digest })),
    ],
  };
}
