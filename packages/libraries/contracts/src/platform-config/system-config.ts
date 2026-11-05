import { Type, type Static } from 'typebox';
import { ExclusionRuleSchema } from '../platform-common/repository-exclusions.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

const ms = () => count(1);
const ExecutionLimitSchema = closed({ timeoutMs: ms(), maxOutputBytes: count(1) });
export type BudgetConfig = KernelConfig['budget'];

const ToolLimitSchema = closed({
  timeoutMs: ms(),
  maxOutputBytes: count(1),
  previewMaxBytes: count(1),
  previewMaxLines: count(1),
  maxFullOutputBytes: count(1),
});

/**
 * The `kernel` part. `repositoryRoot` and `preset` are not configured: the composition
 * root sets them from the working directory or `--repo` and from the CLI.
 */
export const KernelConfigSchema = closed(
  {
    provider: text(64),
    cancelGraceMs: ms(),
    convergenceMarginMs: ms(),
    technicalRetryLimit: count(),
    retryBackoffBaseMs: ms(),
    retryAfterMaxMs: ms(),
    sessionCloseTimeoutMs: ms(),
    /** Appended to the default exclusion rules; it can never remove one of them. */
    repositoryExclusions: Type.Array(ExclusionRuleSchema),
    maxSnapshotFiles: count(1),
    maxReportBytes: count(1),
    /** The sandbox of commands (Interface/KernelSupervisor 9). */
    sandbox: closed({
      unavailable: Type.Enum(['deny', 'ask-unisolated']),
      homeReadOnly: Type.Array(text(4096)),
      /** The PATH directories below $HOME come back read-only too (M2Design 6.1, v1.18). */
      mountPath: Type.Boolean(),
      homeMaskedFiles: Type.Array(text(4096)),
    }),
    /** Appended to the default secret rules; it can never remove one of them. */
    sandboxMaskedPatterns: Type.Array(ExclusionRuleSchema),
    command: closed({
      deniedCommands: Type.Array(text(200)),
      /** Appended to the defaults; a default cannot be removed. */
      criticalCommands: Type.Array(text(200)),
    }),
    killGraceMs: ms(),
    maxConcurrentExec: count(1),
    memory: closed({
      sampleIntervalMs: ms(),
      warningRatio: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
      dangerRatio: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    }),
    /** The per-call parameters live in each Agent definition (Kernel/Monitor 6). */
    budget: closed({
      runTokenLimit: count(1),
      turnTokenLimit: count(1),
      orientBudget: count(1),
      searchBudget: count(1),
    }),
    executionLimits: closed({
      REPOSITORY_ORIENT: ToolLimitSchema,
      REPOSITORY_SEARCH: ToolLimitSchema,
      REPOSITORY_LIST: ToolLimitSchema,
      FILE_READ: ToolLimitSchema,
      FILE_WRITE: ToolLimitSchema,
      FILE_EDIT: ToolLimitSchema,
      OUTPUT_READ: ToolLimitSchema,
      COMMAND: ToolLimitSchema,
      GIT_INSPECT: ToolLimitSchema,
      CONTEXT_ASSEMBLE: ExecutionLimitSchema,
      MODEL: ExecutionLimitSchema,
    }),
    artifactRetention: closed({
      expiringRetentionDays: count(1),
      sweepIntervalMinutes: count(1),
    }),
  },
  'platform.config.KernelConfig.v1',
);
export type KernelConfig = Static<typeof KernelConfigSchema>;

/** The entry Agent comes from the template, so `entryAgentRef` is gone. */
export const WorkflowConfigSchema = closed(
  {
    regenerationLimit: count(1),
    noProgressRounds: count(1),
    repeatedIntent: closed({ window: count(1), warnAt: count(1), stopAt: count(1) }),
    consecutiveErrorLimit: count(1),
    maxNestedInstructions: count(1),
  },
  'platform.config.WorkflowConfig.v1',
);
export type WorkflowConfig = Static<typeof WorkflowConfigSchema>;

export const SystemConfigSchema = closed(
  {
    /** System data directory; an absolute path. */
    dataDir: text(4096),
    /** How long Workflow and UserInteraction wait for a port to return. */
    portReturnTimeoutMs: ms(),
    kernel: KernelConfigSchema,
    workflow: WorkflowConfigSchema,
  },
  'platform.config.SystemConfig.v1',
);
export type SystemConfig = Static<typeof SystemConfigSchema>;
