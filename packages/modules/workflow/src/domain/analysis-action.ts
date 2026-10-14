import { validate } from '@multiagentos/contracts';
import type {
  AnalysisReportDraft,
  DefinitionRef,
  HandoffBrief,
  ModelCallOutput,
  ModelToolCall,
  PinnedDefinitionSet,
  ProtocolRegistry,
  ToolDefinition,
} from '@multiagentos/contracts';

export type InvalidActionReason =
  | 'NO_ACTION'
  | 'OUTPUT_TRUNCATED'
  | 'CONTROL_MIXED'
  | 'CONTROL_NOT_ALLOWED'
  | 'CONTROL_ARGUMENTS_INVALID';

export type AnalysisAction =
  | { readonly kind: 'TOOL_CALLS'; readonly calls: readonly ModelToolCall[] }
  | { readonly kind: 'HANDOFF'; readonly toolCallId: string; readonly brief: HandoffBrief }
  | { readonly kind: 'FINISH'; readonly toolCallId: string; readonly draft: AnalysisReportDraft }
  | { readonly kind: 'INVALID'; readonly reason: InvalidActionReason };

const invalid = (reason: InvalidActionReason): AnalysisAction => ({ kind: 'INVALID', reason });
const matches = (tool: ToolDefinition, ref: DefinitionRef | undefined): boolean =>
  ref !== undefined && tool.id === ref.id && tool.version === ref.version;

/** Recognizing a pinned control tool does not grant the current Agent permission to use it. */
function controlOf(
  toolName: string,
  current: PinnedDefinitionSet,
  pinnedSets: readonly PinnedDefinitionSet[],
): ToolDefinition | undefined {
  const ownTool = current.tools.find((tool) => tool.modelName === toolName);
  if (ownTool !== undefined) return ownTool.purpose === 'CONTROL' ? ownTool : undefined;
  return pinnedSets
    .flatMap((set) => set.tools)
    .find((tool) => tool.purpose === 'CONTROL' && tool.modelName === toolName);
}

/** Interprets a Schema-valid model output using only pinned definitions and protocol schemas. */
export function interpretModelOutput(
  output: ModelCallOutput,
  current: PinnedDefinitionSet,
  pinnedSets: readonly PinnedDefinitionSet[],
  isFinal: boolean,
  registry: ProtocolRegistry,
): AnalysisAction {
  if (output.toolCalls.length === 0)
    return invalid(output.finishReason === 'LENGTH' ? 'OUTPUT_TRUNCATED' : 'NO_ACTION');
  const controls = output.toolCalls.map((call) => controlOf(call.toolName, current, pinnedSets));
  const control = controls.find((tool) => tool !== undefined);
  if (control === undefined) return { kind: 'TOOL_CALLS', calls: output.toolCalls };
  if (output.toolCalls.length > 1) return invalid('CONTROL_MIXED');
  const call = output.toolCalls[0];
  if (call === undefined) throw new Error('A control action must have a model tool call');
  const isFinish = matches(control, current.agent.actions.finish.toolRef);
  const isHandoff = matches(control, current.agent.actions.handoff?.toolRef);
  if (!isFinish && (!isHandoff || isFinal)) return invalid('CONTROL_NOT_ALLOWED');
  if (call.arguments === null) return invalid('CONTROL_ARGUMENTS_INVALID');
  const schema = registry.resolveContract(control.parametersContract);
  if (isFinish) {
    const checked = validate<AnalysisReportDraft>(schema, call.arguments);
    return checked.ok
      ? { kind: 'FINISH', toolCallId: call.toolCallId, draft: checked.value }
      : invalid('CONTROL_ARGUMENTS_INVALID');
  }
  const checked = validate<HandoffBrief>(schema, call.arguments);
  return checked.ok
    ? { kind: 'HANDOFF', toolCallId: call.toolCallId, brief: checked.value }
    : invalid('CONTROL_ARGUMENTS_INVALID');
}
