import { Type, type Static } from 'typebox';
import { ThinkingEffortSchema } from '../executor/model-call.js';
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
    /** How long a pausing run lets its READ Units finish before it cancels them (M2Design 4.4). */
    pauseDrainMs: ms(),
    /** The longest the work of one input of Turn-chat goes on, not counting a pause (7.4). */
    inputTimeoutSeconds: count(1),
    /** The same for an Orchestration run, which is the work of its one input. */
    orchestrationTimeoutSeconds: count(1),
    /** The longest a run stays paused before it is interrupted (M2Design 4.3). */
    maxPauseSeconds: count(1),
    convergenceMarginMs: ms(),
    technicalRetryLimit: count(),
    retryBackoffBaseMs: ms(),
    retryAfterMaxMs: ms(),
    sessionCloseTimeoutMs: ms(),
    /** Appended to the default exclusion rules; it can never remove one of them. */
    repositoryExclusions: Type.Array(ExclusionRuleSchema),
    maxSnapshotFiles: count(1),
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
      /**
       * How a command that no list names is let through (M2Design 5.2, 2026-11-14): `auto` runs it
       * without a question when it is in the sandbox, without the network, and parses reliably,
       * once the run may write and read the repository; `ask` asks for each as before. A command
       * with the network, of the critical list, or that cannot be parsed reliably is always asked.
       */
      approval: Type.Enum(['ask', 'auto']),
    }),
    /** The web tools (Kernel/Core 5f, ExecutorSet 5d); the key is the model provider's, not here. */
    web: closed({
      /** Hosts that are refused without asking; `example.com` also covers `a.example.com`. */
      deniedDomains: Type.Array(text(253)),
      /** A fetched page is cut here. */
      maxContentBytes: count(1),
      /** The provider is named; the name is also what its key is looked up under (`<NAME>_API_KEY`). */
      search: closed({ provider: text(32), baseUrl: text(200) }),
      /**
       * This program fetches first. `remote` is asked only when it cannot (ExecutorSet 5d); null
       * means never, and then no address is given to anyone.
       */
      fetch: closed({
        remote: Type.Union([Type.Null(), closed({ provider: text(32), baseUrl: text(200) })]),
      }),
    }),
    /** Context compaction (M2Design 9.6, Kernel/Core 6a); the values were checked on one model only. */
    compaction: closed({
      /** Compact at a checkpoint when the estimate passes this share of `perCallInputLimit`. */
      triggerRatio: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
      /**
       * The newest part of a projection that stays as it is, counted from a whole model turn, as a
       * share of `perCallInputLimit`; it must be less than `triggerRatio`.
       */
      keepRatio: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
      /** User messages kept as they are, at most this many bytes together (M2Design 9.6, tiers). */
      keepHumanBytes: count(0),
      /** A tool result is cut only when its preview is longer than this. */
      pruneMinBytes: count(1),
      pruneHeadBytes: count(1),
      pruneTailBytes: count(1),
      summaryMaxTokens: count(1),
      /** After an overflow, the shares of the size it had that the next try aims at. */
      overflowTargets: Type.Array(Type.Number({ exclusiveMinimum: 0, maximum: 1 }), {
        minItems: 1,
        maxItems: 5,
      }),
      /** A summary request that is itself refused for size is tried again at these shares. */
      summaryFallbackTargets: Type.Array(Type.Number({ exclusiveMinimum: 0, maximum: 1 }), {
        minItems: 1,
        maxItems: 6,
      }),
      summaryReasoningEffort: ThinkingEffortSchema,
    }),
    killGraceMs: ms(),
    maxConcurrentExec: count(1),
    /** UnitAttempts executing at the same time, over all AgentRuns (M2Design 7.1). */
    maxConcurrentAttempts: count(1),
    /** Web searches and fetches in flight at the same time; they take no place of the attempts, and the rest wait (M2Design 7.1). */
    maxConcurrentWeb: count(1),
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
      inputTokenLimit: count(1),
      /**
       * What happens when the work of an input is about to run out of `inputTokenLimit` while the
       * run still has tokens (M2Design 7.3, rule 6): `ask` the user (y adds half of
       * `inputTokenLimit`, n lets the work wrap up), `extend` without asking, or `stop` (wrap up,
       * as before). At most `max` times for one input. `ask`, 4 times, when absent; a run nobody
       * watches (an evaluation, a script) sets `stop` or `extend`.
       */
      extension: Type.Optional(
        closed({
          mode: Type.Enum(['ask', 'extend', 'stop']),
          max: count(),
        }),
      ),
      /**
       * The share of a call's input the ledgers count it at (M2Design 7.3, rule 7): the reserves,
       * the least share a task opens with and the reservation of every call take the input limits
       * at this share, since most of a call's input is the cached prefix of the one before. 0.3
       * when absent; 1 counts every call at its whole input limit, as before.
       */
      reserveShare: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
      searchBudget: count(1),
    }),
    executionLimits: closed({
      REPOSITORY_SEARCH: ToolLimitSchema,
      REPOSITORY_LIST: ToolLimitSchema,
      FILE_READ: ToolLimitSchema,
      FILE_WRITE: ToolLimitSchema,
      FILE_EDIT: ToolLimitSchema,
      OUTPUT_READ: ToolLimitSchema,
      COMMAND: ToolLimitSchema,
      GIT_INSPECT: ToolLimitSchema,
      WEB_SEARCH: ToolLimitSchema,
      WEB_FETCH: ToolLimitSchema,
      CONTEXT_ASSEMBLE: ExecutionLimitSchema,
      CONTEXT_PRUNE: ExecutionLimitSchema,
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
