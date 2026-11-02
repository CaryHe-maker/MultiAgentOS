import { Type, type Static } from 'typebox';
import { DefinitionRefSchema } from '../catalog/definition-schemas.js';
import { ExclusionRuleSchema } from '../platform-common/repository-exclusions.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

const ms = () => count(1);
const ExecutionLimitSchema = closed({ timeoutMs: ms(), maxOutputBytes: count(1) });

/** The `kernel` part of the system configuration (docs/M1/Kernel/Interaction.md 9). */
export const KernelConfigSchema = closed(
  {
    provider: text(64),
    runTimeoutMs: ms(),
    authorizationTimeoutMs: ms(),
    cancelGraceMs: ms(),
    convergenceMarginMs: ms(),
    technicalRetryLimit: count(),
    retryBackoffBaseMs: ms(),
    /** Appended to the default exclusion rules; it can never remove one of them. */
    repositoryExclusions: Type.Array(ExclusionRuleSchema),
    maxSnapshotFiles: count(1),
    maxReportBytes: count(1),
    /** Token budget of one WorkflowRun (docs/M1/Kernel/Monitor.md 4). */
    budget: closed({
      tokenLimit: count(1),
      perCallInputLimit: count(1),
      finalInputBudget: count(1),
      maxOutputTokens: count(1),
      finalMaxOutputTokens: count(1),
      orientBudget: count(1),
      searchBudget: count(1),
    }),
    executionLimits: closed({
      REPOSITORY_ORIENT: ExecutionLimitSchema,
      REPOSITORY_SEARCH: ExecutionLimitSchema,
      FILE_READ: ExecutionLimitSchema,
      CONTEXT_ASSEMBLE: ExecutionLimitSchema,
      MODEL: ExecutionLimitSchema,
    }),
  },
  'platform.config.KernelConfig.v0',
);
export type KernelConfig = Static<typeof KernelConfigSchema>;
export type BudgetConfig = KernelConfig['budget'];

/** The `workflow` part of the system configuration (docs/M1/Module/Workflow.md 12). */
export const WorkflowConfigSchema = closed(
  {
    entryAgentRef: DefinitionRefSchema,
    regenerationLimit: count(1),
    noProgressRounds: count(1),
  },
  'platform.config.WorkflowConfig.v0',
);
export type WorkflowConfig = Static<typeof WorkflowConfigSchema>;

/**
 * The whole system configuration (docs/M1/M1TechStack.md 4). The composition root validates it
 * and injects each part into its owner. Secrets never belong here: they come from environment
 * variables only.
 */
export const SystemConfigSchema = closed(
  {
    /** System data directory; an absolute path. */
    dataDir: text(4096),
    /**
     * How long Workflow and UserInteraction wait for a port to return (M1Interface 14.3);
     * Fabric and the composition root enforce it.
     */
    portReturnTimeoutMs: ms(),
    kernel: KernelConfigSchema,
    workflow: WorkflowConfigSchema,
  },
  'platform.config.SystemConfig.v0',
);
export type SystemConfig = Static<typeof SystemConfigSchema>;

// --- Major 1 (Kernel/Interaction 9, Kernel/Execution 7, Kernel/Monitor 6, Module/Workflow 11) ---

const ToolLimitV1Schema = closed({
  timeoutMs: ms(),
  maxOutputBytes: count(1),
  previewMaxBytes: count(1),
  previewMaxLines: count(1),
  maxFullOutputBytes: count(1),
});

/**
 * The `kernel` part in major 1. `repositoryRoot` and `preset` are not configured: the composition
 * root sets them from the working directory or `--repo` and from the CLI.
 */
export const KernelConfigV1Schema = closed(
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
    /** The per-call parameters live in each Agent definition (Kernel/Monitor 6). */
    budget: closed({
      runTokenLimit: count(1),
      turnTokenLimit: count(1),
      orientBudget: count(1),
      searchBudget: count(1),
    }),
    executionLimits: closed({
      REPOSITORY_ORIENT: ToolLimitV1Schema,
      REPOSITORY_SEARCH: ToolLimitV1Schema,
      REPOSITORY_LIST: ToolLimitV1Schema,
      FILE_READ: ToolLimitV1Schema,
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
export type KernelConfigV1 = Static<typeof KernelConfigV1Schema>;

/** The entry Agent comes from the template, so `entryAgentRef` is gone. */
export const WorkflowConfigV1Schema = closed(
  {
    regenerationLimit: count(1),
    noProgressRounds: count(1),
    repeatedIntent: closed({ window: count(1), warnAt: count(1), stopAt: count(1) }),
    consecutiveErrorLimit: count(1),
  },
  'platform.config.WorkflowConfig.v1',
);
export type WorkflowConfigV1 = Static<typeof WorkflowConfigV1Schema>;

export const SystemConfigV1Schema = closed(
  {
    /** System data directory; an absolute path. */
    dataDir: text(4096),
    /** How long Workflow and UserInteraction wait for a port to return. */
    portReturnTimeoutMs: ms(),
    kernel: KernelConfigV1Schema,
    workflow: WorkflowConfigV1Schema,
  },
  'platform.config.SystemConfig.v1',
);
export type SystemConfigV1 = Static<typeof SystemConfigV1Schema>;
