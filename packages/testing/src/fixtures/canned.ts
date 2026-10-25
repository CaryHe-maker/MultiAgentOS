import {
  MEDIA_TYPES,
  canonicalJson,
  estimateItemTokens,
  newId,
  sha256Hex,
  type AnalysisReport,
  type AssembleContextPack,
  type AssembleExecutorInput,
  type ContextItem,
  type ContextPack,
  type ExecutionResult,
  type FileReadInput,
  type ModelRawOutput,
  type ModelToolCall,
  type OrientContextPack,
  type SearchContextPack,
} from '@multiagentos/contracts';

/**
 * Schema-valid canned results, one per Unit of M1Interface 6.1. The fakes answer with these
 * values and no real logic: there is no repository, no search and no model behind them.
 */

/** The only file of the imaginary repository every fake reads. */
export const FAKE_FILE = Object.freeze({ path: 'README.md', text: 'line 1\nline 2\nline 3\n' });
export const FAKE_SNAPSHOT_ID = `snp_${sha256Hex('fake-repository')}`;
const CREATED_AT = '2026-01-01T00:00:00.000Z';

/** A ContextItem before the fields that are derived from its content. */
type Draft<Item> = Item extends unknown
  ? Omit<Item, 'itemId' | 'contentSha256' | 'tokenCount' | 'reason'>
  : never;

function finishItems<Item extends ContextItem>(
  contextPackId: string,
  drafts: readonly Draft<Item>[],
): Item[] {
  return drafts.map(
    (draft, index) =>
      ({
        ...draft,
        itemId: `${contextPackId}:${index}`,
        contentSha256: sha256Hex(draft.content),
        tokenCount: estimateItemTokens(draft),
        reason: 'canned',
      }) as Item,
  );
}

const packFields = (contextPackId: string, items: readonly ContextItem[], tokenBudget: number) => ({
  contextPackId,
  tokenCount: items.reduce((total, item) => total + item.tokenCount, 0),
  tokenBudget,
  truncated: false,
  droppedCount: 0,
  createdAt: CREATED_AT,
});

const packArtifact = (value: ContextPack) => ({
  mediaType: MEDIA_TYPES.contextPack,
  text: canonicalJson(value),
});
const provenance = (retrieval: 'TREE' | 'TEXT') => ({
  path: FAKE_FILE.path,
  startLine: 1,
  endLine: 3,
  contentSha256: sha256Hex(FAKE_FILE.text),
  snapshotId: FAKE_SNAPSHOT_ID,
  retrieval,
});

export function cannedOrient(tokenBudget = 4_000): ExecutionResult {
  const contextPackId = newId('ctx');
  const items = finishItems<OrientContextPack['items'][number]>(contextPackId, [
    { segment: 'ORIENT', role: 'user', content: FAKE_FILE.path, provenance: provenance('TREE') },
  ]);
  const value: OrientContextPack = {
    ...packFields(contextPackId, items, tokenBudget),
    operation: 'ORIENT',
    snapshotId: FAKE_SNAPSHOT_ID,
    items,
  };
  return {
    output: {
      snapshotId: FAKE_SNAPSHOT_ID,
      fileCount: 1,
      totalBytes: Buffer.byteLength(FAKE_FILE.text),
      summary: FAKE_FILE.path,
      tokenCount: value.tokenCount,
      truncated: false,
    },
    artifact: packArtifact(value),
  };
}

export function cannedSearch(tokenBudget = 4_000): ExecutionResult {
  const contextPackId = newId('ctx');
  const items = finishItems<SearchContextPack['items'][number]>(contextPackId, [
    {
      segment: 'SEARCH_HIT',
      role: 'user',
      content: FAKE_FILE.text,
      provenance: provenance('TEXT'),
      score: 1,
    },
  ]);
  const value: SearchContextPack = {
    ...packFields(contextPackId, items, tokenBudget),
    operation: 'SEARCH',
    snapshotId: FAKE_SNAPSHOT_ID,
    items,
  };
  return {
    output: {
      snapshotId: FAKE_SNAPSHOT_ID,
      hits: [{ path: FAKE_FILE.path, startLine: 1, endLine: 3, score: 1, matchKind: 'TEXT' }],
      truncated: false,
    },
    artifact: packArtifact(value),
  };
}

/** Always the three lines of FAKE_FILE, whatever range was asked for. */
export function cannedFileRead(input: Pick<FileReadInput, 'path'>): ExecutionResult {
  return {
    output: {
      path: input.path,
      startLine: 1,
      endLine: 3,
      totalLines: 3,
      contentSha256: sha256Hex(FAKE_FILE.text),
      fileSha256: sha256Hex(FAKE_FILE.text),
    },
    artifact: { mediaType: MEDIA_TYPES.fileText, text: FAKE_FILE.text },
  };
}

/**
 * Lays the input out in the segment order of M1Interface 6.3 and nothing more: it never trims,
 * so `truncated` is always false, and it does not check that tool calls and results pair up.
 */
export function cannedAssemble(input: AssembleExecutorInput): ExecutionResult {
  type Item = AssembleContextPack['items'][number];
  const history = input.history.map(({ step, outputText }): Draft<Item> => {
    if (step.kind === 'MODEL_TURN')
      return {
        segment: 'HISTORY',
        role: 'assistant',
        content: '',
        ...(step.toolCalls.length === 0 ? {} : { toolCalls: step.toolCalls }),
      };
    if (step.kind === 'TOOL_RESULT')
      return {
        segment: 'HISTORY',
        role: 'tool',
        content: step.status === 'OK' ? (outputText ?? '') : step.reasonCode,
        toolCallId: step.toolCallId,
      };
    return 'toolCallId' in step && step.toolCallId !== undefined
      ? { segment: 'HISTORY', role: 'tool', content: step.message, toolCallId: step.toolCallId }
      : { segment: 'HISTORY', role: 'user', content: step.message };
  });
  const contextPackId = newId('ctx');
  const items = finishItems<Item>(contextPackId, [
    { segment: 'INSTRUCTIONS', role: 'system', content: input.instructions },
    { segment: 'TOOLS', role: 'system', content: '', toolSpecs: input.toolSpecs },
    { segment: 'OBJECTIVE', role: 'user', content: input.objective },
    ...(input.handoff === undefined
      ? []
      : [{ segment: 'HANDOFF' as const, role: 'user' as const, content: input.handoff.task }]),
    ...(input.orientPack?.items ?? []).map((item): Draft<Item> => ({
      segment: 'ORIENT',
      role: 'user',
      content: item.content,
      provenance: item.provenance,
    })),
    ...history,
    { segment: 'STATUS', role: 'user', content: canonicalJson(input.status) },
  ]);
  const prefixSha256 = sha256Hex('canned-prefix');
  const value: AssembleContextPack = {
    ...packFields(contextPackId, items, input.tokenBudget),
    operation: 'ASSEMBLE',
    ...(input.orientPack === undefined ? {} : { snapshotId: input.orientPack.snapshotId }),
    prefixSha256,
    items,
  };
  return {
    output: {
      contextPackId,
      tokenCount: value.tokenCount,
      tokenBudget: input.tokenBudget,
      truncated: false,
      droppedCount: 0,
      prefixSha256,
      elidedRequestIds: [],
    },
    artifact: packArtifact(value),
  };
}

export function cannedModelCall(toolCalls: readonly ModelToolCall[]): ExecutionResult {
  const raw: ModelRawOutput = {
    provider: 'fake',
    apiModelId: 'fake-model',
    providerFinishReason: 'tool_calls',
    toolCalls: toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      argumentsText: JSON.stringify(call.arguments),
    })),
    receivedAt: CREATED_AT,
  };
  return {
    output: { finishReason: 'TOOL_CALLS', toolCalls: [...toolCalls], hasText: false },
    artifact: { mediaType: MEDIA_TYPES.modelOutput, text: canonicalJson(raw) },
  };
}

export interface ModelScriptStep {
  /** `name` of every tool the ContextPack offers. */
  readonly toolNames: readonly string[];
  /** Whether the history already holds a tool result. */
  readonly hasToolResults: boolean;
  readonly final: boolean;
  /** Counts every model-call the registry has served, starting at 0. */
  readonly callIndex: number;
}
/** Decides what the fake model "answers"; replace it to script another conversation. */
export type ModelScript = (step: ModelScriptStep) => ModelToolCall[];

/**
 * Hands over when a handoff tool is offered, reads FAKE_FILE once when `read_file` is offered
 * and nothing has been read yet, and otherwise finishes with a conclusion that cites the three
 * lines it read. A final-call always finishes.
 */
export const defaultModelScript: ModelScript = ({
  toolNames,
  hasToolResults,
  final,
  callIndex,
}) => {
  const call = (toolName: string, argumentsValue: Record<string, unknown>): ModelToolCall[] => [
    { toolCallId: `call_${callIndex}`, toolName, arguments: argumentsValue },
  ];
  if (!final && toolNames.includes('handoff_to_code_viewer'))
    return call('handoff_to_code_viewer', {
      task: 'Analyse the repository.',
      focusAreas: [],
      openQuestions: [],
    });
  if (!final && !hasToolResults && toolNames.includes('read_file'))
    return call('read_file', { path: FAKE_FILE.path });
  return call('finish_analysis', {
    summary: 'Canned analysis.',
    conclusions: [
      {
        statement: 'The README has three lines.',
        sources: [{ path: FAKE_FILE.path, startLine: 1, endLine: 3 }],
      },
    ],
    unconfirmed: [],
  });
};

/** What a ModelScript needs to know about an assembled pack. */
export function describePack(
  contextPack: AssembleContextPack,
): Pick<ModelScriptStep, 'toolNames' | 'hasToolResults'> {
  return {
    toolNames: contextPack.items.flatMap((item) =>
      'toolSpecs' in item ? item.toolSpecs.map((spec) => spec.name) : [],
    ),
    hasToolResults: contextPack.items.some(
      (item) => item.segment === 'HISTORY' && item.role === 'tool',
    ),
  };
}

/** A report without conclusions, as Workflow would publish it. */
export function cannedReport(workflowRunId: string, goal: string): AnalysisReport {
  return {
    workflowRunId,
    goal,
    summary: 'Canned report.',
    conclusions: [],
    unconfirmed: [],
    readSources: [],
    degraded: false,
    agentRounds: [],
    snapshotId: FAKE_SNAPSHOT_ID,
    createdAt: CREATED_AT,
  };
}
