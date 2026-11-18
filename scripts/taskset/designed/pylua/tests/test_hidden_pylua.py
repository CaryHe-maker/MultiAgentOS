"""Hidden tests of the pylua task: Lua programs whose expected stdout, exit status and first error line come
from lua5.4 5.4.7 (cases.json, built by build_cases.py; text is stored as Latin-1, one character per byte),
plus speed and delivery checks."""

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


def run(code, stdin="", args=(), timeout=60):
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "prog.lua"), "w", encoding="utf-8") as f:
            f.write(code)
        return subprocess.run([sys.executable, "-m", "pylua", "prog.lua", *args], cwd=d, input=stdin.encode("utf-8"),
                              capture_output=True, env=ENV, timeout=timeout)


def message(stderr):
    first = stderr.splitlines()[0] if stderr.splitlines() else ""
    return first.split(": ", 1)[1] if ": " in first else first


class Programs(unittest.TestCase):
    pass


def _case(case):
    def test(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "pylua", "__main__.py")))
        p = run(case["code"], case["stdin"], case["args"])
        self.assertEqual(p.stdout.decode("latin-1"), case["stdout"])
        self.assertEqual(p.returncode, case["exit"])
        if case["exit"] == 1:
            self.assertEqual(message(p.stderr.decode("latin-1")), message(case["stderr"]))

    return test


for i, case in enumerate(DATA["cases"]):
    setattr(Programs, f"test_{i:03d}_{case['name']}", _case(case))


class Speed(unittest.TestCase):
    def timed(self, code, expected):
        start = time.time()
        p = run(code, timeout=120)
        self.assertEqual(p.stdout.decode(), expected)
        self.assertLess(time.time() - start, 20)

    def test_fib(self):
        self.timed("local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end print(fib(25))",
                   "75025\n")

    def test_sort(self):
        v = sorted((i * 7919) % 100003 for i in range(1, 100001))
        self.timed("local t = {} for i = 1, 100000 do t[i] = (i * 7919) % 100003 end table.sort(t) "
                   "print(t[1], t[50000], t[100000])", f"{v[0]}\t{v[49999]}\t{v[99999]}\n")

    def test_concat(self):
        self.timed("local t = {} for i = 1, 100000 do t[i] = tostring(i % 10) end local s = table.concat(t) "
                   "print(#s, s:sub(1, 12))", "100000\t123456789012\n")


class Delivery(unittest.TestCase):
    def test_no_external_programs_and_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "pylua")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        stdlib = set(sys.stdlib_module_names) | {"pylua"}
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
