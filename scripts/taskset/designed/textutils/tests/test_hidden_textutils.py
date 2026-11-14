"""Hidden tests of the textutils task: invocations whose expected stdout, exit status and written files come
from the GNU tools of the task image (cases.json, built by build_cases.py; text stored as Latin-1, one
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
ENV = {"PATH": "/usr/local/bin", "LC_ALL": "C", "PYTHONPATH": PROJECT}


def run(argv, stdin, cwd, timeout=60):
    return subprocess.run([sys.executable, "-m", "textutils"] + argv, cwd=cwd, input=stdin.encode("latin-1"),
                          capture_output=True, env=ENV, timeout=timeout)


class Invocations(unittest.TestCase):
    pass


def _case(case):
    def test(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "textutils", "__main__.py")))
        with tempfile.TemporaryDirectory() as d:
            for name, content in case["files"].items():
                os.makedirs(os.path.dirname(os.path.join(d, name)), exist_ok=True)
                with open(os.path.join(d, name), "w", encoding="latin-1") as f:
                    f.write(content)
            p = run(case["argv"], case["stdin"], d)
            self.assertEqual(p.stdout.decode("latin-1"), case["stdout"])
            self.assertEqual(p.returncode, case["exit"])
            for name, content in case["outfiles"].items():
                path = os.path.join(d, name)
                got = open(path, "rb").read().decode("latin-1") if os.path.exists(path) else None
                self.assertEqual(got, content, name)

    return test


for i, case in enumerate(DATA["cases"]):
    setattr(Invocations, f"test_{i:03d}_{case['name']}", _case(case))


class Speed(unittest.TestCase):
    def test_half_million_lines(self):
        lines = "".join(f"w{i % 977} {(i * 7919) % 100003} {'a' * (i % 7)}b\n" for i in range(500000))
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "big.txt"), "w") as f:
                f.write(lines)
            for argv, check in ((["sort", "-k2,2n", "big.txt"], lambda out: out.count(b"\n") == 500000),
                                (["grep", "-c", "aaa*b$", "big.txt"], lambda out: out == b"%d\n" % sum(
                                    1 for i in range(500000) if i % 7 >= 2)),
                                (["sed", "s/a/b/g", "big.txt"], lambda out: out.count(b"a") == 0),
                                (["wc", "big.txt"], lambda out: out.split()[0] == b"500000")):
                start = time.time()
                p = subprocess.run([sys.executable, "-m", "textutils"] + argv, cwd=d, capture_output=True, env=ENV,
                                   timeout=120)
                self.assertTrue(check(p.stdout), argv)
                self.assertLess(time.time() - start, 30, argv)


class Delivery(unittest.TestCase):
    def test_no_external_programs_and_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "textutils")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        stdlib = set(sys.stdlib_module_names) | {"textutils"}
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
