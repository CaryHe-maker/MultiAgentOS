import {
  REPOSITORY_KINDS_V1,
  type ExecutionKindV1,
  type SubmitUnitRequestV1,
  type UnitDefinitionV1,
} from '@multiagentos/contracts';
import { admitWork, type Decision, type RunControl } from './run-control.js';

/** What a registered AgentRun contributes to admission. */
export interface AdmittedAgentRun {
  readonly state: 'ACTIVE' | 'ENDED';
  readonly units: readonly UnitDefinitionV1[];
  readonly maxToolUnits: number;
}

export interface AdmissionContext {
  readonly control: RunControl;
  readonly agentRun: AdmittedAgentRun | undefined;
  /** The input follows the contract that the Unit declares. */
  readonly inputIsValid: (unit: UnitDefinitionV1, input: unknown) => boolean;
}

export type Admission =
  | Extract<Decision, { accepted: false }>
  | {
      readonly accepted: true;
      readonly unit: UnitDefinitionV1;
      readonly needsRepoRead: boolean;
      readonly countsAsTool: boolean;
    };

/** The kinds this stage cannot run; stage 2 judges by the Unit's capabilities instead. */
const UNSUPPORTED_KINDS: ReadonlySet<ExecutionKindV1> = new Set(['FILE_WRITE', 'COMMAND', 'TEST']);

/** Model work and the Units that end an Agent stay available after the quota (Kernel/Monitor 3). */
const UNCOUNTED_KINDS: ReadonlySet<ExecutionKindV1> = new Set([
  'CONTEXT_ASSEMBLE',
  'MODEL',
  'MESSAGE_PUBLISH',
  'REPORT_PUBLISH',
]);

const REPOSITORY_KINDS: ReadonlySet<ExecutionKindV1> = new Set(REPOSITORY_KINDS_V1);

/** The checks of `submitUnit`, in order (Kernel/Interaction 7). Idempotency is done before this. */
export function admitUnit(request: SubmitUnitRequestV1, context: AdmissionContext): Admission {
  const admitted = admitWork(context.control);
  if (!admitted.accepted) return admitted;
  const { agentRun } = context;
  if (agentRun === undefined) return { accepted: false, reasonCode: 'AGENT_RUN_NOT_FOUND' };
  if (agentRun.state === 'ENDED') return { accepted: false, reasonCode: 'AGENT_RUN_ENDED' };

  const unit = agentRun.units.find(
    (candidate) =>
      candidate.id === request.unitRef.id &&
      candidate.version === request.unitRef.version &&
      candidate.digest === request.unitRef.digest,
  );
  if (unit === undefined) return { accepted: false, reasonCode: 'FORBIDDEN' };
  if (UNSUPPORTED_KINDS.has(unit.executionKind))
    return { accepted: false, reasonCode: 'UNSUPPORTED_CAPABILITY' };
  if (!context.inputIsValid(unit, request.input))
    return { accepted: false, reasonCode: 'INVALID_INPUT' };

  return {
    accepted: true,
    unit,
    needsRepoRead:
      REPOSITORY_KINDS.has(unit.executionKind) || unit.protectedCapabilities.includes('repo.read'),
    countsAsTool: !UNCOUNTED_KINDS.has(unit.executionKind),
  };
}
