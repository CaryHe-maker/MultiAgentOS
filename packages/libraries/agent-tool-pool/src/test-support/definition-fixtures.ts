import type { SourceDocument } from '../ports/definition-source.js';

/**
 * A minimal, valid draft catalog (no digests) used by this package's tests:
 * agent -> { model, prompt, four units, finish tool }, where file-read owns the read-file tool.
 * Each call returns fresh objects; the first document is the read-file tool.
 */
export function draftDocuments(): SourceDocument[] {
  const contract = (id: string) => ({ kind: 'contract', id, version: 'v0' });
  const ref = (id: string) => ({ id, version: 'v1.0.0' });
  const common = { schemaVersion: 'v0', version: 'v1.0.0', description: 'test fixture' };
  const tool = (id: string, purpose: string, modelName: string, parameters: string) => ({
    origin: `tools/${id}/v1.0.0.yaml`,
    content: {
      ...common,
      kind: 'TOOL',
      id,
      purpose,
      modelName,
      modelDescription: 'Test tool.',
      parametersContract: contract(parameters),
      riskClass: 'READ_ONLY',
      sideEffect: 'NONE',
      isIdempotent: true,
      contentStatus: 'PLACEHOLDER',
    },
  });
  const unit = (
    id: string,
    executionKind: string,
    input: string,
    output: string,
    extra: Readonly<Record<string, unknown>> = {},
  ) => ({
    origin: `units/${id}/v1.0.0.yaml`,
    content: {
      ...common,
      kind: 'UNIT',
      id,
      executionKind,
      protectedCapabilities: [],
      inputContract: contract(input),
      outputContract: contract(output),
      toolRefs: [],
      effect: 'READ_ONLY',
      isIdempotent: true,
      failurePolicy: {},
      ...extra,
    },
  });
  return [
    tool('read-file', 'UNIT', 'read_file', 'executor.FileReadInput'),
    tool('finish-analysis', 'CONTROL', 'finish_analysis', 'workflow.AnalysisReportDraft'),
    {
      origin: 'prompts/analysis/v1.0.0.yaml',
      content: {
        ...common,
        kind: 'PROMPT',
        id: 'analysis',
        role: 'system',
        template: 'Analyse {{repository}} read-only.',
        variables: [{ name: 'repository', description: 'repository name' }],
        contentStatus: 'PLACEHOLDER',
      },
    },
    {
      origin: 'models/test-model/v1.0.0.yaml',
      content: {
        ...common,
        kind: 'MODEL',
        id: 'test-model',
        provider: 'test',
        apiModelId: 'test-model',
        providerModelLabel: 'Test Model',
        apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
        baseUrl: 'https://example.invalid',
        limits: { contextWindowTokens: 1_000, maxOutputTokens: 100 },
        features: {
          hasJsonOutput: true,
          hasToolCalls: true,
          hasVision: false,
          thinking: { isSupported: false, isEnabledByDefault: false, effortLevels: [] },
        },
        pricing: {
          currency: 'USD',
          unit: 'MICRO_USD_PER_MILLION_TOKENS',
          offPeak: { inputCacheHit: 1, inputCacheMiss: 2, output: 3 },
          peak: {
            ratePercent: 200,
            timeZone: 'UTC',
            weekdays: [1, 2, 3, 4, 5],
            windows: [{ start: '01:00', end: '04:00' }],
          },
          source: { url: 'https://example.invalid/pricing', verifiedOn: '2026-09-28' },
        },
      },
    },
    unit('file-read', 'FILE_READ', 'executor.FileReadInput', 'executor.FileReadOutput', {
      protectedCapabilities: ['repo.read'],
      toolRefs: [ref('read-file')],
      failurePolicy: { NOT_FOUND: 'RETURN_TO_MODEL', USER_DECLINED: 'FINAL_CALL' },
    }),
    unit(
      'context-assemble',
      'CONTEXT_ASSEMBLE',
      'context.ContextAssembleInput',
      'context.ContextAssembleOutput',
    ),
    unit('model-call', 'MODEL', 'executor.ModelCallInput', 'executor.ModelCallOutput', {
      isIdempotent: false,
    }),
    unit(
      'report-publish',
      'REPORT_PUBLISH',
      'kernel.unit.ReportPublishInput',
      'kernel.unit.ReportPublishOutput',
    ),
    {
      origin: 'agents/analysis-agent/v1.0.0.yaml',
      content: {
        ...common,
        kind: 'AGENT',
        id: 'analysis-agent',
        role: 'read-only analyst',
        modelRef: ref('test-model'),
        modelSettings: { thinking: 'DISABLED' },
        promptRef: ref('analysis'),
        unitRefs: [
          ref('file-read'),
          ref('context-assemble'),
          ref('model-call'),
          ref('report-publish'),
        ],
        startUnitRefs: [],
        actions: { finish: { toolRef: ref('finish-analysis') } },
        limits: { maxRounds: 5, maxToolCallsPerRound: 4 },
      },
    },
  ];
}

/** Returns a copy of `document` with its content shallowly patched. */
export function patchDocument(
  document: SourceDocument,
  patch: Readonly<Record<string, unknown>>,
): SourceDocument {
  return { origin: document.origin, content: { ...(document.content as object), ...patch } };
}

/** Finds the first fixture document by origin prefix, e.g. `tools/`. */
export function documentAt(documents: readonly SourceDocument[], prefix: string): SourceDocument {
  const document = documents.find((candidate) => candidate.origin.startsWith(prefix));
  if (!document) throw new Error(`no fixture document under ${prefix}`);
  return document;
}
