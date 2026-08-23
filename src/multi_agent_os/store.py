"""Local SQLite checkpoint store for MVP runs."""

from __future__ import annotations

import sqlite3
import uuid
from collections import Counter
from pathlib import Path

from .dag import initial_statuses
from .models import Plan, RunSummary, TaskStatus


class RunStore:
    def __init__(self, database_path: Path) -> None:
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self._create_schema()

    def close(self) -> None:
        self.connection.close()

    def create_run(self, plan: Plan) -> str:
        run_id = uuid.uuid4().hex
        statuses = initial_statuses(plan)
        with self.connection:
            self.connection.execute(
                "INSERT INTO runs (id, goal, plan_json) VALUES (?, ?, ?)",
                (run_id, plan.goal, plan.model_dump_json()),
            )
            self.connection.executemany(
                "INSERT INTO task_checkpoints (run_id, task_id, status) VALUES (?, ?, ?)",
                [(run_id, task_id, status.value) for task_id, status in statuses.items()],
            )
        return run_id

    def summary(self, run_id: str) -> RunSummary:
        run = self.connection.execute("SELECT goal FROM runs WHERE id = ?", (run_id,)).fetchone()
        if run is None:
            raise KeyError(f"run not found: {run_id}")
        rows = self.connection.execute(
            "SELECT status, COUNT(*) AS count FROM task_checkpoints WHERE run_id = ? GROUP BY status",
            (run_id,),
        ).fetchall()
        counts = Counter({TaskStatus(row["status"]): row["count"] for row in rows})
        return RunSummary(run_id=run_id, goal=run["goal"], task_counts=dict(counts))

    def _create_schema(self) -> None:
        with self.connection:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    goal TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS task_checkpoints (
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    task_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (run_id, task_id)
                );
                """
            )
