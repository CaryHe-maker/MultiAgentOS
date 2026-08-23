# Architecture

## MVP Components

```text
CLI
  -> Planner
  -> Plan Validator
  -> Scheduler
      -> State Store (SQLite)
      -> Worker Runtime (Git worktree + subprocess)
  -> Integrator
  -> Report
```

The orchestrator owns the whole run. Workers do not create arbitrary child workers and do not communicate through free-form chat transcripts.

| Component | Responsibility | Does not own |
|---|---|---|
| CLI | receives commands and renders human-readable output | scheduling policy |
| Planner | turns a goal into a `Plan`, task cards, and contracts | file writes |
| Validator | rejects invalid graph, dependency, ownership, and policy input | repairing plans |
| Scheduler | releases safe ready tasks and enforces budgets/concurrency | writing task code |
| State Store | persists runs, checkpoints, and task statuses | model prompts |
| Worker Runtime | creates isolated worktrees and executes one approved task | merging to the base branch |
| Integrator | applies accepted worker changes and runs quality gates | redefining the contract silently |
| Reporter | presents time, cost, quality, conflicts, and approvals | changing run state |

## Implemented Today

`models.py`, `dag.py`, `store.py`, and `cli.py` implement the protocol skeleton, graph validation, initial state creation, SQLite checkpointing, and three CLI commands. The planner, runtime, integrator, and real metrics collection remain future modules.

## Boundary Rule

Data moves between components as versioned structured objects or artifact references. A component may add evidence to an artifact, but it must not reinterpret another component's role or silently modify a contract.
