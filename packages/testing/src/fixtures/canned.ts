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
  type RepositoryListInput,
  type ModelRawOutput,
  type ModelToolCall,
  type OrientContextPack,
} from '@multiagentos/contracts';

/**
 * Schema-valid canned results, one per Executor. The fakes answer with these
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

/** A tool's artifact is the text the model sees, not a pack. */
export function cannedSearch(): ExecutionResult {
  return {
    output: {
      snapshotId: FAKE_SNAPSHOT_ID,
      hits: [{ path: FAKE_FILE.path, startLine: 1, endLine: 3, score: 1, matchKind: 'TEXT' }],
      truncated: false,
    },
    artifact: { mediaType: MEDIA_TYPES.fileText, text: `1 matches:\n\n${FAKE_FILE.text}` },
  };
}

export function cannedList(input: RepositoryListInput): ExecutionResult {
  return {
    output: {
      path: input.path ?? '.',
      directoryCount: 0,
      fileCount: 1,
      omittedEntries: 0,
    },
    artifact: { mediaType: MEDIA_TYPES.fileText, text: `${FAKE_FILE.path}\n` },
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
    artifact: {
      mediaType: MEDIA_TYPES.fileText,
      text: `${input.path} (lines 1-3 of 3)\n${FAKE_FILE.text}`,
    },
  };
}

/**
 * Lays the input out in the segment order of ExecutorSet 6 and nothing more: it never elides, and
 * it does not check that tool calls and results pair up.
 */
export function cannedAssemble(input: AssembleExecutorInput): ExecutionResult {
  type Item = AssembleContextPack['items'][number];
  const history = input.history.map((entry): Draft<Item> => {
    const base = {
      segment: 'HISTORY',
      seq: entry.seq,
      category: entry.category,
      ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
    } as const;
    if (entry.kind === 'MODEL_TURN')
      return {
        ...base,
        role: 'assistant',
        content: entry.text ?? '',
        ...(entry.toolCalls.length === 0 ? {} : { toolCalls: entry.toolCalls }),
      };
    if (entry.kind === 'TOOL_RESULT')
      return {
        ...base,
        role: 'tool',
        content: entry.text ?? entry.reasonCode ?? entry.status,
        toolCallId: entry.toolCallId,
      };
    if (entry.kind === 'FEEDBACK' && entry.toolCallId !== undefined)
      return { ...base, role: 'tool', content: entry.text, toolCallId: entry.toolCallId };
    return { ...base, role: 'user', content: entry.text };
  });
  const contextPackId = newId('ctx');
  const items = finishItems<Item>(contextPackId, [
    { segment: 'INSTRUCTIONS', role: 'system', content: input.instructions },
    { segment: 'TOOLS', role: 'system', content: '', toolSpecs: input.toolSpecs },
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
  const projectionDigest = sha256Hex(canonicalJson(input.history));
  const tokenCount = items.reduce((total, item) => total + item.tokenCount, 0);
  const value: AssembleContextPack = {
    contextPackId,
    tokenCount,
    tokenBudget: input.tokenBudget,
    createdAt: CREATED_AT,
    operation: 'ASSEMBLE',
    ...(input.orientPack === undefined ? {} : { snapshotId: input.orientPack.snapshotId }),
    prefixSha256,
    projectionDigest,
    headDigest: prefixSha256,
    elidedEntries: [],
    items,
  };
  return {
    output: {
      contextPackId,
      tokenCount,
      tokenBudget: input.tokenBudget,
      prefixSha256,
      projectionDigest,
      headDigest: prefixSha256,
      elidedEntries: [],
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
    output: {
      finishReason: 'TOOL_CALLS',
      toolCalls: [...toolCalls],
      hasText: false,
      hasReasoning: false,
    },
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
