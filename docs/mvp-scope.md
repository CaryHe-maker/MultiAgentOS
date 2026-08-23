# MVP Scope

## Product Statement

MultiAgentOS accepts one constrained full-stack development goal, turns it into an auditable task graph, runs safe independent tasks, and reports whether the result passed its defined checks.

The first demonstration target is a Todo application login feature: an API contract, a backend authentication task, a frontend login task, and an integration test task.

## Phase 1 Definition of Done

The MVP is complete only when it can:

1. Accept a user goal and produce a schema-valid `Plan` with at least two independent implementation tasks.
2. Reject unknown dependencies, cycles, and unsafe overlapping file ownership before execution.
3. Run independent backend and frontend tasks in separate Git worktrees.
4. Persist task status before and after each state transition in SQLite.
5. Require explicit approval before a configured high-risk command.
6. Integrate worker changes, run defined checks, and emit a run report.
7. Compare the same fixed task with a single-agent baseline and a manual two-window baseline.

## Explicit Non-Goals

- No production deployment, multi-tenancy, remote workers, or dashboard.
- No autonomous publishing, deletion, permission changes, or access to user secrets.
- No claim that parallel execution is always cheaper or faster.
- No general-purpose autonomous software company. The first workflow is deliberately narrow and repeatable.

## Delivery Order

| Step | Outcome | Owner |
|---|---|---|
| 0. Baseline | 5-10 fixed tasks and a result-recording sheet | C |
| 1. Core protocol | `TaskCard`, `Plan`, validation, checkpoint state | A |
| 2. Planner | model output -> validated plan JSON | A |
| 3. Runtime | worktree creation, approved subprocess worker, result capture | B |
| 4. Integration | ordered merge, quality gates, failure report | C |
| 5. End-to-end slice | Todo login task completes through `plan/run/integrate/report` | A+B+C |

Do not start a later step merely because its technology is interesting. Start it when the preceding outcome has a passing test or repeatable demo.
