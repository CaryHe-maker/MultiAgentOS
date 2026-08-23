"""CLI entry point for the Phase 1 orchestration core."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer
from pydantic import ValidationError

from .dag import PlanValidationError, validate_plan
from .models import Plan
from .store import RunStore

app = typer.Typer(help="Local-first multi-agent coding workflow orchestration.")
DEFAULT_DATABASE = Path(".multiagentos/state.db")


def load_plan(plan_path: Path) -> Plan:
    try:
        return Plan.model_validate_json(plan_path.read_text())
    except FileNotFoundError as error:
        raise typer.BadParameter(f"plan file does not exist: {plan_path}") from error
    except ValidationError as error:
        raise typer.BadParameter(f"plan schema is invalid:\n{error}") from error


@app.command()
def validate(plan: Annotated[Path, typer.Argument(exists=True, readable=True)]) -> None:
    """Validate task ids, dependencies, cycles, and parallel file ownership."""
    try:
        parsed_plan = load_plan(plan)
        validate_plan(parsed_plan)
    except PlanValidationError as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(f"Valid plan: {len(parsed_plan.tasks)} tasks")


@app.command()
def run(
    plan: Annotated[Path, typer.Argument(exists=True, readable=True)],
    database: Annotated[Path, typer.Option("--database", "-d")] = DEFAULT_DATABASE,
) -> None:
    """Create a checkpointed run; worker execution will be connected next."""
    try:
        parsed_plan = load_plan(plan)
        validate_plan(parsed_plan)
    except PlanValidationError as error:
        raise typer.BadParameter(str(error)) from error
    store = RunStore(database)
    try:
        run_id = store.create_run(parsed_plan)
    finally:
        store.close()
    typer.echo(f"Created run: {run_id}")
    typer.echo(f"Checkpoint database: {database}")


@app.command()
def report(
    run_id: str,
    database: Annotated[Path, typer.Option("--database", "-d")] = DEFAULT_DATABASE,
) -> None:
    """Print the current checkpoint summary for a run."""
    store = RunStore(database)
    try:
        summary = store.summary(run_id)
    except KeyError as error:
        raise typer.BadParameter(str(error)) from error
    finally:
        store.close()
    typer.echo(json.dumps(summary.model_dump(mode="json"), indent=2))
