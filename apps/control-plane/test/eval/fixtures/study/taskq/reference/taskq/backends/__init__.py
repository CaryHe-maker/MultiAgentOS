"""Backends by name. A backend module registers its class with @register("name")."""
from typing import Callable, Dict, List

from .base import Backend

_BACKENDS: Dict[str, Callable[..., Backend]] = {}


class UnknownBackend(ValueError):
    pass


def register(name: str):
    def wrap(cls):
        _BACKENDS[name] = cls
        return cls

    return wrap


def create(name: str, **options) -> Backend:
    """A backend by its name; `options` are what its constructor takes (path=...)."""
    try:
        factory = _BACKENDS[name]
    except KeyError:
        raise UnknownBackend(f"unknown backend {name!r}; known: {', '.join(names())}") from None
    return factory(**options)


def names() -> List[str]:
    return sorted(_BACKENDS)


# The built-in backends register themselves when imported.
from . import jsonfile, memory, sqlite  # noqa: E402,F401
