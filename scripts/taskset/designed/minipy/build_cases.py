"""Builds tests/cases.json of the minipy task inside the task image: runs every program of cases_src.py with
CPython 3.12 as prog.py and records stdout, the exit status and the last line of stderr.
Usage (in the container): python3 build_cases.py <out cases.json>
"""

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cases_src import CASES  # noqa: E402

out = []
for case in CASES:
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "prog.py"), "w", encoding="utf-8") as f:
            f.write(case["code"])
        p = subprocess.run([sys.executable, "prog.py"], cwd=d, capture_output=True, timeout=120,
                           env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C.UTF-8", "PYTHONHASHSEED": "0"})
        err = p.stderr.decode("utf-8", errors="replace").strip().splitlines()
        out.append(dict(case, stdout=p.stdout.decode("utf-8"), exit=p.returncode, last_error=err[-1] if err else ""))
json.dump({"python": sys.version.split()[0], "cases": out}, open(sys.argv[1], "w"), indent=1, ensure_ascii=False)
print(len(out), "cases, Python", sys.version.split()[0])
for c in out:
    if c["exit"] != 0:
        print("---", c["name"], "exit", c["exit"], c["last_error"][:120])
