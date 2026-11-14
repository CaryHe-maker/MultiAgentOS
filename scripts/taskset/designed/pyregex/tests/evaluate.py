"""Evaluates the case expressions with a regex module and prints one JSON line per case: the repr of the
result, "error" for the module's error, or the type name of any other exception. Used to build the
expectations (with re) and by the hidden tests (with pyregex), so both sides see the same helpers.
Usage: python3 evaluate.py <module name> < cases (one JSON object per line with "expr")"""

import importlib
import json
import signal
import sys

R = importlib.import_module(sys.argv[1])


def M(m):
    if m is None:
        return None
    return (m.span(), m.groups(), m.groupdict(), m.lastindex, m.lastgroup)


def E(f):
    """The pattern and position carried by the error that f raises."""
    try:
        f()
    except R.error as e:
        return (e.pattern, e.pos)
    return None


class Timeout(Exception):
    pass


def on_alarm(*_):
    raise Timeout()


signal.signal(signal.SIGALRM, on_alarm)
for line in sys.stdin:
    case = json.loads(line)
    signal.alarm(10)
    try:
        value = repr(eval(case["expr"], {"R": R, "M": M, "E": E}))
    except R.error:
        value = "error"
    except Timeout:
        value = "timeout"
    except BaseException as e:  # noqa: BLE001 - the type name is the expected result
        value = type(e).__name__
    finally:
        signal.alarm(0)
    print(json.dumps({"name": case["name"], "result": value}), flush=True)
