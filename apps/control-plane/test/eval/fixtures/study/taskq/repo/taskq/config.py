"""Settings from taskq.toml, overridden by the command line.

    [backend]
    name = "json"          # a registered backend
    path = "taskq.json"    # passed to the backend as path=
"""
import os
import tomllib
from dataclasses import dataclass


@dataclass
class Settings:
    backend: str = "json"
    path: str = "taskq.json"


def load(path: str = "taskq.toml") -> Settings:
    settings = Settings()
    if os.path.exists(path):
        with open(path, "rb") as handle:
            data = tomllib.load(handle)
        section = data.get("backend", {})
        settings.backend = section.get("name", settings.backend)
        settings.path = section.get("path", settings.path)
    return settings
