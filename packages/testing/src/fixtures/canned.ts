import {
  MEDIA_TYPES,
  canonicalJson,
  estimateItemTokens,
  newId,
  sha256Hex,
  type AnalysisReport,
  type AssembleExecutorInput,
  type ContextItem,
  type ContextPack,
  type ExecutionResult,
  type FileReadInput,
  type ModelRawOutput,
  type ModelToolCall,
} from '@multiagentos/contracts';

/**
 * Schema-valid canned results, one per Unit of M1Interface 6.1. The fakes answer with these
 * values and no real logic: there is no repository, no search and no model behind them.
 */

/** The only file of the imaginary repository every fake reads. */
export const FAKE_FILE = Object.freeze({ path: 'README.md', text: 'line 1\nline 2\nline 3\n' });
export const FAKE_SNAPSHOT_ID = `snp_${sha256Hex('fake-repository')}`;
const CREATED_AT = '2026-01-01T00:00:00.000Z';

type ItemSpec = Pick<ContextItem, 'segment' | 'role' | 'content'> &
  Partial<Pick<ContextItem, 'provenance' | 'score' | 'toolSpecs' | 'toolCalls' | 'toolCallId'>>;

function pack(
  operation: ContextPack['operation'],
  tokenBudget: number,
  specs: readonly ItemSpec[],
): ContextPack {
  const contextPackId = newId('ctx');
  const items = specs.map((spec, index) => ({
    itemId: `${contextPackId}:${index}`,
    contentSha256: sha256Hex(spec.content),
    tokenCount: estimateItemTokens(spec),
    reason: 'canned',
    ...spec,
  }));
  return {
    contextPackId,
    operation,
    ...(operation === 'ASSEMBLE' ? {} : { snapshotId: FAKE_SNAPSHOT_ID }),
    tokenCount: items.reduce((total, item) => total + item.tokenCount, 0),
    tokenBudget,
    truncated: false,
    droppedCount: 0,
    ...(operation === 'ASSEMBLE' ? { prefixSha256: sha256Hex('canned-prefix') } : {}),
    items,
    createdAt: CREATED_AT,
  };
}

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
  const value = pack('ORIENT', tokenBudget, [
    { segment: 'ORIENT', role: 'user', content: FAKE_FILE.path, provenance: provenance('TREE') },
  ]);
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
  const value = pack('SEARCH', tokenBudget, [
    {
      segment: 'SEARCH_HIT',
      role: 'user',
      content: FAKE_FILE.text,
      provenance: provenance('TEXT'),
      score: 1,
    },
  ]);
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
  const history = input.history.map(({ step, outputText }): ItemSpec => {
    if (step.kind === 'MODEL_TURN')
      return { segment: 'HISTORY', role: 'assistant', content: '', toolCalls: step.toolCalls };
    if (step.kind === 'TOOL_RESULT')
      return {
        segment: 'HISTORY',
        role: 'tool',
        content: step.status === 'OK' ? (outputText ?? '') : step.reasonCode,
        toolCallId: step.toolCallId,
      };
    return step.toolCallId === undefined
      ? { segment: 'HISTORY', role: 'user', content: step.message }
      : { segment: 'HISTORY', role: 'tool', content: step.message, toolCallId: step.toolCallId };
  });
  const value = pack('ASSEMBLE', input.tokenBudget, [
    { segment: 'INSTRUCTIONS', role: 'system', content: input.instructions },
    { segment: 'TOOLS', role: 'system', content: '', toolSpecs: input.toolSpecs },
    { segment: 'OBJECTIVE', role: 'user', content: input.objective },
    ...(input.handoff === undefined
      ? []
      : [{ segment: 'HANDOFF' as const, role: 'user' as const, content: input.handoff.task }]),
    ...(input.orientPack?.items ?? []).map((item): ItemSpec => ({
      segment: 'ORIENT',
      role: 'user',
      content: item.content,
    })),
    ...history,
    { segment: 'STATUS', role: 'user', content: canonicalJson(input.status) },
  ]);
  return {
    output: {
      contextPackId: value.contextPackId,
      tokenCount: value.tokenCount,
      tokenBudget: input.tokenBudget,
      truncated: false,
      droppedCount: 0,
      prefixSha256: value.prefixSha256 ?? '',
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
  const call = (toolName: string, argumentsValue: unknown): ModelToolCall[] => [
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
  contextPack: ContextPack,
): Pick<ModelScriptStep, 'toolNames' | 'hasToolResults'> {
  return {
    toolNames: contextPack.items.flatMap((item) => (item.toolSpecs ?? []).map((spec) => spec.name)),
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
