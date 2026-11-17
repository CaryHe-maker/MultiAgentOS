import {
  normalizeRequestPath,
  type ArtifactRef,
  type SessionLogRecord,
  type SubagentResult,
} from '@multiagentos/contracts';

/**
 * What a task of `run_subagents` came to (M2Design 3.6, 3.7). Pure functions of the log and of the
 * arguments of `finish_subagent`, so the same log gives the same join.
 */
export type TaskStatus = 'DONE' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'SKIPPED';

export interface TaskOutcome {
  readonly status: TaskStatus;
  readonly notes: readonly string[];
  readonly outputRef?: ArtifactRef;
  readonly toolCallId?: string;
  /** The handover that carries its result and what it listed (Workflow, handover.ts). */
  readonly referenceId?: string;
}

const NOTE_LIMIT = 300;
const MAX_NOTES = 10;

const cut = (text: string): string =>
  text.length <= NOTE_LIMIT ? text : `${text.slice(0, NOTE_LIMIT - 1)}…`;

export const notesOf = (notes: readonly string[]): readonly string[] =>
  notes.slice(0, MAX_NOTES).map(cut);

/** What goes into `NODE_ENDED.result` of a task: the join and later tasks read it. */
export function resultOf(outcome: TaskOutcome): Record<string, unknown> {
  return {
    action: 'FINISH_SUBAGENT',
    status: outcome.status,
    notes: [...notesOf(outcome.notes)],
    ...(outcome.toolCallId === undefined ? {} : { toolCallId: outcome.toolCallId }),
    ...(outcome.referenceId === undefined ? {} : { referenceId: outcome.referenceId }),
  };
}

/** The outcome a task's node recorded when it ended; undefined while it has not. */
export function outcomeOf(
  records: readonly SessionLogRecord[],
  workflowRunId: string,
  nodeId: string,
): TaskOutcome | undefined {
  const ended = [...records]
    .reverse()
    .find(
      (record) =>
        record.type === 'NODE_ENDED' &&
        record.workflowRunId === workflowRunId &&
        record.nodeId === nodeId,
    );
  if (ended?.type !== 'NODE_ENDED') return undefined;
  if (ended.status === 'SKIPPED')
    return {
      status: 'SKIPPED',
      notes: [
        ended.skipReason === 'DEPENDENCY_FAILED'
          ? 'not started: a task it depends on did not finish'
          : 'not started',
      ],
    };
  const result = ended.result ?? {};
  const rawNotes: unknown = result['notes'];
  const notes = Array.isArray(rawNotes)
    ? rawNotes.filter((note): note is string => typeof note === 'string')
    : [];
  const status = result['status'];
  const known: readonly unknown[] = ['DONE', 'PARTIAL', 'BLOCKED', 'FAILED'];
  const toolCallId = result['toolCallId'];
  return {
    status: known.includes(status) ? (status as TaskStatus) : 'FAILED',
    notes,
    ...(ended.resultRef === undefined ? {} : { outputRef: ended.resultRef }),
    ...(typeof toolCallId === 'string' ? { toolCallId } : {}),
    ...(typeof result['referenceId'] === 'string' ? { referenceId: result['referenceId'] } : {}),
  };
}

interface FinishArguments {
  readonly references?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly status?: SubagentResult['status'];
  readonly validation?: readonly { readonly command: string; readonly exitCode: number }[];
}

const normalized = (paths: readonly string[]): Set<string> =>
  new Set(paths.map((path) => normalizeRequestPath(path) ?? path));

/**
 * The status and notes of a task that finished by itself. Differences between what the worker
 * says it changed and what the Kernel saw come first (M2Design 3.6).
 */
export function finishedOutcome(
  args: FinishArguments,
  observedChanges: readonly string[] | undefined,
  /** The check the system saw pass after the last change: said once, by the system. */
  seenCheck?: string,
): { readonly status: TaskStatus; readonly notes: readonly string[] } {
  const notes: string[] = [];
  // The checks it ran are shown to the caller, so it does not run them again.
  if (seenCheck !== undefined)
    notes.push(
      `checked: the system saw \`${seenCheck}\` exit 0 after the last change (output below)`,
    );
  for (const check of (args.validation ?? [])
    .filter((each) => each.command !== seenCheck)
    .slice(0, 4))
    notes.push(`checked, as it reports: \`${check.command}\` exit ${String(check.exitCode)}`);
  if (args.changedFiles !== undefined && observedChanges !== undefined) {
    const claimed = normalized(args.changedFiles);
    const seen = normalized(observedChanges);
    const unseen = [...claimed].filter((path) => !seen.has(path));
    const unreported = [...seen].filter((path) => !claimed.has(path));
    if (unseen.length > 0)
      notes.push(`reported as changed but no change was seen: ${unseen.join(', ')}`);
    if (unreported.length > 0) notes.push(`changed but not reported: ${unreported.join(', ')}`);
  }
  const status: TaskStatus =
    args.status === 'blocked' ? 'BLOCKED' : args.status === 'partial' ? 'PARTIAL' : 'DONE';
  return { status, notes: notesOf(notes) };
}
