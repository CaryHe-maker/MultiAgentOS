import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

/**
 * The control tools of SubAgents (M2Design 3.6, 3.7): `run_subagents` asks for tasks, and
 * `finish_subagent` returns the result of one.
 */
/**
 * What of a SubAgent's result its caller reads (M2Design 3.7). The result is a short `summary`
 * and then the `report` in full. Both are kept whole in the log. The caller gets the summary and
 * the report when the two together fit these limits, otherwise the summary and the id by which
 * the rest is read; a result is never refused for its length.
 */
export const SUBAGENT_SUMMARY_CHARS = 2000;
export const SUBAGENT_REPORT_LINES = 1000;
export const SUBAGENT_REPORT_CHARS = 60_000;
/** The most tool results of one task that are passed on; the rest of what it lists is left out. */
export const SUBAGENT_MAX_REFERENCES = 20;

const NameSchema = Type.String({ pattern: '^[a-z][a-z0-9_-]{0,39}$' });

/**
 * The ids of its own tool calls whose results the SubAgent thinks its caller should be able to
 * read. Optional, and never a reason to refuse the result: the system checks each one and passes
 * on those that were successful calls of the SubAgent itself.
 */
const referencesField = () => Type.Optional(Type.Array(Type.String()));

/** Text without a length limit: what a model writes is kept, and cut only where it is read. */
const longText = () => Type.String({ minLength: 1 });

/**
 * The Agents a task may run as. Besides explorer, worker and lead, each specialist is a lead that
 * follows the playbook of one pre-orchestrated template (Orchestration 3.9, D39): the template
 * that names it as its `agent`.
 */
export const SPECIALIST_AGENTS = [
  'fixer',
  'reviewer',
  'tester',
  'integrator',
  'researcher',
] as const;
export type SpecialistAgent = (typeof SPECIALIST_AGENTS)[number];

export const SubagentTaskSchema = closed({
  name: NameSchema,
  agent: Type.Enum(['explorer', 'worker', 'lead', ...SPECIALIST_AGENTS]),
  goal: text(4000),
  /** One line on what this task is responsible for, which the tree shows (Orchestration 3.7). */
  role: Type.Optional(text(80)),
  dependsOn: Type.Optional(Type.Array(NameSchema, { maxItems: 11 })),
  writeScope: Type.Optional(Type.Array(text(500), { maxItems: 10 })),
  /** The write permission lent with the scope includes commands unless this is false (D17). */
  commands: Type.Optional(Type.Boolean()),
  inputs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 10 })),
  acceptance: Type.Optional(Type.Array(text(300), { maxItems: 10 })),
  effort: Type.Optional(Type.Enum(['none', 'low', 'high', 'max'])),
  /** Only the token share is the caller's to ask for; the other limits are the Agent's own. */
  budget: Type.Optional(closed({ tokens: count(1) })),
  /**
   * The name of a task of the caller's that has ended (Orchestration 5.3, 2026-11-14): this task
   * takes it up again with all of its history, as the same Agent, and reads the goal as what it is
   * asked now. Work goes back to the task that knows the code, at the price of a cached prefix.
   */
  continues: Type.Optional(NameSchema),
});
export type SubagentTask = Static<typeof SubagentTaskSchema>;

/** Parameters of `run_subagents`. The number of tasks is limited by configuration, not here. */
export const RunSubagentsArgsSchema = closed(
  {
    tasks: Type.Array(SubagentTaskSchema, { minItems: 1, maxItems: 12 }),
    /**
     * The plan of the work (Orchestration 5.3, D24): what is delivered, the approach, how it is
     * split, who owns which part and which interface, the constraints. The root task writes it
     * before its first subtasks; every task below sees it. A later one replaces it.
     */
    plan: Type.Optional(text(8000)),
  },
  'workflow.RunSubagentsArgs.v1',
);
export type RunSubagentsArgs = Static<typeof RunSubagentsArgsSchema>;

export const AcceptanceAnswerSchema = closed({
  index: count(0),
  verdict: Type.Enum(['met', 'not_met', 'unknown']),
});
export type AcceptanceAnswer = Static<typeof AcceptanceAnswerSchema>;

/** Parameters of `finish_subagent` of an explorer. */
export const ExplorerResultSchema = closed(
  {
    summary: longText(),
    report: Type.Optional(longText()),
    references: referencesField(),
    openQuestions: Type.Optional(Type.Array(text(500), { maxItems: 10 })),
    acceptance: Type.Optional(Type.Array(AcceptanceAnswerSchema, { maxItems: 10 })),
  },
  'workflow.ExplorerResult.v1',
);
export type ExplorerResult = Static<typeof ExplorerResultSchema>;

/** Parameters of `finish_subagent` of a worker. */
export const WorkerResultSchema = closed(
  {
    summary: longText(),
    report: Type.Optional(longText()),
    references: referencesField(),
    changedFiles: Type.Array(text(500), { maxItems: 200 }),
    status: Type.Enum(['done', 'partial', 'blocked']),
    validation: Type.Array(closed({ command: text(1000), exitCode: Type.Integer() }), {
      maxItems: 20,
    }),
    blockers: Type.Optional(Type.Array(text(500), { maxItems: 10 })),
    acceptance: Type.Optional(Type.Array(AcceptanceAnswerSchema, { maxItems: 10 })),
  },
  'workflow.WorkerResult.v1',
);
export type WorkerResult = Static<typeof WorkerResultSchema>;

/** The part of the result of `finish_subagent` that the caller reads, whichever kind of Agent wrote it. */
export interface SubagentReport {
  readonly summary: string;
  readonly report?: string;
}

/** The whole result as text: the summary, then the report. What `read_output` reads back. */
export function subagentFullText(result: SubagentReport): string {
  return result.report === undefined ? result.summary : `${result.summary}\n\n${result.report}`;
}

/**
 * What the caller is shown (M2Design 3.7): the summary, and the report after it when the report
 * fits the limits; otherwise the summary and the id by which the report is read in pages. A
 * summary longer than asked is cut here and not refused.
 */
export function subagentShownText(result: SubagentReport, toolCallId: string): string {
  const { summary, report } = result;
  const head =
    summary.length <= SUBAGENT_SUMMARY_CHARS
      ? summary
      : `${summary.slice(0, SUBAGENT_SUMMARY_CHARS)}\n[summary cut: it is ${String(summary.length)} characters, only the first ${String(SUBAGENT_SUMMARY_CHARS)} are shown; read all of it with read_output, toolCallId ${toolCallId}]`;
  if (report === undefined) return head;
  const lines = report.split('\n').length;
  if (lines <= SUBAGENT_REPORT_LINES && report.length <= SUBAGENT_REPORT_CHARS)
    return `${head}\n\n${report}`;
  return `${head}\n\n[the report is ${String(lines)} lines and ${String(report.length)} characters, too long to show here; read all of it with read_output, toolCallId ${toolCallId}]`;
}

/**
 * A finishing call that does not follow the form (it was the last round, so it could not be
 * written again) is shown as it was written, within the same limits; the caller is told by the
 * notes of the result that it does not follow the form, and judges it itself.
 */
export function subagentAsWrittenText(written: string, toolCallId: string): string {
  const lines = written.split('\n').length;
  if (lines <= SUBAGENT_REPORT_LINES && written.length <= SUBAGENT_REPORT_CHARS) return written;
  return `${written.slice(0, SUBAGENT_SUMMARY_CHARS)}\n[the text is ${String(lines)} lines and ${String(written.length)} characters, too long to show here; read all of it with read_output, toolCallId ${toolCallId}]`;
}
