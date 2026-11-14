"""What every storage backend does. tests/backend_contract.py checks it."""
from typing import Dict, List, Optional

from ..job import STATES, Job


class Backend:
    """Stores jobs. A backend is created by name through taskq.backends.create()."""

    def put(self, job: Job) -> Job:
        """Stores a new job, giving it the next `seq`; returns it."""
        raise NotImplementedError

    def get(self, job_id: str) -> Optional[Job]:
        raise NotImplementedError

    def save(self, job: Job) -> None:
        """Writes back a job that changed (state, attempts, run_at, last_error)."""
        raise NotImplementedError

    def claim(self, now: float) -> Optional[Job]:
        """The queued job with the smallest run_at that is due (run_at <= now), ties broken by
        seq; it is marked running and saved before it is returned. None when nothing is due."""
        raise NotImplementedError

    def list(self, state: Optional[str] = None) -> List[Job]:
        """Jobs in seq order, of one state or all."""
        raise NotImplementedError

    def counts(self) -> Dict[str, int]:
        """How many jobs are in each state; every state is a key, 0 when none."""
        counted = {state: 0 for state in STATES}
        for job in self.list():
            counted[job.state] += 1
        return counted

    def close(self) -> None:
        pass
