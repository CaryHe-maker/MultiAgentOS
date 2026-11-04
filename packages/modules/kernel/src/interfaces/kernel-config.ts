import type { KernelConfig } from '@multiagentos/contracts';

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
  convergenceMarginMs: 1_000,
  technicalRetryLimit: 3,
  retryBackoffBaseMs: 1_000,
  retryAfterMaxMs: 120_000,
  sessionCloseTimeoutMs: 10_000,
  repositoryExclusions: [],
  maxSnapshotFiles: 20_000,
  maxReportBytes: 262_144,
  budget: Object.freeze({
    runTokenLimit: 12_000_000,
    turnTokenLimit: 4_000_000,
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
    CONTEXT_ASSEMBLE: Object.freeze({ timeoutMs: 30_000, maxOutputBytes: 16_777_216 }),
    MODEL: Object.freeze({ timeoutMs: 900_000, maxOutputBytes: 1_048_576 }),
  }),
  artifactRetention: Object.freeze({ expiringRetentionDays: 7, sweepIntervalMinutes: 60 }),
});
