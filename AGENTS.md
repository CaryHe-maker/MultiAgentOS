# Agent Working Guide

This repository is a local-first orchestration core for coding-agent workflows. Read this file before editing it.

## Start Here

1. Read `README.md` and `docs/mvp-scope.md` for the current product boundary.
2. Read `docs/protocols.md` before changing data exchanged by planners, schedulers, or workers.
3. Read `docs/workflow.md` before changing task lifecycle or state transitions.
4. Run the checks below before handing work off.

## Commands

```bash
pip install -e '.[dev]'
pytest
ruff check .
mypy src
maos validate examples/todo-login-plan.json
```

## Repository Rules

- Keep cross-component data structured. `src/multi_agent_os/models.py` is the source of truth for implemented schemas.
- Do not silently expand worker permissions, filesystem access, network access, or command execution.
- Do not add an LLM framework, database service, Docker, or web UI unless the current MVP needs it.
- Add focused tests for behavior changes in `tests/`.
- Keep generated files out of Git: `.venv/`, `.multiagentos/`, `.idea/`, and `*.egg-info/`.
- A task with an unclear acceptance condition is incomplete. Clarify it in the task card or issue before implementing.

## Current Boundary

The repository currently validates a task DAG and creates SQLite checkpoints. It does not yet call an LLM, execute a worker, create a Git worktree, or merge code. See `docs/mvp-scope.md`.
