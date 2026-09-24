import type { CapabilityDescriptor } from './schemas.js';

export const PROTOCOL_FAMILIES = [
  'platform.common',
  'interaction',
  'workflow',
  'kernel.control',
  'kernel.unit',
  'context',
  'catalog',
  'checkpoint',
  'restore',
  'review',
  'integration',
  'platform.lifecycle',
  'platform.persistence',
  'platform.communication',
  'platform.artifact',
] as const;
export type ProtocolFamily = (typeof PROTOCOL_FAMILIES)[number];
export interface ProtocolRegistration {
  readonly schemaName: string;
  readonly owner: string;
  readonly major: number;
  readonly minor: number;
  readonly capability: CapabilityDescriptor;
  readonly handler: 'REAL' | 'FAKE' | 'UNSUPPORTED';
}
export class ProtocolRegistry {
  readonly #entries = new Map<string, ProtocolRegistration>();
  register(entry: ProtocolRegistration): void {
    const key = `${entry.schemaName}@${entry.major}`;
    if (this.#entries.has(key)) throw new Error(`Protocol already registered: ${key}`);
    this.#entries.set(key, Object.freeze(entry));
  }
  resolve(schemaName: string, major: number): ProtocolRegistration {
    const entry = this.#entries.get(`${schemaName}@${major}`);
    if (!entry) throw new Error(`UNKNOWN_SCHEMA_MAJOR: ${schemaName}@${major}`);
    return entry;
  }
  list(): readonly ProtocolRegistration[] {
    return Object.freeze([...this.#entries.values()]);
  }
  assertCoverage(): void {
    const missing = PROTOCOL_FAMILIES.filter(
      (family) =>
        !this.list().some(
          (entry) => entry.schemaName === family || entry.schemaName.startsWith(`${family}.`),
        ),
    );
    if (missing.length > 0) throw new Error(`Missing protocol families: ${missing.join(', ')}`);
  }
}
const real = new Set([
  'platform.common',
  'interaction',
  'workflow',
  'kernel.control',
  'kernel.unit',
  'context',
  'catalog',
  'platform.lifecycle',
  'platform.persistence',
  'platform.communication',
  'platform.artifact',
]);
export function createM1ProtocolRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry();
  for (const family of PROTOCOL_FAMILIES) {
    const supported = real.has(family);
    registry.register({
      schemaName: `${family}.Boundary`,
      owner: family.split('.')[0] ?? family,
      major: 0,
      minor: 1,
      capability: {
        capability: `${family}.m1`,
        status: supported ? 'SUPPORTED' : 'UNSUPPORTED',
        schemaNames: [`${family}.Boundary`],
        ...(supported ? {} : { reason: 'Reserved for a later milestone' }),
      },
      handler: supported ? 'REAL' : 'UNSUPPORTED',
    });
  }
  const concrete: readonly [string, string, string][] = [
    ['platform.common.Envelope', 'contracts', 'common.validation'],
    ['platform.common.ModuleError', 'contracts', 'common.validation'],
    ['platform.common.VersionedRef', 'contracts', 'common.validation'],
    ['platform.common.WorkspaceRef', 'contracts', 'common.validation'],
    ['platform.common.ArtifactRef', 'contracts', 'common.validation'],
    ['platform.common.CapabilityDescriptor', 'contracts', 'common.validation'],
    ['platform.common.BoundaryContext', 'contracts', 'common.validation'],
    ['interaction.UserIntent', 'user-interaction', 'interaction.run'],
    ['workflow.TaskGraph', 'workflow', 'workflow.single-task'],
    ['workflow.WorkflowRunView', 'workflow', 'workflow.projection-source'],
    ['kernel.control.RuntimeProjection', 'kernel', 'kernel.projection'],
    ['kernel.unit.UnitIntent', 'kernel', 'kernel.unit'],
    ['kernel.unit.UnitResult', 'kernel', 'kernel.unit'],
    ['context.ContextRequest', 'context-engine', 'context.local'],
    ['context.ContextPack', 'context-engine', 'context.local'],
    ['catalog.DefinitionQuery', 'agent-tool-pool', 'catalog.builtin-readonly'],
    ['catalog.DefinitionVersion', 'agent-tool-pool', 'catalog.builtin-readonly'],
  ];
  for (const [schemaName, owner, capability] of concrete)
    registry.register({
      schemaName,
      owner,
      major: 0,
      minor: 1,
      capability: { capability, status: 'SUPPORTED', schemaNames: [schemaName] },
      handler: 'REAL',
    });
  registry.assertCoverage();
  return registry;
}
