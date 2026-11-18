"""Builds tests/cases.json of the mdhtml task inside the task image with `cmark` 0.30 installed:
every CommonMark 0.30 example whose expected HTML equals `cmark --unsafe` output, plus composite
documents (three random examples joined by blank lines) with cmark's output as the expectation.
Usage (in the container): python3 build_cases.py <spec.json> <out cases.json>
"""

import json
import random
import subprocess
import sys

spec = json.load(open(sys.argv[1], encoding="utf-8"))


def cmark(text):
    return subprocess.run(["cmark", "--unsafe"], input=text.encode(), capture_output=True, check=True).stdout.decode()


examples, mismatched = [], []
for ex in spec:
    out = cmark(ex["markdown"])
    item = {"n": ex["example"], "section": ex["section"], "markdown": ex["markdown"], "html": ex["html"]}
    (examples if out == ex["html"] else mismatched).append(item)

rng = random.Random("mao-phase3-mdhtml")
composites = []
for k in range(150):
    parts = rng.sample(examples, 3)
    text = "\n\n".join(p["markdown"].rstrip("\n") for p in parts) + "\n"
    composites.append({"n": k + 1, "from": [p["n"] for p in parts], "markdown": text, "html": cmark(text)})

json.dump({"spec": "0.30", "examples": examples, "composites": composites,
           "dropped": [m["n"] for m in mismatched]}, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
print(len(examples), "examples kept,", len(mismatched), "dropped,", len(composites), "composites")
