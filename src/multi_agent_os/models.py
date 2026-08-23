"""Stable schemas shared by planners, workers, and the scheduler."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field, field_validator


class TaskStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class Budget(BaseModel):
    max_input_tokens: int = Field(default=8_000, gt=0)
    max_output_tokens: int = Field(default=12_000, gt=0)


class RetryPolicy(BaseModel):
    max_attempts: int = Field(default=1, ge=1, le=5)


class TaskCard(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]*$")
    title: str = Field(min_length=1)
    role: str = Field(default="worker", min_length=1)
    inputs: list[str] = Field(default_factory=list)
    owned_paths: list[str] = Field(default_factory=list)
    dependencies: list[str] = Field(default_factory=list)
    acceptance: list[str] = Field(default_factory=list)
    budget: Budget = Field(default_factory=Budget)
    retry_policy: RetryPolicy = Field(default_factory=RetryPolicy)

    @field_validator("dependencies", "owned_paths")
    @classmethod
    def no_duplicates(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("must not contain duplicate values")
        return values


class Plan(BaseModel):
    goal: str = Field(min_length=1)
    tasks: list[TaskCard] = Field(min_length=1)


class RunSummary(BaseModel):
    run_id: str
    goal: str
    task_counts: dict[TaskStatus, int]
