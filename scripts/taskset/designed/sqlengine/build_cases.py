"""Builds tests/cases.json of the sqlengine task inside the task image: runs every case of cases_src.py
statement by statement with Python's sqlite3 (autocommit mode, so BEGIN/COMMIT behave as in a script) and
records the output in the task's format. Flags multi-row results of statements without a top-level
ORDER BY, whose order would be unspecified.
Usage (in the container): python3 build_cases.py <out cases.json>
"""

import json
import os
import re
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cases_src import CASES  # noqa: E402


def fmt(v):
    if v is None:
        return "NULL"
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, bytes):
        return "x'" + v.hex() + "'"
    return str(v)


out, warnings = [], []
for case in CASES:
    with tempfile.TemporaryDirectory() as d:
        db = sqlite3.connect(os.path.join(d, "db.sqlite"), isolation_level=None)
        lines = []
        for stmt in case["statements"]:
            try:
                rows = db.execute(stmt).fetchall()
            except sqlite3.Error:
                lines.append("error")
                continue
            if len(rows) > 1 and not re.search(r"ORDER BY[^()]*$", stmt, re.I):
                warnings.append(f"{case['name']}: {stmt[:70]}")
            lines += ["|".join(fmt(v) for v in r) for r in rows]
        db.close()
    out.append(dict(case, stdout="".join(line + "\n" for line in lines)))
json.dump({"sqlite": sqlite3.sqlite_version, "cases": out}, open(sys.argv[1], "w"), indent=1)
print(len(out), "cases, SQLite", sqlite3.sqlite_version)
for w in warnings:
    print("unordered multi-row result:", w)
