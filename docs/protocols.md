# Protocols and Interface Contracts

## Source of Truth

For implemented fields, `src/multi_agent_os/models.py` is authoritative. This document explains the intent and names the target protocol additions; it must be updated in the same pull request as any cross-component schema change.

## Plan

`Plan` is the planner output consumed by the validator and scheduler.

| Field | Meaning | Current status |
|---|---|---|
| `goal` | concise outcome requested by the user | implemented |
| `tasks` | one or more task cards | implemented |

## TaskCard

| Field | Meaning | Rule |
|---|---|---|
| `id` | stable task identifier, for example `backend.auth` | lowercase and unique in one plan |
| `title` | human-readable task name | required |
| `role` | responsibility such as `contract`, `backend`, `frontend`, or `test` | descriptive, not an authority grant |
| `inputs` | artifact references or supplied inputs | only relevant inputs should be included |
| `owned_paths` | paths the task may modify | overlapping unordered tasks are rejected |
| `dependencies` | task IDs that must succeed first | must exist and remain acyclic |
| `acceptance` | commands or observable checks that prove completion | should be non-empty for implementation work |
| `budget` | maximum input and output tokens | scheduler-enforced when LLM calls exist |
| `retry_policy` | bounded retry setting | never unbounded |

Example:

```json
{
  "id": "backend.auth",
  "title": "Implement JWT login endpoint",
  "role": "backend",
  "inputs": ["artifact://contracts/auth.openapi.json@v1"],
  "owned_paths": ["server/**"],
  "dependencies": ["contract.auth"],
  "acceptance": ["pytest tests/auth"],
  "budget": {"max_input_tokens": 8000, "max_output_tokens": 12000},
  "retry_policy": {"max_attempts": 1}
}
```

## Target Interfaces

These are contracts to implement after the current skeleton, not APIs that exist today.

| Object | Required purpose |
|---|---|
| `Contract` | versioned OpenAPI, JSON Schema, or event schema shared between implementation tasks |
| `Artifact` | immutable reference to a diff, summary, test report, log, or file snapshot with a content hash |
| `WorkerResult` | task ID, final status, summary, artifact references, token usage, duration, and blocking reason |
| `Policy` | allowed paths, commands, network domains, concurrency, budgets, and actions needing approval |
| `Checkpoint` | input snapshot, provider/model, task status, artifact references, and retry count |

## Compatibility Rule

Changing a field used by another component requires one of: a backward-compatible optional field, a versioned protocol, or coordinated updates in one pull request. A worker must never invent an API field not present in the current `Contract`.
