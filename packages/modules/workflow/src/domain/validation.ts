import { canonicalJson, validate } from '@multiagentos/contracts';
import type {
  BudgetState,
  FeedbackStep,
  ModelToolCall,
  PinnedDefinitionRef,
  PinnedDefinitionSet,
  ProtocolRegistry,
  UnitDefinition,
  UnitInput,
} from '@multiagentos/contracts';

export interface SuccessfulToolCall {
  readonly unitRef: PinnedDefinitionRef;
  readonly argumentsCanonical: string;
  readonly requestId: string;
}

export interface AcceptedToolCall {
  readonly call: ModelToolCall;
  readonly unit: UnitDefinition;
  readonly input: UnitInput;
  readonly argumentsCanonical: string;
}

export interface ValidationContext {
  readonly definitions: PinnedDefinitionSet;
  readonly budgetState: BudgetState;
  readonly successfulCalls: readonly SuccessfulToolCall[];
  readonly elidedRequestIds: readonly string[];
  readonly round: number;
  readonly registry: ProtocolRegistry;
}

const MESSAGES = {
  TOO_MANY_TOOL_CALLS: 'This call exceeds the UNIT tool-call limit for the round.',
  UNKNOWN_TOOL: 'This tool is not an allowed UNIT tool of the current Agent.',
  INVALID_ARGUMENTS: 'The arguments do not satisfy the tool parameters contract.',
  NOT_EXECUTED: 'The budget is exhausted; this tool call was not executed.',
  DUPLICATE_CALL: 'An identical call already succeeded and its result is still in context.',
} as const;

const sameUnit = (previous: PinnedDefinitionRef, unit: UnitDefinition): boolean =>
  previous.kind === 'UNIT' &&
  previous.id === unit.id &&
  previous.version === unit.version &&
  previous.digest === unit.digest;

/** Checks in specification order; only successful calls in this AgentRun participate in dedupe. */
export function validateToolCalls(
  calls: readonly ModelToolCall[],
  context: ValidationContext,
): { readonly accepted: readonly AcceptedToolCall[]; readonly feedback: readonly FeedbackStep[] } {
  const accepted: AcceptedToolCall[] = [];
  const feedback: FeedbackStep[] = [];
  const elided = new Set(context.elidedRequestIds);
  let unitOrdinal = 0;
  function reject(call: ModelToolCall, code: keyof typeof MESSAGES): void {
    feedback.push({
      kind: 'FEEDBACK',
      round: context.round,
      toolCallId: call.toolCallId,
      code,
      message: MESSAGES[code],
    });
  }
  for (const call of calls) {
    const tool = context.definitions.tools.find(
      (candidate) => candidate.modelName === call.toolName,
    );
    if (tool?.purpose === 'UNIT') {
      unitOrdinal += 1;
      if (unitOrdinal > context.definitions.agent.limits.maxToolCallsPerRound) {
        reject(call, 'TOO_MANY_TOOL_CALLS');
        continue;
      }
    }
    if (tool === undefined || tool.purpose !== 'UNIT') {
      reject(call, 'UNKNOWN_TOOL');
      continue;
    }
    const checked =
      call.arguments === null
        ? undefined
        : validate<UnitInput>(
            context.registry.resolveContract(tool.parametersContract),
            call.arguments,
          );
    if (checked === undefined || !checked.ok) {
      reject(call, 'INVALID_ARGUMENTS');
      continue;
    }
    if (context.budgetState === 'EXHAUSTED') {
      reject(call, 'NOT_EXECUTED');
      continue;
    }
    const unit = context.definitions.units.find((candidate) =>
      candidate.toolRefs.some((ref) => ref.id === tool.id && ref.version === tool.version),
    );
    if (unit === undefined) throw new Error('A pinned UNIT tool must belong to a pinned Unit');
    const argumentsCanonical = canonicalJson(call.arguments);
    if (
      context.successfulCalls.some(
        (previous) =>
          sameUnit(previous.unitRef, unit) &&
          previous.argumentsCanonical === argumentsCanonical &&
          !elided.has(previous.requestId),
      )
    ) {
      reject(call, 'DUPLICATE_CALL');
      continue;
    }
    accepted.push({ call, unit, input: checked.value, argumentsCanonical });
  }
  return { accepted, feedback };
}
