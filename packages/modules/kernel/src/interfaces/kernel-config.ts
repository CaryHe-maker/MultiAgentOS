import type { KernelConfig } from '@multiagentos/contracts';

export type { BudgetConfig, KernelConfig } from '@multiagentos/contracts';

/** The suggested initial values; all of them still need calibration with the fixed task set. */
export const DEFAULT_KERNEL_CONFIG: KernelConfig = Object.freeze({
  provider: 'deepseek',
  runTimeoutMs: 1_800_000,
  authorizationTimeoutMs: 300_000,
  cancelGraceMs: 5_000,
  convergenceMarginMs: 1_000,
  technicalRetryLimit: 3,
  retryBackoffBaseMs: 1_000,
  repositoryExclusions: [],
  maxSnapshotFiles: 20_000,
  maxReportBytes: 262_144,
  budget: {
    tokenLimit: 600_000,
    perCallInputLimit: 64_000,
    finalInputBudget: 48_000,
    maxOutputTokens: 8_192,
    finalMaxOutputTokens: 8_192,
    orientBudget: 4_000,
    searchBudget: 4_000,
  },
  executionLimits: {
    REPOSITORY_ORIENT: { timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
    REPOSITORY_SEARCH: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    FILE_READ: { timeoutMs: 10_000, maxOutputBytes: 16_384 },
    CONTEXT_ASSEMBLE: { timeoutMs: 30_000, maxOutputBytes: 2_097_152 },
    MODEL: { timeoutMs: 180_000, maxOutputBytes: 1_048_576 },
  },
});
