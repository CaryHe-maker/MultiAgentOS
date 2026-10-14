import {
  canonicalJson,
  sha256Hex,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type Executor,
  type ExecutorEnvironment,
  type ModelToolCall,
  type ResolvedStep,
} from '@multiagentos/contracts';
import {
  draftTokens,
  finishItems,
  newContextPackId,
  packArtifact,
  packTokens,
  type ItemDraft,
} from '../context-pack/pack-builder.js';
import { completed, failed, guarded, rejected, throwIfAborted } from '../outcome/outcomes.js';
import {
  ELIDED_RESULT,
  renderFeedback,
  renderHandoff,
  renderObjective,
  renderStatus,
  renderToolResult,
} from './history-render.js';

type Item = AssembleContextPack['items'][number];
type Draft = ItemDraft<Item>;

/** One HISTORY item with what trimming needs to know about it. */
interface HistoryEntry {
  draft: Draft;
  readonly round: number;
  /** Set on a successful TOOL_RESULT, whose body step 1 of trimming may elide. */
  readonly elidable?: { readonly requestId: string };
}

/**
 * CONTEXT_ASSEMBLE (ExecutorSet 4.4, M1Interface 6.3). Segments in the fixed order
 * INSTRUCTIONS, TOOLS, OBJECTIVE, HANDOFF, ORIENT, HISTORY, STATUS; everything before HISTORY is
 * the same on every call of an AgentRun and HISTORY only grows at its end, so successive packs
 * share a prefix the provider can cache. Over budget, it trims in the order of M1Interface 6.3.
 */
export function createAssembleExecutor(): Executor<'CONTEXT_ASSEMBLE'> {
  return {
    executionKind: 'CONTEXT_ASSEMBLE',
    execute: (input, environment) => guarded(() => Promise.resolve(assemble(input, environment))),
  };
}

function assemble(input: AssembleExecutorInput, environment: ExecutorEnvironment) {
  throwIfAborted(environment.signal);
  const head: Draft[] = [
    {
      segment: 'INSTRUCTIONS',
      role: 'system',
      content: input.instructions,
      reason: 'agent prompt',
    },
    {
      segment: 'TOOLS',
      role: 'system',
      content: '',
      reason: 'tools of this call',
      toolSpecs: input.toolSpecs,
    },
    {
      segment: 'OBJECTIVE',
      role: 'user',
      content: renderObjective(input.objective),
      reason: 'user goal',
    },
    ...(input.handoff === undefined
      ? []
      : [
          {
            segment: 'HANDOFF',
            role: 'user',
            content: renderHandoff(input.handoff),
            reason: 'planner handoff',
          } as Draft,
        ]),
  ];
  let orient: Draft[] = (input.orientPack?.items ?? []).map((item) => ({
    segment: 'ORIENT',
    role: 'user',
    content: item.content,
    reason: item.reason,
    provenance: item.provenance,
  }));
  const history = buildHistory(input.history);
  if (history === undefined) return failed('INTERNAL', false);
  const status: Draft = {
    segment: 'STATUS',
    role: 'user',
    content: renderStatus(input.status, input.toolSpecs),
    reason: 'run status',
  };

  let entries = history;
  let droppedCount = 0;
  const elided = new Set<string>();
  const sum = (drafts: readonly Draft[]) =>
    drafts.reduce((total, draft) => total + draftTokens(draft), 0);
  let total = sum([...head, ...orient, status]) + sum(entries.map((entry) => entry.draft));

  // 1. Oldest first, replace the body of successful tool results with the elision notice.
  for (const entry of entries) {
    if (total <= input.tokenBudget) break;
    if (entry.elidable === undefined) continue;
    // The notice no longer shows repository content, so it loses the provenance.
    const replacement: Draft & { provenance?: unknown } = {
      ...entry.draft,
      content: ELIDED_RESULT,
    };
    delete replacement.provenance;
    total += draftTokens(replacement) - draftTokens(entry.draft);
    entry.draft = replacement;
    elided.add(entry.elidable.requestId);
    droppedCount += 1;
  }
  // 2. Drop the ORIENT segment.
  if (total > input.tokenBudget && orient.length > 0) {
    total -= sum(orient);
    droppedCount += orient.length;
    orient = [];
  }
  // 3. Oldest first, drop whole Rounds of HISTORY, keeping calls and results paired.
  while (total > input.tokenBudget && entries.length > 0) {
    const round = (entries[0] as HistoryEntry).round;
    for (const entry of entries.filter((candidate) => candidate.round === round)) {
      total -= draftTokens(entry.draft);
      if (entry.elidable === undefined) droppedCount += 1;
      else if (!elided.has(entry.elidable.requestId)) {
        elided.add(entry.elidable.requestId);
        droppedCount += 1;
      }
    }
    entries = entries.filter((entry) => entry.round !== round);
  }
  // The start-up budget check keeps the untrimmable segments below the budget (Monitor 4), so
  // this happens only with a misconfigured budget.
  if (total > input.tokenBudget) return rejected('LIMIT_EXCEEDED');

  const contextPackId = newContextPackId();
  const items = finishItems<Item>(contextPackId, [
    ...head,
    ...orient,
    ...entries.map((entry) => entry.draft),
    status,
  ]);
  const prefixSha256 = sha256Hex(
    canonicalJson({ instructions: input.instructions, toolSpecs: input.toolSpecs }),
  );
  const tokenCount = packTokens(items);
  const truncated = droppedCount > 0;
  const pack: AssembleContextPack = {
    contextPackId,
    operation: 'ASSEMBLE',
    ...(input.orientPack === undefined ? {} : { snapshotId: input.orientPack.snapshotId }),
    tokenCount,
    tokenBudget: input.tokenBudget,
    truncated,
    droppedCount,
    prefixSha256,
    items,
    createdAt: environment.now().toISOString(),
  };
  return completed({
    output: {
      contextPackId,
      tokenCount,
      tokenBudget: input.tokenBudget,
      truncated,
      droppedCount,
      prefixSha256,
      elidedRequestIds: [...elided],
    },
    artifact: packArtifact(pack),
  });
}

/** A model turn and what answered it, in the order the provider requires. */
interface Turn {
  readonly round: number;
  readonly assistant?: Draft;
  readonly calls: readonly ModelToolCall[];
  readonly tools: Map<string, HistoryEntry[]>;
  readonly users: HistoryEntry[];
}

/**
 * HISTORY per ExecutorSet 4.4. Each MODEL_TURN is followed by exactly one tool item per tool
 * call, in the order of its calls, and then by Round feedback: providers reject a user message
 * between a tool call and its result. Undefined when a tool call has no result or a result has
 * no call, which is a Workflow defect (FAILED INTERNAL).
 */
function buildHistory(steps: readonly ResolvedStep[]): HistoryEntry[] | undefined {
  const turns: Turn[] = [];
  const owner = new Map<string, Turn>();
  const current = (round: number): Turn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.round === round) return last;
    const turn: Turn = { round, calls: [], tools: new Map(), users: [] };
    turns.push(turn);
    return turn;
  };
  for (const resolved of steps) {
    const { step } = resolved;
    if (step.kind === 'MODEL_TURN') {
      const turn: Turn = {
        round: step.round,
        assistant: {
          segment: 'HISTORY',
          role: 'assistant',
          // The model's text is not part of the StepRecord; a turn without tool calls still
          // needs non-empty content for providers that reject empty assistant messages.
          content: step.toolCalls.length === 0 ? '(no tool call)' : '',
          reason: 'model turn',
          ...(step.toolCalls.length === 0 ? {} : { toolCalls: step.toolCalls }),
        },
        calls: step.toolCalls,
        tools: new Map(),
        users: [],
      };
      turns.push(turn);
      for (const call of step.toolCalls) owner.set(call.toolCallId, turn);
      continue;
    }
    const toolCallId = 'toolCallId' in step ? step.toolCallId : undefined;
    if (toolCallId === undefined) {
      const turn = current(step.round);
      turn.users.push({
        round: turn.round,
        draft: {
          segment: 'HISTORY',
          role: 'user',
          content: step.kind === 'FEEDBACK' ? renderFeedback(step.code, step.message) : '',
          reason: 'round feedback',
        },
      });
      continue;
    }
    const turn = owner.get(toolCallId);
    if (turn === undefined) return undefined;
    const entry: HistoryEntry =
      step.kind === 'TOOL_RESULT'
        ? toolEntry(turn.round, toolCallId, resolved as ResolvedStep & { step: typeof step })
        : {
            round: turn.round,
            draft: {
              segment: 'HISTORY',
              role: 'tool',
              toolCallId,
              content: renderFeedback(step.code, step.message),
              reason: 'tool call feedback',
            },
          };
    turn.tools.set(toolCallId, [...(turn.tools.get(toolCallId) ?? []), entry]);
  }

  const entries: HistoryEntry[] = [];
  for (const turn of turns) {
    if (turn.assistant !== undefined) entries.push({ round: turn.round, draft: turn.assistant });
    for (const call of turn.calls) {
      const answers = turn.tools.get(call.toolCallId);
      if (answers === undefined || answers.length === 0) return undefined;
      entries.push(...mergeAnswers(answers));
    }
    entries.push(...turn.users);
  }
  return entries;
}

function toolEntry(
  round: number,
  toolCallId: string,
  resolved: ResolvedStep & { step: Extract<ResolvedStep['step'], { kind: 'TOOL_RESULT' }> },
): HistoryEntry {
  const rendered = renderToolResult(resolved);
  return {
    round,
    draft: {
      segment: 'HISTORY',
      role: 'tool',
      toolCallId,
      content: rendered.content,
      reason: `result of ${resolved.step.toolName}`,
      ...(rendered.provenance === undefined ? {} : { provenance: rendered.provenance }),
    },
    ...(rendered.hasBody ? { elidable: { requestId: resolved.step.requestId } } : {}),
  };
}

/**
 * A call answered twice (feedback and a result) still gets one tool message, since providers
 * expect exactly one per call id; the successful result keeps its provenance.
 */
function mergeAnswers(answers: readonly HistoryEntry[]): HistoryEntry[] {
  if (answers.length === 1) return [...answers];
  const first = answers[0] as HistoryEntry;
  const content = answers.map((answer) => answer.draft.content).join('\n\n');
  return [{ round: first.round, draft: { ...first.draft, content } }];
}
