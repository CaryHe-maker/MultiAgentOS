"""Builds tests/cases.json of the textutils task inside the task image: runs every case of cases_src.py with
the GNU tool (LC_ALL=C) and records stdout (as Latin-1 text, one character per byte), the exit status and
any files the case lists as output.
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
            os.makedirs(os.path.dirname(os.path.join(d, name)), exist_ok=True)
            with open(os.path.join(d, name), "w") as f:
                f.write(content)
        p = subprocess.run(case["argv"], cwd=d, input=case["stdin"].encode(), capture_output=True,
                           env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=60)
        files = {}
        for name in case["out"]:
            path = os.path.join(d, name)
            files[name] = open(path, "rb").read().decode("latin-1") if os.path.exists(path) else None
        out.append(dict(case, stdout=p.stdout.decode("latin-1"), exit=p.returncode, outfiles=files,
                        stderr=p.stderr.decode("latin-1")))
versions = {t: subprocess.run([t, "--version"], capture_output=True, text=True).stdout.splitlines()[0]
            for t in ("sort", "grep", "sed")}
json.dump({"tools": versions, "cases": out}, open(sys.argv[1], "w"), indent=1)
print(len(out), "cases", versions)
for c in out:
    if c["exit"] != 0 or c["stderr"]:
        print("---", c["name"], "exit", c["exit"], c["stderr"][:150].replace("\n", " / "))
