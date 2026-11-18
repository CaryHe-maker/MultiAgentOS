"""Oracle of the pyregex task: re-exports Python's re, which the task forbids. It validates the hidden
tests and fails, by design, the check that forbids re."""
from re import *  # noqa: F401,F403
from re import Match, Pattern, error, escape, purge  # noqa: F401
