from pathlib import Path

from multi_agent_os.models import Plan, TaskCard, TaskStatus
from multi_agent_os.store import RunStore


def test_created_run_has_ready_and_pending_checkpoints(tmp_path: Path) -> None:
    plan = Plan(
        goal="demo",
        tasks=[
            TaskCard(id="planner", title="planner"),
            TaskCard(id="worker", title="worker", dependencies=["planner"]),
        ],
    )
    store = RunStore(tmp_path / "state.db")
    try:
        run_id = store.create_run(plan)
        summary = store.summary(run_id)
    finally:
        store.close()

    assert summary.task_counts == {TaskStatus.READY: 1, TaskStatus.PENDING: 1}
