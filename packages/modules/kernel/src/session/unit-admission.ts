import {
  type ExecutionKind,
  type SubmitUnitRequest,
  type UnitDefinition,
} from '@multiagentos/contracts';
import { admitWork, type Decision, type RunControl } from './run-control.js';

/** What a registered AgentRun contributes to admission. */
export interface AdmittedAgentRun {
  readonly state: 'ACTIVE' | 'ENDED';
  readonly units: readonly UnitDefinition[];
  readonly maxToolUnits: number;
}

export interface AdmissionContext {
  readonly control: RunControl;
  readonly agentRun: AdmittedAgentRun | undefined;
  /** The input follows the contract that the Unit declares. */
  readonly inputIsValid: (unit: UnitDefinition, input: unknown) => boolean;
}

export type Admission =
  | Extract<Decision, { accepted: false }>
  | {
      readonly accepted: true;
      readonly unit: UnitDefinition;
      readonly countsAsTool: boolean;
    };

/** The kinds this stage cannot run. */
const UNSUPPORTED_KINDS: ReadonlySet<ExecutionKind> = new Set(['COMMAND', 'TEST']);

/** Model work and the Units that end an Agent stay available after the quota (Kernel/Monitor 3). */
const UNCOUNTED_KINDS: ReadonlySet<ExecutionKind> = new Set([
  'CONTEXT_ASSEMBLE',
  'MODEL',
  'MESSAGE_PUBLISH',
  'REPORT_PUBLISH',
]);

/** The checks of `submitUnit`, in order (Kernel/Interaction 7). Idempotency is done before this. */
export function admitUnit(
  request: Pick<SubmitUnitRequest, 'unitRef' | 'input'>,
  context: AdmissionContext,
): Admission {
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
    countsAsTool: !UNCOUNTED_KINDS.has(unit.executionKind),
  };
}
