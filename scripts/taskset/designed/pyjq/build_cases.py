"""Builds tests/cases.json of the pyjq task inside the task image with jq 1.7 installed: runs every case of
cases_src.py and records stdout (as Latin-1 text, one character per byte) and the exit status.
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
        for name, content in case["files"].items():
            with open(os.path.join(d, name), "w") as f:
                f.write(content)
        p = subprocess.run(["jq"] + case["argv"], cwd=d, input=case["stdin"].encode(), capture_output=True,
                           env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8", "PYJQ_TEST": "env-value"}, timeout=60)
        out.append(dict(case, stdout=p.stdout.decode("latin-1"), exit=p.returncode, stderr=p.stderr.decode("latin-1")))
json.dump({"jq": subprocess.run(["jq", "--version"], capture_output=True, text=True).stdout.strip(), "cases": out},
          open(sys.argv[1], "w"), indent=1)
print(len(out), "cases")
for c in out:
    if c["exit"] != 0:
        print("---", c["name"], "exit", c["exit"], c["stderr"][:160].replace("\n", " / "))
