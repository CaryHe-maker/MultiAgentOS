"""Hidden tests of the pyjq task: invocations whose expected stdout, exit status and written files come
from jq 1.7 in the task image (cases.json, built by build_cases.py; text stored as Latin-1, one
character per byte), plus speed and delivery checks."""

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
ENV = {"PATH": "/usr/local/bin", "LC_ALL": "C.UTF-8", "PYJQ_TEST": "env-value", "PYTHONPATH": PROJECT}


def run(argv, stdin, cwd, timeout=60):
    return subprocess.run([sys.executable, "-m", "pyjq"] + argv, cwd=cwd, input=stdin.encode("utf-8") if isinstance(stdin, str) else stdin,
                          capture_output=True, env=ENV, timeout=timeout)


class Programs(unittest.TestCase):
    pass


def _case(case):
    def test(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "pyjq", "__main__.py")))
        with tempfile.TemporaryDirectory() as d:
            for name, content in case["files"].items():
                os.makedirs(os.path.dirname(os.path.join(d, name)), exist_ok=True)
                with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                    f.write(content)
            p = run(case["argv"], case["stdin"], d)
            self.assertEqual(p.stdout.decode("latin-1"), case["stdout"])
            self.assertEqual(p.returncode, case["exit"])
            for name, content in case.get("outfiles", {}).items():
                path = os.path.join(d, name)
                got = open(path, "rb").read().decode("latin-1") if os.path.exists(path) else None
                self.assertEqual(got, content, name)

    return test


for i, case in enumerate(DATA["cases"]):
    setattr(Programs, f"test_{i:03d}_{case['name']}", _case(case))


class Speed(unittest.TestCase):
    def test_hundred_thousand_objects(self):
        data = json.dumps([{"v": i, "g": i % 13} for i in range(100000)])
        for argv, expected in ((["map(select(.v % 7 == 0)) | length"], b"14286\n"),
                               (["-c", "group_by(.g) | map({g: .[0].g, n: length}) | .[0]"], b'{"g":0,"n":7693}\n')):
            with tempfile.TemporaryDirectory() as d:
                start = time.time()
                p = run(argv, data, d, timeout=120)
                self.assertEqual(p.stdout, expected, argv)
                self.assertLess(time.time() - start, 20, argv)


class Delivery(unittest.TestCase):
    def test_no_external_programs_and_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "pyjq")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        stdlib = set(sys.stdlib_module_names) | {"pyjq"}
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
