import pytest

from multi_agent_os.dag import PlanValidationError, initial_statuses, ready_tasks, validate_plan
from multi_agent_os.models import Plan, TaskCard, TaskStatus


def test_independent_tasks_can_be_ready_together() -> None:
    plan = Plan(
        goal="demo",
        tasks=[
            TaskCard(id="contract", title="contract"),
            TaskCard(id="backend", title="backend", dependencies=["contract"]),
            TaskCard(id="frontend", title="frontend", dependencies=["contract"]),
        ],
    )

    statuses = initial_statuses(plan)
    assert statuses == {
        "contract": TaskStatus.READY,
        "backend": TaskStatus.PENDING,
        "frontend": TaskStatus.PENDING,
    }
    statuses["contract"] = TaskStatus.SUCCEEDED
    assert {task.id for task in ready_tasks(plan, statuses)} == {"backend", "frontend"}


def test_parallel_tasks_cannot_own_same_path() -> None:
    plan = Plan(
        goal="demo",
        tasks=[
            TaskCard(id="backend", title="backend", owned_paths=["server/**"]),
            TaskCard(id="review", title="review", owned_paths=["server/**"]),
        ],
    )

    with pytest.raises(PlanValidationError, match="overlap"):
        validate_plan(plan)


def test_cycle_is_rejected() -> None:
    plan = Plan(
        goal="demo",
        tasks=[
            TaskCard(id="one", title="one", dependencies=["two"]),
            TaskCard(id="two", title="two", dependencies=["one"]),
        ],
    )

    with pytest.raises(PlanValidationError, match="cycle"):
        validate_plan(plan)
