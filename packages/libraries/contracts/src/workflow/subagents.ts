import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { closed, count, text } from '../platform-common/schema-helpers.js';

/**
 * The control tools of SubAgents (M2Design 3.6, 3.7): `run_subagents` asks for tasks, and
 * `finish_subagent` returns the result of one.
 */
/** What of a SubAgent's result its caller reads: longer is cut, and a longer one is sent back. */
export const SUBAGENT_RESULT_CHARS = 8000;

const NameSchema = Type.String({ pattern: '^[a-z][a-z0-9_-]{0,39}$' });

export const SubagentTaskSchema = closed({
  name: NameSchema,
  agent: Type.Enum(['explorer', 'worker']),
  goal: text(4000),
  dependsOn: Type.Optional(Type.Array(NameSchema, { maxItems: 11 })),
  writeScope: Type.Optional(Type.Array(text(500), { maxItems: 10 })),
  inputs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 10 })),
  acceptance: Type.Optional(Type.Array(text(300), { maxItems: 10 })),
  effort: Type.Optional(Type.Enum(['none', 'low', 'high', 'max'])),
  /** Only the token share is the caller's to ask for; the other limits are the Agent's own. */
  budget: Type.Optional(closed({ tokens: count(1) })),
});
export type SubagentTask = Static<typeof SubagentTaskSchema>;

/** Parameters of `run_subagents`. The number of tasks is limited by configuration, not here. */
export const RunSubagentsArgsSchema = closed(
  { tasks: Type.Array(SubagentTaskSchema, { minItems: 1, maxItems: 12 }) },
  'workflow.RunSubagentsArgs.v1',
);
export type RunSubagentsArgs = Static<typeof RunSubagentsArgsSchema>;

export const AcceptanceAnswerSchema = closed({
  index: count(0),
  verdict: Type.Enum(['met', 'not_met', 'unknown']),
  evidence: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 10 })),
});
export type AcceptanceAnswer = Static<typeof AcceptanceAnswerSchema>;

/** Parameters of `finish_subagent` of an explorer. */
export const ExplorerResultSchema = closed(
  {
    summary: text(4000),
    findings: Type.Array(
      closed({ claim: text(1000), evidence: Type.Array(ArtifactRefSchema, { maxItems: 10 }) }),
      { maxItems: 30 },
    ),
    openQuestions: Type.Optional(Type.Array(text(500), { maxItems: 10 })),
    acceptance: Type.Optional(Type.Array(AcceptanceAnswerSchema, { maxItems: 10 })),
  },
  'workflow.ExplorerResult.v1',
);
export type ExplorerResult = Static<typeof ExplorerResultSchema>;

/** Parameters of `finish_subagent` of a worker. */
export const WorkerResultSchema = closed(
  {
    summary: text(4000),
    changedFiles: Type.Array(text(500), { maxItems: 200 }),
    status: Type.Enum(['done', 'partial', 'blocked']),
    validation: Type.Array(
      closed({ command: text(1000), exitCode: Type.Integer(), outputRef: ArtifactRefSchema }),
      { maxItems: 20 },
    ),
    blockers: Type.Optional(Type.Array(text(500), { maxItems: 10 })),
    acceptance: Type.Optional(Type.Array(AcceptanceAnswerSchema, { maxItems: 10 })),
  },
  'workflow.WorkerResult.v1',
);
export type WorkerResult = Static<typeof WorkerResultSchema>;
