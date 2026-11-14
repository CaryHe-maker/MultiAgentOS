"""Hidden tests of the mdhtml task: the 652 CommonMark 0.30 examples and 150 composite documents
(cases.json, expectations from `cmark --unsafe` 0.30.2), plus speed and delivery checks."""

import json
import os
import re
import subprocess
import sys
import time
import unittest

PROJECT = os.environ.get("PROJECT", os.getcwd())
HERE = os.path.dirname(os.path.abspath(__file__))
CASES = json.load(open(os.path.join(HERE, "cases.json"), encoding="utf-8"))
ENV = dict(os.environ, PYTHONPATH=PROJECT, PATH="/usr/local/bin")


def render(text, timeout=10):
    p = subprocess.run([sys.executable, "-m", "mdhtml"], cwd=PROJECT, env=ENV, input=text.encode("utf-8"),
                       capture_output=True, timeout=timeout)
    return p.returncode, p.stdout.decode("utf-8", errors="replace")


class Spec(unittest.TestCase):
    pass


class Composite(unittest.TestCase):
    pass


def _case(item):
    def test(self):
        code, out = render(item["markdown"])
        self.assertEqual(code, 0)
        self.assertEqual(out, item["html"])

    return test


for ex in CASES["examples"]:
    slug = re.sub(r"[^a-z0-9]+", "_", ex["section"].lower()).strip("_")
    setattr(Spec, f"test_{ex['n']:03d}_{slug}", _case(ex))
for c in CASES["composites"]:
    setattr(Composite, f"test_{c['n']:03d}", _case(c))


class Speed(unittest.TestCase):
    def test_one_megabyte(self):
        chunk = "".join(ex["markdown"] for ex in CASES["examples"][:200] if "\t" not in ex["markdown"]) + "\n\n"
        doc = ("# Heading\n\nSome *emphasis* and `code` and a [link](http://example.com).\n\n- a\n- b\n\n> quote\n\n"
               + chunk) * 1
        doc = (doc * (1_000_000 // len(doc) + 1))[:1_000_000]
        start = time.time()
        code, out = render(doc, timeout=60)
        self.assertEqual(code, 0)
        self.assertLess(time.time() - start, 10)
        self.assertIn("<h1>Heading</h1>", out)

    def test_function_matches_command(self):
        text = CASES["composites"][0]["markdown"]
        p = subprocess.run([sys.executable, "-c", "import sys, mdhtml; sys.stdout.write(mdhtml.to_html(sys.stdin.read()))"],
                           cwd=PROJECT, env=ENV, input=text, capture_output=True, text=True, timeout=10)
        self.assertEqual(p.stdout, CASES["composites"][0]["html"])


class Delivery(unittest.TestCase):
    def test_no_external_programs_and_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "mdhtml")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        stdlib = set(sys.stdlib_module_names) | {"mdhtml"}
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
