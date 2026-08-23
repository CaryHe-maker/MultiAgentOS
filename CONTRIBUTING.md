# Contributing

## Development Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
ruff check .
mypy src
```

Use Python 3.12 or newer. The project currently runs locally with SQLite and does not require an API key.

## Branches

Create a branch from the latest `main` branch. Use lowercase names in this form:

```text
<type>/<short-topic>
```

Allowed types:

- `feature/`: a user-facing or core capability, for example `feature/worktree-runtime`.
- `fix/`: a defect fix, for example `fix/cycle-validation`.
- `docs/`: documentation only, for example `docs/protocol-contract`.
- `test/`: tests only, for example `test/scheduler-retry`.
- `chore/`: tooling or maintenance, for example `chore/ruff-config`.

`feature/bootstrap-core` means “add the initial core scaffolding.” Branch names describe ongoing work; commit messages describe completed work.

## Commits and Pull Requests

Use concise Conventional Commit-style messages:

```text
feat: add worktree runtime
fix: reject unknown dependencies
docs: define task card protocol
test: cover retry exhaustion
```

Before opening a pull request:

1. Rebase or merge the latest `main` into your branch.
2. Run `pytest`, `ruff check .`, and `mypy src`.
3. Explain the change, its acceptance condition, and the checks run.
4. Do not commit `.idea/`, `.venv/`, SQLite databases, secrets, model API keys, or generated logs.

## Three-Person Ownership for MVP

| Owner | Primary area | First deliverable |
|---|---|---|
| A: Orchestrator | Planner protocol, DAG scheduler, budgets and state transitions | valid plan -> ready task selection |
| B: Worker Runtime | Git worktree lifecycle, subprocess execution, structured worker result | one isolated worker can execute an approved task |
| C: Integration and Quality | contract fixtures, integrator, test gates, metrics and developer UX | merge report and repeatable benchmark |

Ownership means one person is accountable for a module's design and review. It does not mean others cannot contribute. Any cross-boundary change needs agreement in an issue or pull request before implementation.
