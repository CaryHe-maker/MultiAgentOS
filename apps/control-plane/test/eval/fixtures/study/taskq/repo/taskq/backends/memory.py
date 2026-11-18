"""Jobs in memory: for tests and one-process use."""
import copy
from typing import List, Optional

from . import register
from .base import Backend
from ..job import Job


@register("memory")
class MemoryBackend(Backend):
    def __init__(self, **_ignored):
        self._jobs = {}
        self._seq = 0

    def put(self, job: Job) -> Job:
        self._seq += 1
        job.seq = self._seq
        self._jobs[job.id] = copy.deepcopy(job)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        job = self._jobs.get(job_id)
        return None if job is None else copy.deepcopy(job)

    def save(self, job: Job) -> None:
        if job.id not in self._jobs:
            raise KeyError(job.id)
        self._jobs[job.id] = copy.deepcopy(job)

    def claim(self, now: float) -> Optional[Job]:
        due = [job for job in self._jobs.values() if job.state == "queued" and job.run_at <= now]
        if not due:
            return None
        job = min(due, key=lambda each: (each.run_at, each.seq))
        job.state = "running"
        return copy.deepcopy(job)

    def list(self, state: Optional[str] = None) -> List[Job]:
        jobs = sorted(self._jobs.values(), key=lambda each: each.seq)
        return [copy.deepcopy(job) for job in jobs if state is None or job.state == state]
