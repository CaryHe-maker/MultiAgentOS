"""The queue: enqueue jobs, run the next due one with its handler, retry what fails."""
import time
import uuid
from typing import Callable, Dict, Optional

from .backends.base import Backend
from .job import Job
from .retry import backoff

Handler = Callable[[dict], None]


class Queue:
    def __init__(self, backend: Backend, clock: Callable[[], float] = time.time):
        self.backend = backend
        self.clock = clock

    def enqueue(self, name: str, payload: Optional[dict] = None, delay: float = 0.0, max_attempts: int = 3) -> str:
        job = Job(
            id=uuid.uuid4().hex,
            name=name,
            payload=dict(payload or {}),
            max_attempts=max_attempts,
            run_at=self.clock() + delay,
        )
        return self.backend.put(job).id

    def run_once(self, handlers: Dict[str, Handler]) -> Optional[Job]:
        """Runs the next due job, if any; returns it as it was left."""
        job = self.backend.claim(self.clock())
        if job is None:
            return None
        handler = handlers.get(job.name)
        try:
            if handler is None:
                raise LookupError(f"no handler for {job.name}")
            handler(job.payload)
        except Exception as error:  # a failing handler fails the attempt, not the queue
            job.attempts += 1
            job.last_error = f"{type(error).__name__}: {error}"
            if job.attempts >= job.max_attempts:
                job.state = "failed"
            else:
                job.state = "queued"
                job.run_at = self.clock() + backoff(job.attempts)
        else:
            job.attempts += 1
            job.state = "done"
            job.last_error = None
        self.backend.save(job)
        return job

    def run_due(self, handlers: Dict[str, Handler], limit: int = 1000) -> int:
        ran = 0
        while ran < limit and self.run_once(handlers) is not None:
            ran += 1
        return ran
