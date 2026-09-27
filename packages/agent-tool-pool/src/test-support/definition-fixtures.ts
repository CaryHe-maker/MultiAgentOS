import type { SourceDocument } from '../ports/definition-source.js';

/**
 * A minimal, valid draft catalog (no digests) used by this package's tests:
 * agent -> { model, prompt, unit -> tool }. Each call returns fresh objects.
 */
export function draftDocuments(): SourceDocument[] {
  const contract = (id: string) => ({ kind: 'contract', id, version: 'v0' });
  const common = { schemaVersion: 'v0', version: 'v1.0.0', description: 'test fixture' };
  return [
    {
      origin: 'tools/read-file/v1.0.0.yaml',
      content: {
        ...common,
        kind: 'TOOL',
        id: 'read-file',
        modelName: 'read_file',
        modelDescription: 'Read a line range of a file.',
        parametersSchema: { type: 'object' },
        resultSchema: { type: 'object' },
        riskClass: 'READ_ONLY',
        sideEffect: 'NONE',
        isIdempotent: true,
        canDryRun: false,
        contentStatus: 'PLACEHOLDER',
      },
    },
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
    {
      origin: 'units/file-read/v1.0.0.yaml',
      content: {
        ...common,
        kind: 'UNIT',
        id: 'file-read',
        executionKind: 'FILE_READ',
        operations: ['READ_RANGE'],
        inputContract: contract('kernel.unit.UnitIntent'),
        outputContract: contract('kernel.unit.UnitResult'),
        requiredCapabilities: ['file-read'],
        toolRefs: [{ id: 'read-file', version: 'v1.0.0' }],
        effect: 'READ_ONLY',
        isIdempotent: true,
        limits: { timeoutMs: 1_000, maxOutputBytes: 1_024 },
      },
    },
    {
      origin: 'agents/analysis-agent/v1.0.0.yaml',
      content: {
        ...common,
        kind: 'AGENT',
        id: 'analysis-agent',
        role: 'read-only analyst',
        modelRef: { id: 'test-model', version: 'v1.0.0' },
        promptRef: { id: 'analysis', version: 'v1.0.0' },
        unitRefs: [{ id: 'file-read', version: 'v1.0.0' }],
        inputContract: contract('interaction.RunIntent'),
        outputContract: contract('workflow.AnalysisReport'),
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

/** Finds a fixture document by origin prefix, e.g. `tools/`. */
export function documentAt(documents: readonly SourceDocument[], prefix: string): SourceDocument {
  const document = documents.find((candidate) => candidate.origin.startsWith(prefix));
  if (!document) throw new Error(`no fixture document under ${prefix}`);
  return document;
}
