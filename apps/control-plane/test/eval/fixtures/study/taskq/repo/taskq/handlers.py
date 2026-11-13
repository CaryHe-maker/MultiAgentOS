"""The handlers `python3 -m taskq work` runs, by job name."""
import sys


def echo(payload: dict) -> None:
    sys.stdout.write(f"{payload.get('text', '')}\n")


def fail(payload: dict) -> None:
    raise RuntimeError(payload.get("reason", "asked to fail"))


HANDLERS = {"echo": echo, "fail": fail}
