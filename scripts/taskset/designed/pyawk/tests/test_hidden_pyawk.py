"""Hidden tests of the pyawk task: 137 programs whose expected stdout, exit status and written files come
from `gawk --posix` 5.2.1 (cases.json, built by build_cases.py), plus speed and delivery checks."""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest

PROJECT = os.environ.get("PROJECT", os.getcwd())
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(HERE, "cases.json")))
ENV = {"PATH": "/usr/local/bin", "LC_ALL": "C", "PYAWK_TEST_VAR": "env value", "PYTHONPATH": PROJECT}


def run(args, stdin, cwd, timeout=30):
    return subprocess.run([sys.executable, "-m", "pyawk"] + args, cwd=cwd, input=stdin.encode(), capture_output=True,
                          env=ENV, timeout=timeout)


class Programs(unittest.TestCase):
    pass


def _case(case):
    def test(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "pyawk", "__main__.py")))
        with tempfile.TemporaryDirectory() as d:
            for name, content in case["files"].items():
                with open(os.path.join(d, name), "w") as f:
                    f.write(content)
            p = run(case["args"], case["stdin"], d)
            self.assertEqual(p.returncode, case["code"], p.stderr.decode()[-500:])
            if case["code"] == 0 or case["name"].startswith("exit"):
                self.assertEqual(p.stdout.decode(), case["stdout"])
            if "stderr" in case["name"]:
                self.assertEqual(p.stderr.decode(), case["stderr"])
            for name, content in case["outfiles"].items():
                path = os.path.join(d, name)
                self.assertEqual(open(path).read() if os.path.exists(path) else None, content, name)

    return test


for i, case in enumerate(DATA["cases"]):
    setattr(Programs, f"test_{i:03d}_{case['name']}", _case(case))


class Speed(unittest.TestCase):
    def test_hundred_thousand_lines(self):
        lines = "".join(" ".join(str((i * 7 + j * 13) % 1000) for j in range(10)) + "\n" for i in range(100000))
        prog = ("{ for (i = 1; i <= NF; i++) { s[i] += $i; c[$i % 10]++ } t += $3 * $7 } "
                "END { printf \"%d %d %d %d\\n\", s[1], s[10], c[3], t }")
        with tempfile.TemporaryDirectory() as d:
            start = time.time()
            p = run([prog], lines, d, timeout=120)
            elapsed = time.time() - start
        s1 = sum((i * 7 + 13) % 1000 for i in range(100000))
        s10 = sum((i * 7 + 130) % 1000 for i in range(100000))
        c3 = sum(1 for i in range(100000) for j in range(10) if ((i * 7 + j * 13) % 1000) % 10 == 3)
        t = sum(((i * 7 + 39) % 1000) * ((i * 7 + 91) % 1000) for i in range(100000))
        self.assertEqual(p.stdout.decode(), f"{s1} {s10} {c3} {t}\n")
        self.assertLess(elapsed, 15)


class Delivery(unittest.TestCase):
    def test_no_external_programs_and_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "pyawk")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        stdlib = set(sys.stdlib_module_names) | {"pyawk"}
        for path in files:
            text = open(path, encoding="utf-8", errors="replace").read()
            self.assertIsNone(banned.search(text), path)
            for m in re.finditer(r"^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+))", text, re.M):
                if m.group(1):
                    continue
                self.assertIn((m.group(2) or m.group(3)).split(".")[0], stdlib, path)

    def test_own_tests(self):
        p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=PROJECT,
                           capture_output=True, text=True, timeout=900)
        m = re.search(r"Ran (\d+) tests?", p.stderr)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        self.assertTrue(m and int(m.group(1)) >= 40, p.stderr[-500:])

    def test_docs(self):
        for name in ("README.md", os.path.join("docs", "design.md")):
            path = os.path.join(PROJECT, name)
            self.assertTrue(os.path.isfile(path), name)
            self.assertGreater(len(open(path, encoding="utf-8", errors="replace").read().strip()), 300, name)


if __name__ == "__main__":
    unittest.main()
