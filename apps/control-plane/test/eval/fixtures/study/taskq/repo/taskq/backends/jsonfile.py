"""Jobs in one JSON file, rewritten on every change (written to a temporary file, then renamed)."""
import json
import os
from typing import List, Optional

from . import register
from .base import Backend
from ..job import Job


@register("json")
class JsonFileBackend(Backend):
    def __init__(self, path: str = "taskq.json", **_ignored):
        self.path = path
        self._jobs = {}
        self._seq = 0
        if os.path.exists(path):
            with open(path, encoding="utf8") as handle:
                data = json.load(handle)
            self._seq = data.get("seq", 0)
            self._jobs = {row["id"]: Job.from_dict(row) for row in data.get("jobs", [])}

    def _write(self) -> None:
        temporary = f"{self.path}.tmp"
        with open(temporary, "w", encoding="utf8") as handle:
            json.dump(
                {"seq": self._seq, "jobs": [job.to_dict() for job in self.list()]},
                handle,
                indent=1,
            )
        os.replace(temporary, self.path)

    def put(self, job: Job) -> Job:
        self._seq += 1
        job.seq = self._seq
        self._jobs[job.id] = Job.from_dict(job.to_dict())
        self._write()
        return job

    def get(self, job_id: str) -> Optional[Job]:
        job = self._jobs.get(job_id)
        return None if job is None else Job.from_dict(job.to_dict())

    def save(self, job: Job) -> None:
        if job.id not in self._jobs:
            raise KeyError(job.id)
        self._jobs[job.id] = Job.from_dict(job.to_dict())
        self._write()

    def claim(self, now: float) -> Optional[Job]:
        due = [job for job in self._jobs.values() if job.state == "queued" and job.run_at <= now]
        if not due:
            return None
        job = min(due, key=lambda each: (each.run_at, each.seq))
        job.state = "running"
        self._write()
        return Job.from_dict(job.to_dict())

    def list(self, state: Optional[str] = None) -> List[Job]:
        jobs = sorted(self._jobs.values(), key=lambda each: each.seq)
        return [Job.from_dict(job.to_dict()) for job in jobs if state is None or job.state == state]
