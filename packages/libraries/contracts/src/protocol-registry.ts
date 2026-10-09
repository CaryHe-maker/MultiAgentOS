import type { TSchema } from 'typebox';
import * as catalogSchemas from './catalog/catalog-schemas.js';
import * as definitionSchemas from './catalog/definition-schemas.js';
import type { ContractRef } from './catalog/definition-schemas.js';
import * as checkpointRefs from './checkpoint/checkpoint-refs.js';
import * as assemble from './context/assemble.js';
import * as contextPack from './context/context-pack.js';
import * as repository from './context/repository.js';
import * as fileRead from './executor/file-read.js';
import * as modelCall from './executor/model-call.js';
import * as modelToolCall from './executor/model-tool-call.js';
import * as integrationRefs from './integration/integration-refs.js';
import * as gatewayForward from './kernel-control/gateway-forward.js';
import * as interactionEvents from './kernel-control/interaction-events.js';
import * as interactionRequests from './kernel-control/interaction-requests.js';
import * as responses from './kernel-control/responses.js';
import * as runOutcome from './kernel-control/run-outcome.js';
import * as runSummary from './kernel-control/run-summary.js';
import * as executionFact from './kernel-execution/execution-fact.js';
import * as executionRequest from './kernel-execution/execution-request.js';
import * as supervisorRequests from './kernel-execution/supervisor-requests.js';
import * as budgetState from './kernel-unit/budget-state.js';
import * as reportPublish from './kernel-unit/report-publish.js';
import * as unitIo from './kernel-unit/unit-io.js';
import * as workflowEvents from './kernel-unit/workflow-events.js';
import * as workflowSyscalls from './kernel-unit/workflow-syscalls.js';
import * as artifactRefs from './platform-artifact/artifact-refs.js';
import * as commonSchemas from './platform-common/common-schemas.js';
import * as systemConfig from './platform-config/system-config.js';
import { EnvelopeSchema } from './platform-common/common-schemas.js';
import * as executionKind from './platform-common/execution-kind.js';
import * as opaqueRef from './platform-common/opaque-ref.js';
import * as reasonCode from './platform-common/reason-code.js';
import * as fabricRefs from './platform-fabric/fabric-refs.js';
import * as persistenceRefs from './platform-persistence/persistence-refs.js';
import * as restoreRefs from './restore/restore-refs.js';
import * as reviewRefs from './review/review-refs.js';
import * as handoff from './workflow/handoff.js';
import * as report from './workflow/report.js';
import * as stepRecord from './workflow/step-record.js';
import { Type } from 'typebox';

/** Protocol families, their owner and what M1 does with them (M1Interface 12). */
export const PROTOCOL_FAMILIES = {
  'platform.common': { owner: 'contracts', status: 'SUPPORTED' },
  'platform.config': { owner: 'contracts', status: 'SUPPORTED' },
  'kernel.control': { owner: 'kernel', status: 'SUPPORTED' },
  'kernel.unit': { owner: 'kernel', status: 'SUPPORTED' },
  'kernel.execution': { owner: 'kernel', status: 'SUPPORTED' },
  context: { owner: 'executor-set', status: 'SUPPORTED' },
  executor: { owner: 'executor-set', status: 'SUPPORTED' },
  workflow: { owner: 'workflow', status: 'SUPPORTED' },
  catalog: { owner: 'agent-tool-pool', status: 'SUPPORTED' },
  'platform.fabric': { owner: 'fabric', status: 'SUPPORTED' },
  'platform.lifecycle': { owner: 'module-host', status: 'SUPPORTED' },
  'platform.persistence': { owner: 'persistence', status: 'SUPPORTED' },
  'platform.artifact': { owner: 'artifacts', status: 'SUPPORTED' },
  interaction: { owner: 'user-interaction', status: 'SUPPORTED' },
  checkpoint: { owner: 'workflow', status: 'UNSUPPORTED' },
  restore: { owner: 'workflow', status: 'UNSUPPORTED' },
  review: { owner: 'user-interaction', status: 'UNSUPPORTED' },
  integration: { owner: 'workflow', status: 'UNSUPPORTED' },
} as const;
export type ProtocolFamily = keyof typeof PROTOCOL_FAMILIES;

export interface ProtocolRegistration {
  /** `<family>.<Name>.v<major>`, the `$id` of the Schema. */
  readonly schemaId: string;
  /** `<family>.<Name>`, the `Envelope.schemaName`. */
  readonly schemaName: string;
  readonly major: number;
  readonly family: ProtocolFamily;
  readonly owner: string;
  /** UNSUPPORTED families register only opaque references; using one is a contract error. */
  readonly status: 'SUPPORTED' | 'UNSUPPORTED';
  readonly schema: TSchema;
}

const SCHEMA_ID = /^((?:[a-z][a-z0-9-]*\.)+[A-Z][A-Za-z0-9]*)\.v(0|[1-9][0-9]*)$/u;

/** Splits a Schema ID into the Envelope's `schemaName` and `schemaVersion`. */
export function parseSchemaId(schemaId: string): { schemaName: string; major: number } {
  const match = SCHEMA_ID.exec(schemaId);
  if (match === null) throw new Error(`INVALID_SCHEMA_ID: ${schemaId}`);
  return { schemaName: match[1] ?? '', major: Number(match[2]) };
}

function familyOf(schemaName: string): ProtocolFamily {
  const families = Object.keys(PROTOCOL_FAMILIES) as ProtocolFamily[];
  const family = families
    .filter((candidate) => schemaName.startsWith(`${candidate}.`))
    .sort((left, right) => right.length - left.length)[0];
  if (family === undefined) throw new Error(`UNKNOWN_PROTOCOL_FAMILY: ${schemaName}`);
  return family;
}

/** `schemaName + major` decides the meaning; duplicates and unknown majors are rejected. */
export class ProtocolRegistry {
  readonly #entries = new Map<string, ProtocolRegistration>();

  register(schema: TSchema): ProtocolRegistration {
    const schemaId = (schema as { readonly $id?: unknown }).$id;
    if (typeof schemaId !== 'string') throw new Error('Schema has no $id');
    const { schemaName, major } = parseSchemaId(schemaId);
    const key = `${schemaName}@${major}`;
    if (this.#entries.has(key)) throw new Error(`PROTOCOL_ALREADY_REGISTERED: ${key}`);
    const family = familyOf(schemaName);
    const entry = Object.freeze({
      schemaId,
      schemaName,
      major,
      family,
      owner: PROTOCOL_FAMILIES[family].owner,
      status: PROTOCOL_FAMILIES[family].status,
      schema,
    });
    this.#entries.set(key, entry);
    return entry;
  }

  resolve(schemaName: string, major: number): ProtocolRegistration {
    const entry = this.#entries.get(`${schemaName}@${major}`);
    if (entry === undefined) throw new Error(`UNKNOWN_SCHEMA_MAJOR: ${schemaName}@${major}`);
    return entry;
  }

  /** Looks up by Schema ID, e.g. `kernel.unit.SubmitUnitRequest.v0`. */
  get(schemaId: string): ProtocolRegistration {
    const { schemaName, major } = parseSchemaId(schemaId);
    return this.resolve(schemaName, major);
  }

  has(schemaId: string): boolean {
    const match = SCHEMA_ID.exec(schemaId);
    return match !== null && this.#entries.has(`${match[1]}@${Number(match[2])}`);
  }

  /** Resolves the `ContractRef` of a Unit or Tool definition to its Schema. */
  resolveContract(ref: Pick<ContractRef, 'id' | 'version'>): TSchema {
    return this.resolve(ref.id, Number(ref.version.slice(1))).schema;
  }

  /** The JSON Schema document sent to the model as tool parameters (`ModelToolSpec.parameters`). */
  jsonSchemaOf(ref: Pick<ContractRef, 'id' | 'version'>): Record<string, unknown> {
    return toJsonSchema(this.resolveContract(ref)) as Record<string, unknown>;
  }

  list(): readonly ProtocolRegistration[] {
    return Object.freeze([...this.#entries.values()]);
  }
}

/** Plain JSON copy without `$id` and without TypeBox's own `~` keys. */
function toJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toJsonSchema);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$id' && !key.startsWith('~'))
      .map(([key, child]) => [key, toJsonSchema(child)]),
  );
}

const MODULES: readonly Readonly<Record<string, unknown>>[] = [
  commonSchemas,
  reasonCode,
  executionKind,
  opaqueRef,
  budgetState,
  modelToolCall,
  fileRead,
  modelCall,
  contextPack,
  repository,
  stepRecord,
  handoff,
  report,
  assemble,
  definitionSchemas,
  catalogSchemas,
  runOutcome,
  responses,
  reportPublish,
  unitIo,
  workflowSyscalls,
  workflowEvents,
  interactionRequests,
  interactionEvents,
  runSummary,
  gatewayForward,
  executionRequest,
  executionFact,
  supervisorRequests,
  systemConfig,
  checkpointRefs,
  restoreRefs,
  reviewRefs,
  integrationRefs,
  fabricRefs,
  persistenceRefs,
  artifactRefs,
];

const hasSchemaId = (value: unknown): value is TSchema =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { readonly $id?: unknown }).$id === 'string';

/** Registers every top-level Schema exported by the contract files (SharedContracts 3). */
export function createM1ProtocolRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry();
  registry.register(EnvelopeSchema(Type.Unknown()));
  for (const module of MODULES)
    for (const value of Object.values(module)) if (hasSchemaId(value)) registry.register(value);
  return registry;
}
