import {
  createM1ProtocolRegistry,
  type ContractRef,
  type ExecutionKind,
  type ToolDefinition,
  type UnitDefinition,
} from '@multiagentos/contracts';
import type { CatalogIssue, CatalogIssueCode } from './catalog-issue.js';
import { definitionKey, type DefinitionBody } from './definition-digest.js';

/** A definition that already passed the schema, reference and digest checks. */
export interface RuleEntry {
  readonly origin: string;
  readonly body: DefinitionBody;
}

type UnitBody = Omit<UnitDefinition, 'digest'>;
type ToolBody = Omit<ToolDefinition, 'digest'>;

const registry = createM1ProtocolRegistry();

/** Input and output contract of each execution kind (M1Interface 6.1). */
const UNIT_CONTRACTS: { readonly [K in ExecutionKind]?: readonly [string, string] } = {
  REPOSITORY_ORIENT: ['context.RepositoryOrientInput', 'context.RepositoryOrientOutput'],
  REPOSITORY_SEARCH: ['context.RepositorySearchInput', 'context.RepositorySearchOutput'],
  FILE_READ: ['executor.FileReadInput', 'executor.FileReadOutput'],
  CONTEXT_ASSEMBLE: ['context.ContextAssembleInput', 'context.ContextAssembleOutput'],
  MODEL: ['executor.ModelCallInput', 'executor.ModelCallOutput'],
  REPORT_PUBLISH: ['kernel.unit.ReportPublishInput', 'kernel.unit.ReportPublishOutput'],
};
const REPOSITORY_KINDS: readonly ExecutionKind[] = [
  'REPOSITORY_ORIENT',
  'REPOSITORY_SEARCH',
  'FILE_READ',
];
const REQUIRED_ONCE: readonly ExecutionKind[] = ['CONTEXT_ASSEMBLE', 'MODEL', 'REPORT_PUBLISH'];
const FINISH_CONTRACT = 'workflow.AnalysisReportDraft';
const HANDOFF_CONTRACT = 'workflow.HandoffBrief';

/**
 * The cross-definition rules of docs/M1/Library/AgentToolPool.md section 5 that a Schema
 * cannot express. Every issue is collected; any of them stops the catalog from loading.
 */
export function checkDefinitionRules(
  entries: readonly RuleEntry[],
  bodies: ReadonlyMap<string, DefinitionBody>,
): CatalogIssue[] {
  const found: CatalogIssue[] = [];
  const report = (origin: string, code: CatalogIssueCode, message: string) =>
    found.push({ origin, code, message });
  const unitAt = (ref: { id: string; version: string }): UnitBody | undefined => {
    const unit = bodies.get(definitionKey('UNIT', ref.id, ref.version));
    return unit?.kind === 'UNIT' ? unit : undefined;
  };
  const toolAt = (ref: { id: string; version: string }): ToolBody | undefined => {
    const tool = bodies.get(definitionKey('TOOL', ref.id, ref.version));
    return tool?.kind === 'TOOL' ? tool : undefined;
  };
  const checkContract = (origin: string, field: string, ref: ContractRef) => {
    if (!registry.has(`${ref.id}.${ref.version}`))
      report(origin, 'CONTRACT_UNKNOWN', `${field} ${ref.id}@${ref.version} is not registered`);
  };

  /** Distinct unit ids that reference each tool version. */
  const toolOwners = new Map<string, Set<string>>();
  for (const { body } of entries) {
    if (body.kind !== 'UNIT') continue;
    for (const ref of body.toolRefs) {
      const key = definitionKey('TOOL', ref.id, ref.version);
      toolOwners.set(key, (toolOwners.get(key) ?? new Set<string>()).add(body.id));
    }
  }

  for (const { origin, body } of entries) {
    if (body.kind === 'TOOL') {
      checkContract(origin, 'parametersContract', body.parametersContract);
      const owners = toolOwners.get(definitionKey('TOOL', body.id, body.version))?.size ?? 0;
      if (body.purpose === 'UNIT' && owners !== 1)
        report(
          origin,
          'TOOL_INVALID',
          `a UNIT tool must belong to exactly one unit, found ${owners}`,
        );
      if (body.purpose === 'CONTROL' && owners > 0)
        report(origin, 'TOOL_INVALID', 'a CONTROL tool must not be referenced by a unit');
    }

    if (body.kind === 'UNIT') {
      checkContract(origin, 'inputContract', body.inputContract);
      checkContract(origin, 'outputContract', body.outputContract);
      const expected = UNIT_CONTRACTS[body.executionKind];
      if (
        expected !== undefined &&
        (body.inputContract.id !== expected[0] || body.outputContract.id !== expected[1])
      )
        report(
          origin,
          'UNIT_INVALID',
          `${body.executionKind} must use ${expected[0]} and ${expected[1]}`,
        );
      const readsRepository = REPOSITORY_KINDS.includes(body.executionKind);
      const declaresRead = body.protectedCapabilities.includes('repo.read');
      if (readsRepository && !declaresRead)
        report(origin, 'UNIT_INVALID', `${body.executionKind} must declare repo.read`);
      if (!readsRepository && body.protectedCapabilities.length > 0)
        report(
          origin,
          'UNIT_INVALID',
          `${body.executionKind} must not declare protected capabilities`,
        );
      if (body.toolRefs.length > 1) report(origin, 'UNIT_INVALID', 'a unit has at most one tool');
      for (const ref of body.toolRefs) {
        const tool = toolAt(ref);
        if (tool === undefined) continue;
        if (tool.purpose !== 'UNIT')
          report(origin, 'UNIT_INVALID', `tool ${tool.id} must have purpose UNIT`);
        if (tool.parametersContract.id !== body.inputContract.id)
          report(origin, 'UNIT_INVALID', `tool ${tool.id} parameters must equal the unit input`);
      }
      for (const [code, handling] of Object.entries(body.failurePolicy)) {
        if (handling === 'FINAL_CALL' && code !== 'USER_DECLINED' && code !== 'BUDGET_WRAP_UP')
          report(origin, 'UNIT_INVALID', `failurePolicy.${code} cannot be FINAL_CALL`);
        if (handling === 'DEGRADED_REPORT' && code !== 'BUDGET_EXHAUSTED')
          report(origin, 'UNIT_INVALID', `failurePolicy.${code} cannot be DEGRADED_REPORT`);
      }
    }

    if (body.kind === 'AGENT') {
      const units = body.unitRefs.map(unitAt).filter((unit) => unit !== undefined);
      const unitKeys = new Set(body.unitRefs.map((ref) => `${ref.id}@${ref.version}`));
      for (const ref of body.startUnitRefs) {
        if (!unitKeys.has(`${ref.id}@${ref.version}`))
          report(origin, 'AGENT_INVALID', `start unit ${ref.id} is not in unitRefs`);
        else if (unitAt(ref)?.executionKind !== 'REPOSITORY_ORIENT')
          report(origin, 'AGENT_INVALID', `start unit ${ref.id} must be REPOSITORY_ORIENT`);
      }
      for (const kind of REQUIRED_ONCE) {
        const total = units.filter((unit) => unit.executionKind === kind).length;
        if (total !== 1)
          report(origin, 'AGENT_INVALID', `needs exactly one ${kind} unit, found ${total}`);
      }
      const finish = toolAt(body.actions.finish.toolRef);
      if (
        finish !== undefined &&
        (finish.purpose !== 'CONTROL' || finish.parametersContract.id !== FINISH_CONTRACT)
      )
        report(origin, 'AGENT_INVALID', `finish tool must be CONTROL with ${FINISH_CONTRACT}`);
      const handoff = body.actions.handoff;
      if (handoff !== undefined) {
        const tool = toolAt(handoff.toolRef);
        if (
          tool !== undefined &&
          (tool.purpose !== 'CONTROL' || tool.parametersContract.id !== HANDOFF_CONTRACT)
        )
          report(origin, 'AGENT_INVALID', `handoff tool must be CONTROL with ${HANDOFF_CONTRACT}`);
      }
      if (body.limits.maxToolCallsPerRound > 0 && !units.some((unit) => unit.toolRefs.length > 0))
        report(origin, 'AGENT_INVALID', 'maxToolCallsPerRound > 0 needs a unit with a tool');
    }
  }
  return found;
}
