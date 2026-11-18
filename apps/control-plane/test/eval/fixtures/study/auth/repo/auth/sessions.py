"""Sessions, kept in a JSON file and cached in memory."""
import json
import os
import random
import time


class SessionStore:
    def __init__(self, path: str, lifetime: float = 3600.0, clock=time.time):
        self.path = path
        self.lifetime = lifetime
        self.clock = clock
        self._sessions = {}
        if os.path.exists(path):
            with open(path, encoding="utf8") as handle:
                self._sessions = json.load(handle)
        self._cache = dict(self._sessions)

    def _write(self) -> None:
        with open(self.path, "w", encoding="utf8") as handle:
            json.dump(self._sessions, handle)

    def create(self, user: str) -> str:
        sid = str(random.randint(0, 10**8))
        record = {"user": user, "expires": self.clock() + self.lifetime}
        self._sessions[sid] = record
        self._cache[sid] = record
        self._write()
        return sid

    def get(self, sid: str):
        """The user of a live session, or None."""
        record = self._cache.get(sid)
        if record is None or record["expires"] <= self.clock():
            return None
        return record["user"]

    def revoke(self, sid: str) -> None:
        self._cache.pop(sid, None)

    def revoke_all(self, user: str) -> None:
        for sid, record in list(self._sessions.items()):
            if record["user"] == user:
                del self._sessions[sid]
                self._cache.pop(sid, None)
        self._write()
