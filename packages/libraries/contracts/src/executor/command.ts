import { Type, type Static } from 'typebox';
import { SANDBOX_BACKENDS } from '../platform-common/sandbox.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';
import { RetentionNoticeSchema } from './retention.js';

/** The longest a `run_command` may run (M2Design 6.1: default 2 minutes, parameter limit 10). */
export const COMMAND_DEFAULT_TIMEOUT_MS = 120_000;
export const COMMAND_MAX_TIMEOUT_MS = 600_000;

/** The parameters of the `run_command` tool. */
export const RunCommandArgsSchema = closed(
  {
    command: text(8000),
    /** Relative to the repository root. */
    workdir: Type.Optional(Type.String({ maxLength: 1024 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: COMMAND_MAX_TIMEOUT_MS })),
    /** Needs `command.network`, which is asked every time and only main has. */
    network: Type.Optional(Type.Boolean()),
  },
  'executor.RunCommandArgs.v1',
);
export type RunCommandArgs = Static<typeof RunCommandArgsSchema>;

/** What Workflow submits: the tool's arguments with the defaults filled in. */
export const CommandInputSchema = closed(
  {
    command: text(8000),
    workdir: Type.String({ maxLength: 1024 }),
    timeoutMs: Type.Integer({ minimum: 1, maximum: COMMAND_MAX_TIMEOUT_MS }),
    network: Type.Boolean(),
  },
  'executor.CommandInput.v1',
);
export type CommandInput = Static<typeof CommandInputSchema>;

/** What the Executor gets once Core has decided the rest (workdir, network) into the scope. */
export const CommandExecutorInputSchema = closed(
  { command: text(8000), timeoutMs: Type.Integer({ minimum: 1, maximum: COMMAND_MAX_TIMEOUT_MS }) },
  'kernel.execution.CommandExecutorInput.v1',
);
export type CommandExecutorInput = Static<typeof CommandExecutorInputSchema>;

/** A non-zero exit, a timeout with output, a sandbox refusal are results, not failures. */
export const CommandOutputSchema = closed(
  {
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([text(32), Type.Null()]),
    timedOut: Type.Boolean(),
    backend: Type.Enum(SANDBOX_BACKENDS),
    sandboxDenials: count(),
    /** Present when the preview left something out. */
    retention: Type.Optional(RetentionNoticeSchema),
  },
  'executor.CommandOutput.v1',
);
export type CommandOutput = Static<typeof CommandOutputSchema>;

// --- git_inspect --------------------------------------------------------------------------------

export const GIT_ACTIONS = ['status', 'diff', 'log', 'show', 'blame'] as const;
export const GIT_LOG_MAX = 50;

const gitFields = {
  action: Type.Enum(GIT_ACTIONS),
  staged: Type.Optional(Type.Boolean()),
  path: Type.Optional(text(1024)),
  /** A revision such as `HEAD~2` or a commit; never an option. */
  rev: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_./~^@-]{1,200}$' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: GIT_LOG_MAX })),
  /** `start,end` for blame. */
  lines: Type.Optional(Type.String({ pattern: '^[0-9]{1,7},[0-9]{1,7}$' })),
};

/** Fixed sub-commands and arguments only: there is no free-form argument list. */
export const GitInspectArgsSchema = closed(gitFields, 'executor.GitInspectArgs.v1');
export type GitInspectArgs = Static<typeof GitInspectArgsSchema>;

export const GitInspectInputSchema = Type.Refine(
  closed(gitFields, 'executor.GitInspectInput.v1'),
  (input) => {
    if (input.action === 'show' && input.rev === undefined) return false;
    if (input.action === 'blame' && input.path === undefined) return false;
    if (input.action !== 'blame' && input.lines !== undefined) return false;
    if (input.rev !== undefined && input.rev.startsWith('-')) return false;
    return true;
  },
  () => 'show needs rev, blame needs path, lines belongs to blame, a rev is not an option',
);
export type GitInspectInput = Static<typeof GitInspectInputSchema>;

export const GitInspectOutputSchema = closed(
  {
    action: Type.Enum(GIT_ACTIONS),
    /** False when the directory is not a git repository (the call is UNSUPPORTED then). */
    retention: Type.Optional(RetentionNoticeSchema),
  },
  'executor.GitInspectOutput.v1',
);
export type GitInspectOutput = Static<typeof GitInspectOutputSchema>;
