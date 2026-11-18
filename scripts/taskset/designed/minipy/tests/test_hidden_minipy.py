"""Hidden tests of the minipy task: Python programs whose expected stdout, exit status and last line of
stderr come from CPython 3.12 (cases.json, built by build_cases.py), plus speed and delivery checks."""

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
DATA = json.load(open(os.path.join(HERE, "cases.json"), encoding="utf-8"))
ENV = {"PATH": "/usr/local/bin", "LC_ALL": "C.UTF-8", "PYTHONPATH": PROJECT}


def run(code, timeout=120):
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "prog.py"), "w", encoding="utf-8") as f:
            f.write(code)
        return subprocess.run([sys.executable, "-m", "minipy", "prog.py"], cwd=d, capture_output=True, env=ENV,
                              timeout=timeout)


class Programs(unittest.TestCase):
    pass


def _case(case):
    def test(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "minipy", "__main__.py")))
        p = run(case["code"])
        self.assertEqual(p.stdout.decode("utf-8", errors="replace"), case["stdout"])
        self.assertEqual(p.returncode, case["exit"])
        if case["exit"] == 1:
            err = p.stderr.decode("utf-8", errors="replace").strip().splitlines()
            last = err[-1] if err else ""
            if case["last_error"].startswith("SyntaxError"):
                self.assertTrue(last.startswith("SyntaxError"), last)
            else:
                self.assertEqual(last, case["last_error"])

    return test


for i, case in enumerate(DATA["cases"]):
    setattr(Programs, f"test_{i:03d}_{case['name']}", _case(case))


class Speed(unittest.TestCase):
    def timed(self, code, expected):
        start = time.time()
        p = run(code, timeout=180)
        self.assertEqual(p.stdout.decode(), expected)
        self.assertLess(time.time() - start, 30)

    def test_fib(self):
        self.timed("def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nprint(fib(22))\n", "17711\n")

    def test_bubble(self):
        code = ("a = [(i * 7919) % 20011 for i in range(2000)]\nn = len(a)\nfor i in range(n):\n"
                "    for j in range(n - 1 - i):\n        if a[j] > a[j + 1]:\n            a[j], a[j + 1] = a[j + 1], a[j]\n"
                "print(a[0], a[-1], a == sorted(a))\n")
        v = sorted((i * 7919) % 20011 for i in range(2000))
        self.timed(code, f"{v[0]} {v[-1]} True\n")

    def test_dict_updates(self):
        self.timed("d = {}\nfor i in range(100000):\n    d[i % 1000] = d.get(i % 1000, 0) + i\nprint(len(d), d[7])\n",
                   f"1000 {sum(i for i in range(100000) if i % 1000 == 7)}\n")


class Delivery(unittest.TestCase):
    def test_no_compiler_services_or_external_programs(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*"
                            r"|exec|eval|compile|__import__|importlib|breakpoint)\s*\(|\b(subprocess|importlib)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "minipy")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        forbidden = {"ast", "tokenize", "token", "codeop", "code", "dis", "runpy", "symtable", "parser", "importlib",
                     "subprocess", "pty"}
        allowed = (set(sys.stdlib_module_names) - forbidden) | {"minipy"}
        for path in files:
            text = open(path, encoding="utf-8", errors="replace").read()
            self.assertIsNone(banned.search(text), path)
            for m in re.finditer(r"^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))", text, re.M):
                if m.group(1):
                    continue
                names = [m.group(2)] if m.group(2) else [n.strip() for n in m.group(3).split(",")]
                for name in names:
                    self.assertIn(name.split(".")[0], allowed, f"{path}: {name}")

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
