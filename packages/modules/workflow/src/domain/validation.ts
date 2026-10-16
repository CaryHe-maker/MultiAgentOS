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
  TOO_MANY_TOOL_CALLS:
    'Not executed: this reply has more tool calls than allowed per round. Send fewer calls at a time.',
  UNKNOWN_TOOL:
    'Not executed: this tool does not exist for you. Use only the tools you were given.',
  INVALID_ARGUMENTS:
    'Not executed: the arguments do not match the tool parameters. Fix them and call again.',
  NOT_EXECUTED: 'Not executed: the budget is used up. Finish with what you already have.',
  DUPLICATE_CALL:
    'Not executed: the same call already succeeded and its result is above. Use that result.',
  DUPLICATE_IN_ROUND:
    'Not executed: this repeats another call in the same reply. Its result is given once.',
} as const;

/** Schema paths and messages only; never echoes the model's argument values. */
const MAX_ISSUES = 3;
function argumentsMessage(issues: readonly string[] | undefined): string {
  if (issues === undefined)
    return 'Not executed: the arguments are not valid JSON. Send a JSON object.';
  if (issues.length === 0) return MESSAGES.INVALID_ARGUMENTS;
  const listed = issues.slice(0, MAX_ISSUES).join('; ');
  const more = issues.length > MAX_ISSUES ? ` (and ${issues.length - MAX_ISSUES} more)` : '';
  return `${MESSAGES.INVALID_ARGUMENTS} Problems: ${listed}${more}.`.slice(0, 1000);
}

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
  function reject(
    call: ModelToolCall,
    code: FeedbackStep['code'] & keyof typeof MESSAGES,
    message: string = MESSAGES[code],
  ): void {
    feedback.push({
      kind: 'FEEDBACK',
      round: context.round,
      toolCallId: call.toolCallId,
      code,
      message,
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
      reject(call, 'INVALID_ARGUMENTS', argumentsMessage(checked?.issues));
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
    if (
      accepted.some(
        (other) => other.unit === unit && other.argumentsCanonical === argumentsCanonical,
      )
    ) {
      reject(call, 'DUPLICATE_CALL', MESSAGES.DUPLICATE_IN_ROUND);
      continue;
    }
    accepted.push({ call, unit, input: checked.value, argumentsCanonical });
  }
  return { accepted, feedback };
}
