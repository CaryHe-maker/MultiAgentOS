"""How long a failed job waits before its next attempt."""

MAX_DELAY = 60.0


def backoff(attempts: int) -> float:
    """Seconds to wait after the `attempts`-th failed attempt: 2, 4, 8, ... at most MAX_DELAY."""
    return min(MAX_DELAY, float(2 ** attempts))
