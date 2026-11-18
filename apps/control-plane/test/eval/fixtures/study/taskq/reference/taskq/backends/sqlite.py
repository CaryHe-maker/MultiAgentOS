"""Jobs in a SQLite database (standard library sqlite3)."""
import json
import sqlite3
from typing import List, Optional

from . import register
from .base import Backend
from ..job import Job

COLUMNS = ("id", "name", "payload", "state", "attempts", "max_attempts", "run_at", "last_error", "seq")


@register("sqlite")
class SqliteBackend(Backend):
    def __init__(self, path: str = "taskq.sqlite", **_ignored):
        self.path = path
        self._db = sqlite3.connect(path)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE,"
            " name TEXT, payload TEXT, state TEXT, attempts INTEGER, max_attempts INTEGER, run_at REAL,"
            " last_error TEXT)"
        )
        self._db.commit()

    @staticmethod
    def _job(row) -> Job:
        values = dict(zip(("seq",) + COLUMNS[:-1], row))
        values["payload"] = json.loads(values["payload"])
        return Job(**values)

    def _select(self, where: str = "", args=()) -> List[Job]:
        rows = self._db.execute(
            f"SELECT seq, {', '.join(COLUMNS[:-1])} FROM jobs {where} ORDER BY seq", args
        ).fetchall()
        return [self._job(row) for row in rows]

    def put(self, job: Job) -> Job:
        cursor = self._db.execute(
            "INSERT INTO jobs (id, name, payload, state, attempts, max_attempts, run_at, last_error)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (job.id, job.name, json.dumps(job.payload), job.state, job.attempts, job.max_attempts, job.run_at, job.last_error),
        )
        self._db.commit()
        job.seq = cursor.lastrowid
        return job

    def get(self, job_id: str) -> Optional[Job]:
        found = self._select("WHERE id = ?", (job_id,))
        return found[0] if found else None

    def save(self, job: Job) -> None:
        cursor = self._db.execute(
            "UPDATE jobs SET name = ?, payload = ?, state = ?, attempts = ?, max_attempts = ?, run_at = ?,"
            " last_error = ? WHERE id = ?",
            (job.name, json.dumps(job.payload), job.state, job.attempts, job.max_attempts, job.run_at, job.last_error, job.id),
        )
        self._db.commit()
        if cursor.rowcount == 0:
            raise KeyError(job.id)

    def claim(self, now: float) -> Optional[Job]:
        row = self._db.execute(
            f"SELECT seq, {', '.join(COLUMNS[:-1])} FROM jobs WHERE state = 'queued' AND run_at <= ?"
            " ORDER BY run_at, seq LIMIT 1",
            (now,),
        ).fetchone()
        if row is None:
            return None
        job = self._job(row)
        job.state = "running"
        self.save(job)
        return job

    def list(self, state: Optional[str] = None) -> List[Job]:
        return self._select() if state is None else self._select("WHERE state = ?", (state,))

    def close(self) -> None:
        self._db.close()
