"""Accounts, kept in a JSON file: {"alice": {"hash": "...", "email": "..."}}."""
import json
import os

from .passwords import hash_password


def normalize(name: str) -> str:
    return name.strip().lower()


class Users:
    def __init__(self, path: str):
        self.path = path
        self._users = {}
        if os.path.exists(path):
            with open(path, encoding="utf8") as handle:
                self._users = json.load(handle)

    def _write(self) -> None:
        with open(self.path, "w", encoding="utf8") as handle:
            json.dump(self._users, handle, indent=1, sort_keys=True)

    def add(self, name: str, password: str, email: str = "") -> None:
        key = normalize(name)
        if key in self._users:
            raise ValueError(f"{key} exists")
        self._users[key] = {"hash": hash_password(password), "email": email}
        self._write()

    def find(self, name: str):
        return self._users.get(normalize(name))
