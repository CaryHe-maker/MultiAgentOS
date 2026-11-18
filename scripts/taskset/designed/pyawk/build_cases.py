"""Builds tests/cases.json of the pyawk task inside the task image with gawk installed: runs every case
of cases_src.py with `gawk --posix` and records stdout, stderr, exit status and written files.
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
        args = [a for a in case["args"] if a is not None]
        env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PYAWK_TEST_VAR": "env value"}
        p = subprocess.run(["gawk", "--posix"] + args, cwd=d, input=case["stdin"].encode(), capture_output=True,
                           env=env, timeout=30)
        files = {}
        for name in case["out"]:
            path = os.path.join(d, name)
            files[name] = open(path).read() if os.path.exists(path) else None
        out.append(dict(case, args=args, stdout=p.stdout.decode(), stderr=p.stderr.decode(), code=p.returncode,
                        outfiles=files))
json.dump({"oracle": subprocess.run(["gawk", "--version"], capture_output=True, text=True).stdout.splitlines()[0],
           "cases": out}, open(sys.argv[1], "w"), indent=1)
print(len(out), "cases")
