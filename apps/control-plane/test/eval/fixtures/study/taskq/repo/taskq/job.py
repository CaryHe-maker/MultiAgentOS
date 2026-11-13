"""A job and how it is written down."""
from dataclasses import asdict, dataclass, field
from typing import Optional

STATES = ("queued", "running", "done", "failed")


@dataclass
class Job:
    id: str
    name: str
    payload: dict = field(default_factory=dict)
    state: str = "queued"
    attempts: int = 0
    max_attempts: int = 3
    run_at: float = 0.0
    last_error: Optional[str] = None
    # Order of arrival, given by the backend on put(); claim() breaks ties of run_at with it.
    seq: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, row: dict) -> "Job":
        known = {name: row[name] for name in cls.__dataclass_fields__ if name in row}
        return cls(**known)
