# Run Workflow

## Lifecycle

```text
goal
  -> plan
  -> static validation
  -> approval (when needed)
  -> schedule ready tasks
  -> execute isolated workers
  -> integrate
  -> quality gates
  -> report
```

## State Model

| State | Meaning | Next states |
|---|---|---|
| `pending` | waiting for dependencies | `ready`, `blocked`, `cancelled` |
| `ready` | dependencies passed and resources are available | `running`, `cancelled` |
| `running` | worker has an active lease | `succeeded`, `failed`, `blocked`, `cancelled` |
| `succeeded` | acceptance evidence passed | no worker retry |
| `failed` | worker or quality gate failed | `ready` when retry policy permits, otherwise `blocked` |
| `blocked` | needs a decision, approval, or unrecoverable dependency fix | `ready`, `cancelled` |
| `cancelled` | explicitly stopped | terminal |

The current code persists initial `ready` and `pending` states. Later work must make every transition durable before starting the following side effect.

## Parallel Rule

Two tasks may run in parallel only when all of these are true:

1. Both have no unsatisfied dependency.
2. Their `owned_paths` do not overlap.
3. Neither uses a declared serial resource such as a database migration or lockfile.
4. The run has enough concurrency and token budget.
5. Their commands are allowed by policy.

If any condition is uncertain, run tasks serially. Serial execution is a valid scheduler decision, not a failure.

## Quality Gates

An implementation task is not complete because a worker says it is complete. The integrator collects declared evidence such as lint, type check, unit test, contract test, and end-to-end test results. A failed gate creates a bounded repair task or requests human intervention.
