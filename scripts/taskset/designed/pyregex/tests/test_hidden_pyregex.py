"""Hidden tests of the pyregex task: 204 expressions whose expected results come from Python 3.12's re
(cases.json; both sides are evaluated by evaluate.py), plus speed and delivery checks."""

import json
import os
import re
import subprocess
import sys
import time
import unittest

PROJECT = os.environ.get("PROJECT", os.getcwd())
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(HERE, "cases.json")))
ENV = {"PATH": "/usr/local/bin", "LC_ALL": "C.UTF-8", "PYTHONPATH": PROJECT}
_results = {}


def results():
    if not _results and os.path.isfile(os.path.join(PROJECT, "pyregex", "__init__.py")):
        feed = "".join(json.dumps({"name": c["name"], "expr": c["expr"]}) + "\n" for c in DATA["cases"])
        try:
            p = subprocess.run([sys.executable, os.path.join(HERE, "evaluate.py"), "pyregex"], input=feed,
                               capture_output=True, text=True, env=ENV, cwd=PROJECT, timeout=1500)
            out = p.stdout
        except subprocess.TimeoutExpired as e:
            out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        for line in out.splitlines():
            try:
                j = json.loads(line)
                _results[j["name"]] = j["result"]
            except ValueError:
                pass
        _results.setdefault("__ran__", True)
    return _results


class Expressions(unittest.TestCase):
    pass


def _case(case):
    def test(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "pyregex", "__init__.py")))
        self.assertEqual(results().get(case["name"], "<not evaluated>"), case["expected"], case["expr"])

    return test


for case in DATA["cases"]:
    setattr(Expressions, f"test_{case['name']}", _case(case))


class Speed(unittest.TestCase):
    def test_megabyte_findall_and_sub(self):
        code = ("import pyregex as R, time\n"
                "text = ('word ann@x.com 12345 other@site.com x9 ' * 30000)[:1000000]\n"
                "t = time.time(); n = len(R.findall(r'\\b\\w+@\\w+\\.com\\b', text)); a = time.time() - t\n"
                "t = time.time(); s = R.sub(r'(\\d+)', r'<\\1>', text); b = time.time() - t\n"
                "print(n, s.count('<'), a < 20, b < 20)")
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=ENV, cwd=PROJECT,
                           timeout=300)
        text = ("word ann@x.com 12345 other@site.com x9 " * 30000)[:1000000]
        n = len(re.findall(r"\b\w+@\w+\.com\b", text))
        m = len(re.findall(r"\d+", text))
        self.assertEqual(p.stdout.strip(), f"{n} {m} True True")


class Delivery(unittest.TestCase):
    def test_no_re_no_external_programs_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "pyregex")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        forbidden = {"re", "sre_compile", "sre_parse", "sre_constants", "_sre", "fnmatch", "glob"}
        allowed = (set(sys.stdlib_module_names) - forbidden) | {"pyregex"}
        for path in files:
            text = open(path, encoding="utf-8", errors="replace").read()
            self.assertIsNone(banned.search(text), path)
            self.assertNotIn("__import__", text, path)
            self.assertNotIn("importlib", text, path)
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
