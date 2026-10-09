import {
  MEDIA_TYPES,
  canonicalJson,
  estimateItemTokens,
  newId,
  sha256Hex,
  type AnalysisReport,
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
  Partial<Pick<ContextItem, 'provenance' | 'score' | 'toolSpecs'>>;

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

export function cannedAssemble(objective: string, tokenBudget = 64_000): ExecutionResult {
  const value = pack('ASSEMBLE', tokenBudget, [
    { segment: 'INSTRUCTIONS', role: 'system', content: 'CANNED INSTRUCTIONS' },
    { segment: 'TOOLS', role: 'system', content: '', toolSpecs: [] },
    { segment: 'OBJECTIVE', role: 'user', content: objective },
  ]);
  return {
    output: {
      contextPackId: value.contextPackId,
      tokenCount: value.tokenCount,
      tokenBudget,
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
  /** `id` of the Agent definition that makes the call; undefined when it is not known. */
  readonly agentId: string | undefined;
  /** 0 for the first model-call of the AgentRun. */
  readonly callIndex: number;
  readonly final: boolean;
}
/** Decides what the fake model "answers"; replace it to script another conversation. */
export type ModelScript = (step: ModelScriptStep) => ModelToolCall[];

/**
 * The planner hands over at once; any other agent reads FAKE_FILE on its first call and
 * finishes on the next one with a conclusion that cites what it read. A final-call finishes.
 */
export const defaultModelScript: ModelScript = ({ agentId, callIndex, final }) => {
  const call = (toolName: string, argumentsValue: unknown): ModelToolCall[] => [
    { toolCallId: `call_${callIndex}`, toolName, arguments: argumentsValue },
  ];
  if (agentId === 'planner' && !final)
    return call('handoff_to_code_viewer', {
      task: 'Analyse the repository.',
      focusAreas: [],
      openQuestions: [],
    });
  if (callIndex === 0 && !final) return call('read_file', { path: FAKE_FILE.path });
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
