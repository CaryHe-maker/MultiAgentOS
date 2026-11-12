import { DEFAULT_READ_ONLY_COMMANDS, type KernelConfig } from '@multiagentos/contracts';

const toolLimit = (timeoutMs: number, maxOutputBytes: number) =>
  Object.freeze({
    timeoutMs,
    maxOutputBytes,
    previewMaxBytes: 51_200,
    previewMaxLines: 2_000,
    maxFullOutputBytes: 8_388_608,
  });

/**
 * The defaults of Kernel/Interaction 9, Kernel/Execution 7 and Kernel/Monitor 6; all of them
 * still need calibration with the fixed task set.
 */
export const DEFAULT_KERNEL_CONFIG: KernelConfig = Object.freeze({
  provider: 'deepseek',
  cancelGraceMs: 5_000,
  pauseDrainMs: 5_000,
  turnTimeoutSeconds: 1_800,
  orchestrationTimeoutSeconds: 14_400,
  maxPauseSeconds: 1_800,
  convergenceMarginMs: 1_000,
  technicalRetryLimit: 3,
  retryBackoffBaseMs: 1_000,
  retryAfterMaxMs: 120_000,
  sessionCloseTimeoutMs: 10_000,
  repositoryExclusions: [],
  maxSnapshotFiles: 20_000,
  maxReportBytes: 262_144,
  sandbox: Object.freeze({
    unavailable: 'deny' as const,
    homeReadOnly: ['~/.nvm', '~/.volta', '~/.cargo', '~/.rustup', '~/.local/bin', '~/.npm'],
    mountPath: true,
    homeMaskedFiles: ['~/.cargo/credentials.toml', '~/.npmrc'],
  }),
  sandboxMaskedPatterns: [],
  command: Object.freeze({
    deniedCommands: [],
    criticalCommands: [],
    readOnlyCommands: [...DEFAULT_READ_ONLY_COMMANDS],
  }),
  web: Object.freeze({
    deniedDomains: [],
    maxContentBytes: 2_097_152,
    search: Object.freeze({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com' }),
    fetch: Object.freeze({
      remote: Object.freeze({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com' }),
    }),
  }),
  compaction: Object.freeze({
    triggerRatio: 0.9,
    keepRatio: 0.15,
    keepHumanBytes: 16_384,
    pruneMinBytes: 8_192,
    pruneHeadBytes: 4_096,
    pruneTailBytes: 1_024,
    summaryMaxTokens: 16_384,
    overflowTargets: [0.85, 0.7, 0.5],
    summaryFallbackTargets: [0.85, 0.7, 0.5, 0.35],
    summaryReasoningEffort: 'none' as const,
  }),
  killGraceMs: 2_000,
  maxConcurrentExec: 1,
  maxConcurrentAttempts: 6,
  maxConcurrentWeb: 10,
  providerCapacity: 3,
  serialExecution: false,
  memory: Object.freeze({ sampleIntervalMs: 1_000, warningRatio: 0.75, dangerRatio: 0.9 }),
  budget: Object.freeze({
    runTokenLimit: 24_000_000,
    turnTokenLimit: 8_000_000,
    orientBudget: 1_200,
    searchBudget: 1_200,
  }),
  executionLimits: Object.freeze({
    REPOSITORY_ORIENT: toolLimit(60_000, 1_048_576),
    REPOSITORY_SEARCH: toolLimit(30_000, 1_048_576),
    REPOSITORY_LIST: toolLimit(30_000, 1_048_576),
    FILE_READ: toolLimit(10_000, 16_384),
    FILE_WRITE: toolLimit(10_000, 16_384),
    FILE_EDIT: toolLimit(10_000, 16_384),
    OUTPUT_READ: toolLimit(10_000, 51_200),
    COMMAND: toolLimit(600_000, 8_388_608),
    GIT_INSPECT: toolLimit(30_000, 1_048_576),
    WEB_SEARCH: toolLimit(30_000, 1_048_576),
    WEB_FETCH: toolLimit(30_000, 4_194_304),
    CONTEXT_ASSEMBLE: Object.freeze({ timeoutMs: 30_000, maxOutputBytes: 16_777_216 }),
    CONTEXT_PRUNE: Object.freeze({ timeoutMs: 30_000, maxOutputBytes: 16_777_216 }),
    MODEL: Object.freeze({ timeoutMs: 900_000, maxOutputBytes: 1_048_576 }),
  }),
  artifactRetention: Object.freeze({ expiringRetentionDays: 7, sweepIntervalMinutes: 60 }),
});
