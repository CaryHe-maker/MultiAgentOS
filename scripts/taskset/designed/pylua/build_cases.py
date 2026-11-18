"""Builds tests/cases.json of the pylua task inside the task image with lua5.4 installed: runs every case of
cases_src.py as `prog.lua` and records stdout, stderr (as Latin-1 text, one character per byte) and the exit
status.
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
        with open(os.path.join(d, "prog.lua"), "w") as f:
            f.write(case["code"])
        p = subprocess.run(["lua5.4", "prog.lua"] + case["args"], cwd=d, input=case["stdin"].encode(),
                           capture_output=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=60)
        out.append(dict(case, stdout=p.stdout.decode("latin-1"), stderr=p.stderr.decode("latin-1"), exit=p.returncode))
version = subprocess.run(["lua5.4", "-v"], capture_output=True, text=True)
json.dump({"oracle": (version.stdout or version.stderr).strip(), "cases": out}, open(sys.argv[1], "w"), indent=1)
print(len(out), "cases")
