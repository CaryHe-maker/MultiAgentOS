"""Pure validation and scheduling helpers for a task graph."""

from __future__ import annotations

from collections import defaultdict

from .models import Plan, TaskCard, TaskStatus


class PlanValidationError(ValueError):
    """Raised when a plan cannot be safely scheduled."""


def validate_plan(plan: Plan) -> None:
    tasks_by_id = {task.id: task for task in plan.tasks}
    if len(tasks_by_id) != len(plan.tasks):
        raise PlanValidationError("task ids must be unique")

    for task in plan.tasks:
        unknown = set(task.dependencies) - tasks_by_id.keys()
        if unknown:
            raise PlanValidationError(f"{task.id} depends on unknown tasks: {sorted(unknown)}")
        if task.id in task.dependencies:
            raise PlanValidationError(f"{task.id} cannot depend on itself")

    _assert_acyclic(tasks_by_id)
    _assert_parallel_ownership_is_safe(plan.tasks)


def initial_statuses(plan: Plan) -> dict[str, TaskStatus]:
    validate_plan(plan)
    return {
        task.id: TaskStatus.READY if not task.dependencies else TaskStatus.PENDING
        for task in plan.tasks
    }


def ready_tasks(plan: Plan, statuses: dict[str, TaskStatus]) -> list[TaskCard]:
    validate_plan(plan)
    return [
        task
        for task in plan.tasks
        if statuses.get(task.id) == TaskStatus.PENDING
        and all(statuses.get(dependency) == TaskStatus.SUCCEEDED for dependency in task.dependencies)
    ]


def _assert_acyclic(tasks_by_id: dict[str, TaskCard]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str) -> None:
        if task_id in visiting:
            raise PlanValidationError(f"task graph contains a cycle involving {task_id}")
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in tasks_by_id[task_id].dependencies:
            visit(dependency)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in tasks_by_id:
        visit(task_id)


def _assert_parallel_ownership_is_safe(tasks: list[TaskCard]) -> None:
    """Reject overlapping paths only for tasks with no ordering relationship."""
    ancestors = _ancestors(tasks)
    for index, left in enumerate(tasks):
        for right in tasks[index + 1 :]:
            ordered = left.id in ancestors[right.id] or right.id in ancestors[left.id]
            shared_paths = set(left.owned_paths) & set(right.owned_paths)
            if shared_paths and not ordered:
                raise PlanValidationError(
                    f"parallel tasks {left.id} and {right.id} overlap on {sorted(shared_paths)}"
                )


def _ancestors(tasks: list[TaskCard]) -> dict[str, set[str]]:
    dependencies = {task.id: set(task.dependencies) for task in tasks}
    result: dict[str, set[str]] = defaultdict(set)

    def collect(task_id: str) -> set[str]:
        if result[task_id]:
            return result[task_id]
        for dependency in dependencies[task_id]:
            result[task_id].add(dependency)
            result[task_id].update(collect(dependency))
        return result[task_id]

    for task_id in dependencies:
        collect(task_id)
    return result
