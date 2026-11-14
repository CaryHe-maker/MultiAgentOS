"""Sign-in with a limit on failed attempts per account."""
import time
from collections import defaultdict

from .passwords import verify_password
from .users import Users


class Locked(Exception):
    pass


class Limiter:
    """At most `max_failures` failed sign-ins per account within `window` seconds."""

    def __init__(self, max_failures: int = 5, window: float = 300.0, clock=time.time):
        self.max_failures = max_failures
        self.window = window
        self.clock = clock
        self._failures = defaultdict(list)

    def _recent(self, key: str):
        now = self.clock()
        self._failures[key] = [at for at in self._failures[key] if now - at < self.window]
        return self._failures[key]

    def check(self, key: str) -> None:
        if len(self._recent(key)) >= self.max_failures:
            raise Locked(key)

    def failed(self, key: str) -> None:
        self._recent(key).append(self.clock())

    def succeeded(self, key: str) -> None:
        self._failures.pop(key, None)


def login(users: Users, limiter: Limiter, name: str, password: str) -> bool:
    """True when the password is right. Raises Locked while the account is locked."""
    limiter.check(name)
    account = users.find(name)
    if account is None or not verify_password(password, account["hash"]):
        limiter.failed(name)
        return False
    limiter.succeeded(name)
    return True
