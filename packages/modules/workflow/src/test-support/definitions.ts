import type { PinnedDefinitionSet, ToolDefinition, UnitDefinition } from '@multiagentos/contracts';

const header = {
  schemaVersion: 'v0' as const,
  version: 'v0.1.0',
  digest: 'a'.repeat(64),
  description: '测试固定定义',
};

/** Small Schema-valid sets, independent of other modules and shared fakes. */
export function definitions(id = 'planner', hasHandoff = true): PinnedDefinitionSet {
  const set: PinnedDefinitionSet = {
    schemaVersion: 'v0',
    agent: {
      ...header,
      kind: 'AGENT',
      id,
      role: '测试分析 Agent',
      modelRef: { id: 'test-model', version: 'v0.1.0' },
      modelSettings: { thinking: 'DISABLED' },
      promptRef: { id: 'test-prompt', version: 'v0.1.0' },
      unitRefs: ['model-call', 'context-assemble', 'report-publish'].map((id) => ({
        id,
        version: 'v0.1.0',
      })),
      startUnitRefs: [],
      actions: {
        finish: { toolRef: { id: 'finish-analysis', version: 'v0.1.0' } },
        ...(hasHandoff
          ? {
              handoff: {
                toolRef: { id: 'handoff-to-code-viewer', version: 'v0.1.0' },
                targetAgentRef: { id: 'code-viewer', version: 'v0.1.0' },
              },
            }
          : {}),
      },
      limits: { maxRounds: 3, maxToolCallsPerRound: 0 },
    },
    model: {
      ...header,
      kind: 'MODEL',
      id: 'test-model',
      provider: 'test-provider',
      apiModelId: 'test-model',
      providerModelLabel: '测试模型',
      apiProtocol: 'OPENAI_CHAT_COMPLETIONS',
      baseUrl: 'https://example.invalid',
      limits: { contextWindowTokens: 1000, maxOutputTokens: 100 },
      features: {
        hasJsonOutput: true,
        hasToolCalls: true,
        hasVision: false,
        thinking: { isSupported: false, isEnabledByDefault: false, effortLevels: [] },
      },
      pricing: {
        currency: 'USD',
        unit: 'MICRO_USD_PER_MILLION_TOKENS',
        offPeak: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
        peak: {
          ratePercent: 100,
          timeZone: 'UTC',
          weekdays: [1],
          windows: [{ start: '01:00', end: '02:00' }],
        },
        source: { url: 'https://example.invalid/pricing', verifiedOn: '2026-10-14' },
      },
    },
    prompt: {
      ...header,
      kind: 'PROMPT',
      id: 'test-prompt',
      role: 'system',
      template: '测试分析',
      variables: [],
      contentStatus: 'FINAL',
    },
    units: [
      {
        ...header,
        kind: 'UNIT',
        id: 'model-call',
        executionKind: 'MODEL',
        protectedCapabilities: [],
        toolRefs: [],
        effect: 'READ_ONLY',
        isIdempotent: false,
        inputContract: { kind: 'contract', id: 'executor.ModelCallInput', version: 'v0' },
        outputContract: { kind: 'contract', id: 'executor.ModelCallOutput', version: 'v0' },
        failurePolicy: {},
      },
      ...(['CONTEXT_ASSEMBLE', 'REPORT_PUBLISH'] as const).map((executionKind): UnitDefinition => ({
        ...header,
        kind: 'UNIT',
        id: executionKind === 'CONTEXT_ASSEMBLE' ? 'context-assemble' : 'report-publish',
        executionKind,
        protectedCapabilities: [],
        toolRefs: [],
        effect: 'READ_ONLY',
        isIdempotent: true,
        inputContract: {
          kind: 'contract',
          version: 'v0',
          id:
            executionKind === 'CONTEXT_ASSEMBLE'
              ? 'context.ContextAssembleInput'
              : 'kernel.unit.ReportPublishInput',
        },
        outputContract: {
          kind: 'contract',
          version: 'v0',
          id:
            executionKind === 'CONTEXT_ASSEMBLE'
              ? 'context.ContextAssembleOutput'
              : 'kernel.unit.ReportPublishOutput',
        },
        failurePolicy: {},
      })),
    ],
    tools: [
      {
        ...header,
        kind: 'TOOL',
        id: 'finish-analysis',
        purpose: 'CONTROL',
        modelName: 'finish_analysis',
        modelDescription: '完成分析',
        parametersContract: { kind: 'contract', id: 'workflow.AnalysisReportDraft', version: 'v0' },
        riskClass: 'READ_ONLY',
        sideEffect: 'NONE',
        isIdempotent: true,
        contentStatus: 'FINAL',
      },
      ...(hasHandoff
        ? [
            {
              ...header,
              kind: 'TOOL' as const,
              id: 'handoff-to-code-viewer',
              purpose: 'CONTROL' as const,
              modelName: 'handoff_to_code_viewer',
              modelDescription: '交接分析',
              parametersContract: {
                kind: 'contract' as const,
                id: 'workflow.HandoffBrief',
                version: 'v0',
              },
              riskClass: 'READ_ONLY' as const,
              sideEffect: 'NONE' as const,
              isIdempotent: true,
              contentStatus: 'FINAL' as const,
            },
          ]
        : []),
    ],
    ...(hasHandoff
      ? {
          handoffTargetRef: {
            kind: 'AGENT',
            id: 'code-viewer',
            version: 'v0.1.0',
            digest: header.digest,
          },
        }
      : {}),
    refs: ['AGENT', 'MODEL', 'PROMPT'].map((kind) => ({
      kind: kind as 'AGENT' | 'MODEL' | 'PROMPT',
      id: kind === 'AGENT' ? id : kind === 'MODEL' ? 'test-model' : 'test-prompt',
      version: 'v0.1.0',
      digest: header.digest,
    })),
  };
  return freeze(set);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) freeze(member);
  }
  return value;
}

/** A current Agent with two read-only tools, for interpretation and Validation tests. */
export function repositoryDefinitions(maxToolCallsPerRound = 8): PinnedDefinitionSet {
  const base = definitions('code-viewer', false);
  const contract = (id: string) => ({ kind: 'contract' as const, id, version: 'v0' });
  const tools: ToolDefinition[] = [
    {
      ...header,
      kind: 'TOOL',
      id: 'read-file',
      purpose: 'UNIT',
      modelName: 'read_file',
      modelDescription: 'Read a repository file',
      parametersContract: contract('executor.FileReadInput'),
      riskClass: 'READ_ONLY',
      sideEffect: 'NONE',
      isIdempotent: true,
      contentStatus: 'FINAL',
    },
    {
      ...header,
      kind: 'TOOL',
      id: 'search-repository',
      purpose: 'UNIT',
      modelName: 'search_repository',
      modelDescription: 'Search the repository',
      parametersContract: contract('context.RepositorySearchInput'),
      riskClass: 'READ_ONLY',
      sideEffect: 'NONE',
      isIdempotent: true,
      contentStatus: 'FINAL',
    },
  ];
  const units: UnitDefinition[] = [
    {
      ...header,
      kind: 'UNIT',
      id: 'file-read',
      executionKind: 'FILE_READ',
      protectedCapabilities: ['repo.read'],
      inputContract: contract('executor.FileReadInput'),
      outputContract: contract('executor.FileReadOutput'),
      toolRefs: [{ id: 'read-file', version: header.version }],
      effect: 'READ_ONLY',
      isIdempotent: true,
      failurePolicy: { USER_DECLINED: 'FINAL_CALL' },
    },
    {
      ...header,
      kind: 'UNIT',
      id: 'repository-search',
      executionKind: 'REPOSITORY_SEARCH',
      protectedCapabilities: ['repo.read'],
      inputContract: contract('context.RepositorySearchInput'),
      outputContract: contract('context.RepositorySearchOutput'),
      toolRefs: [{ id: 'search-repository', version: header.version }],
      effect: 'READ_ONLY',
      isIdempotent: true,
      failurePolicy: { USER_DECLINED: 'FINAL_CALL' },
    },
  ];
  return freeze({
    ...base,
    agent: {
      ...base.agent,
      limits: { ...base.agent.limits, maxToolCallsPerRound },
      unitRefs: [...base.agent.unitRefs, ...units.map(({ id, version }) => ({ id, version }))],
    },
    units: [...base.units, ...units],
    tools: [...base.tools, ...tools],
    refs: [...base.refs, ...units, ...tools].map(({ kind, id, version, digest }) => ({
      kind,
      id,
      version,
      digest,
    })),
  });
}
