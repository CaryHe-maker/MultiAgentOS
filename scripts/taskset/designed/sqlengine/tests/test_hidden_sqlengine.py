"""Hidden tests of the sqlengine task: SQL scripts whose expected output comes from SQLite 3.46.1 through
Python's sqlite3 (cases.json, built by build_cases.py), plus persistence, speed and delivery checks."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

PROJECT = os.environ.get("PROJECT", os.getcwd())
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(HERE, "cases.json")))
ENV = {"PATH": "/usr/local/bin", "LC_ALL": "C.UTF-8", "PYTHONPATH": PROJECT}


def run(db, script, timeout=120):
    return subprocess.run([sys.executable, "-m", "sqlengine", db], input=script.encode(), capture_output=True,
                          env=ENV, cwd=PROJECT, timeout=timeout)


def script(statements):
    return "".join(s + ";\n" for s in statements)


class Scripts(unittest.TestCase):
    pass


def _case(case):
    def test(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "sqlengine", "__main__.py")))
        d = tempfile.mkdtemp()
        try:
            p = run(os.path.join(d, "db"), script(case["statements"]))
            self.assertEqual(p.returncode, 0, p.stderr.decode()[-500:])
            self.assertEqual(p.stdout.decode(), case["stdout"])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    return test


for i, case in enumerate(DATA["cases"]):
    setattr(Scripts, f"test_{i:03d}_{case['name']}", _case(case))


class Persistence(unittest.TestCase):
    def test_data_survives_between_runs(self):
        d = tempfile.mkdtemp()
        try:
            db = os.path.join(d, "db")
            run(db, script(["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t(v) VALUES ('a'), ('b')",
                            "CREATE INDEX tv ON t(v)", "CREATE VIEW vv AS SELECT v FROM t WHERE id > 1"]))
            run(db, script(["BEGIN", "INSERT INTO t(v) VALUES ('lost')"]))
            p = run(db, script(["SELECT id, v FROM t ORDER BY id", "SELECT * FROM vv", "INSERT INTO t(v) VALUES ('c')",
                                "SELECT max(id) FROM t"]))
            self.assertEqual(p.stdout.decode(), "1|a\n2|b\nb\n3\n")
        finally:
            shutil.rmtree(d, ignore_errors=True)


class Speed(unittest.TestCase):
    def test_bulk_insert_index_and_join(self):
        d = tempfile.mkdtemp()
        try:
            db = os.path.join(d, "db")
            rows = ",".join(f"({i}, 'k{i}', {i % 100})" for i in range(100000))
            start = time.time()
            p = run(db, script(["CREATE TABLE big(id INTEGER PRIMARY KEY, k TEXT, g INTEGER)", "BEGIN",
                                f"INSERT INTO big VALUES {rows}", "COMMIT", "CREATE INDEX bk ON big(k)"]), timeout=300)
            self.assertEqual(p.returncode, 0)
            self.assertLess(time.time() - start, 30)
            start = time.time()
            p = run(db, script(["SELECT id, g FROM big WHERE k = 'k77777'"]))
            self.assertEqual(p.stdout.decode(), "77777|77\n")
            self.assertLess(time.time() - start, 2)
            a = ",".join(f"({i}, {i % 500})" for i in range(10000))
            b = ",".join(f"({i}, 'b{i}')" for i in range(10000))
            run(db, script(["CREATE TABLE a(id INTEGER, ref INTEGER)", "CREATE TABLE b(id INTEGER, label TEXT)",
                            f"INSERT INTO a VALUES {a}", f"INSERT INTO b VALUES {b}"]), timeout=300)
            start = time.time()
            p = run(db, script(["SELECT count(*), sum(a.id) FROM a JOIN b ON a.ref = b.id"]), timeout=300)
            self.assertEqual(p.stdout.decode(), f"10000|{sum(range(10000))}\n")
            self.assertLess(time.time() - start, 20)
        finally:
            shutil.rmtree(d, ignore_errors=True)


class Delivery(unittest.TestCase):
    def test_no_external_programs_no_sqlite_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "sqlengine")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        allowed = (set(sys.stdlib_module_names) - {"sqlite3", "_sqlite3", "dbm", "shelve"}) | {"sqlengine"}
        for path in files:
            text = open(path, encoding="utf-8", errors="replace").read()
            self.assertIsNone(banned.search(text), path)
            for m in re.finditer(r"^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+))", text, re.M):
                if m.group(1):
                    continue
                self.assertIn((m.group(2) or m.group(3)).split(".")[0], allowed, path)

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
