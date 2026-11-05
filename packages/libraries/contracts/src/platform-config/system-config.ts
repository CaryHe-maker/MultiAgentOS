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
      /**
       * The read-only list (M2Design 5.2): a line made only of these runs without a question of its
       * own once `repo.read` is allowed, in a sandbox that cannot write. It replaces the default,
       * so an entry can be taken out; an empty list switches the shortcut off. `git` and `command`
       * stand for their read-only subcommands.
       */
      readOnlyCommands: Type.Array(text(100)),
    }),
    killGraceMs: ms(),
    maxConcurrentExec: count(1),
    /** UnitAttempts executing at the same time, over all AgentRuns (M2Design 7.1). */
    maxConcurrentAttempts: count(1),
    /** Model calls in flight at the same time per provider; the rest wait (M2Design 7.2). */
    providerCapacity: count(1),
    /** Every Unit is a barrier and the global concurrency is 1: for finding races (M2Design 7.1). */
    serialExecution: Type.Boolean(),
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
    /** `run_subagents` (M2Design 3.6). */
    maxSubagentsPerCall: count(1),
    maxDependencyDepth: count(),
    maxTasks: count(1),
    maxSpawnCalls: count(1),
  },
  'platform.config.WorkflowConfig.v1',
);
export type WorkflowConfig = Static<typeof WorkflowConfigSchema>;

/**
 * The read-only list a Session starts with (M2Design 5.2); `command.readOnlyCommands` replaces it.
 */
export const DEFAULT_READ_ONLY_COMMANDS: readonly string[] = Object.freeze([
  // files and directories
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'du',
  'tree',
  'nl',
  'od',
  // search
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  // text
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'comm',
  'fold',
  'jq',
  // paths
  'pwd',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  // the shell itself
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  ':',
  'cd',
  'type',
  'which',
  // `git` and `command` stand for their reading subcommands and options only
  'git',
  'command',
]);

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
