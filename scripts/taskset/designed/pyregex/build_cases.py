"""Builds tests/cases.json of the pyregex task inside the task image: evaluates every expression of
cases_src.py with Python 3.12's re through tests/evaluate.py.
Usage (in the container): python3 build_cases.py <out cases.json>
"""

import json
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from cases_src import CASES  # noqa: E402

feed = "".join(json.dumps(c) + "\n" for c in CASES)
p = subprocess.run([sys.executable, os.path.join(here, "tests", "evaluate.py"), "re"], input=feed, capture_output=True,
                   text=True, check=True)
results = {json.loads(l)["name"]: json.loads(l)["result"] for l in p.stdout.splitlines()}
out = [dict(c, expected=results[c["name"]]) for c in CASES]
json.dump({"python": sys.version.split()[0], "cases": out}, open(sys.argv[1], "w"), indent=1)
print(len(out), "cases;", sum(c["expected"] == "error" for c in out), "errors;",
      sum(c["expected"] not in ("error",) and c["expected"][:1].isupper() for c in out), "other exceptions")
for c in out:
    if c["expected"] in ("timeout",) or (c["expected"][:1].isupper() and c["expected"] not in ("None", "True", "False")):
        print("  ", c["name"], c["expected"], c["expr"][:70])
