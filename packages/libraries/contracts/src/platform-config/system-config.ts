import { Type, type Static } from 'typebox';
import { DefinitionRefSchema } from '../catalog/definition-schemas.js';
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
    repositoryExclusions: Type.Array(text(512)),
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
    kernel: KernelConfigSchema,
    workflow: WorkflowConfigSchema,
  },
  'platform.config.SystemConfig.v0',
);
export type SystemConfig = Static<typeof SystemConfigSchema>;
