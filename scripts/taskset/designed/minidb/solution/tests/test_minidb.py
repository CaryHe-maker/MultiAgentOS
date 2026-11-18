import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (setup SQL, query, expected stdout lines of the query)
CASES = [
    ("", "SELECT 1 + 1", ["expr1", "2"]),
    ("", "SELECT 7 / 2", ["expr1", "3"]),
    ("", "SELECT -7 / 2", ["expr1", "-3"]),
    ("", "SELECT -7 % 3", ["expr1", "-1"]),
    ("", "SELECT 1 / 0", ["expr1", "NULL"]),
    ("", "SELECT 7.0 / 2", ["expr1", "3.5"]),
    ("", "SELECT 'a' || 1", ["expr1", "a1"]),
    ("", "SELECT NULL || 'a'", ["expr1", "NULL"]),
    ("", "SELECT NULL AND 0", ["expr1", "0"]),
    ("", "SELECT NULL OR 1", ["expr1", "1"]),
    ("", "SELECT NOT NULL", ["expr1", "NULL"]),
    ("", "SELECT 3 IN (1, NULL)", ["expr1", "NULL"]),
    ("", "SELECT 2 IN (1, 2)", ["expr1", "1"]),
    ("", "SELECT 'Abc' LIKE 'a%'", ["expr1", "1"]),
    ("", "SELECT 5 BETWEEN 1 AND 9", ["expr1", "1"]),
    ("", "SELECT ROUND(2.5)", ["expr1", "3.0"]),
    ("", "SELECT ROUND(-2.5)", ["expr1", "-3.0"]),
    ("", "SELECT SUBSTR('hello', 2, 3)", ["expr1", "ell"]),
    ("", "SELECT COALESCE(NULL, 2)", ["expr1", "2"]),
    ("", "SELECT UPPER('ab') AS u", ["u", "AB"]),
    ("", "SELECT CASE WHEN 0 THEN 1 ELSE 2 END", ["expr1", "2"]),
    ("", "SELECT LENGTH('abc')", ["expr1", "3"]),
    ("", "SELECT ABS(-4)", ["expr1", "4"]),
    ("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (2, 'x'), (1, NULL)",
     "SELECT * FROM t ORDER BY a", ["a|b", "1|NULL", "2|x"]),
    ("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (2), (NULL), (1)",
     "SELECT a FROM t ORDER BY a DESC", ["a", "2", "1", "NULL"]),
    ("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2), (3)",
     "SELECT a FROM t ORDER BY a LIMIT 1 OFFSET 1", ["a", "2"]),
    ("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (1), (2)",
     "SELECT DISTINCT a FROM t ORDER BY a", ["a", "1", "2"]),
    ("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (NULL)",
     "SELECT COUNT(*), COUNT(a), SUM(a) FROM t", ["expr1|expr2|expr3", "2|1|1"]),
    ("CREATE TABLE t (g TEXT, v INTEGER); INSERT INTO t VALUES ('a', 1), ('a', 2), ('b', 5)",
     "SELECT g, SUM(v) FROM t GROUP BY g ORDER BY g", ["g|expr2", "a|3", "b|5"]),
    ("CREATE TABLE t (g TEXT, v INTEGER); INSERT INTO t VALUES ('a', 1), ('a', 4), ('b', 5)",
     "SELECT g FROM t GROUP BY g HAVING SUM(v) > 4 ORDER BY g", ["g", "a", "b"]),
    ("CREATE TABLE t (v INTEGER)", "SELECT COUNT(*), MAX(v) FROM t", ["expr1|expr2", "0|NULL"]),
    ("CREATE TABLE a (x INTEGER); CREATE TABLE b (x INTEGER, y TEXT); INSERT INTO a VALUES (1), (2);"
     " INSERT INTO b VALUES (1, 'p')",
     "SELECT a.x, b.y FROM a LEFT JOIN b ON a.x = b.x ORDER BY a.x", ["x|y", "1|p", "2|NULL"]),
    ("CREATE TABLE a (x INTEGER); CREATE TABLE b (x INTEGER); INSERT INTO a VALUES (1), (2);"
     " INSERT INTO b VALUES (2)",
     "SELECT a.x FROM a JOIN b ON a.x = b.x", ["x", "2"]),
    ("CREATE TABLE t (a REAL); INSERT INTO t VALUES (3)", "SELECT a FROM t", ["a", "3.0"]),
    ("CREATE TABLE t (a INTEGER DEFAULT 7, b TEXT); INSERT INTO t (b) VALUES ('q')",
     "SELECT a, b FROM t", ["a|b", "7|q"]),
    ("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1); ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'z'",
     "SELECT * FROM t", ["a|b", "1|z"]),
    ("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2); UPDATE t SET a = a * 10 WHERE a = 2",
     "SELECT a FROM t ORDER BY a", ["a", "1", "20"]),
    ("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2); DELETE FROM t WHERE a = 1",
     "SELECT a FROM t", ["a", "2"]),
    ("CREATE TABLE t (a INTEGER); BEGIN; INSERT INTO t VALUES (1); ROLLBACK", "SELECT COUNT(*) FROM t",
     ["expr1", "0"]),
    ("CREATE TABLE t (a INTEGER); CREATE INDEX i ON t (a); INSERT INTO t VALUES (5), (6)",
     "SELECT a FROM t WHERE a = 6", ["a", "6"]),
]

ERRORS = [
    "SELECT 'a' + 1",
    "SELECT 1 < 'a'",
    "SELECT nosuch(1)",
    "SELECT LENGTH(1)",
    "CREATE TABLE t (a INTEGER); INSERT INTO t VALUES ('x')",
    "CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (1)",
    "CREATE TABLE t (a INTEGER NOT NULL); INSERT INTO t VALUES (NULL)",
    "CREATE TABLE t (a INTEGER); CREATE TABLE t (b INTEGER)",
    "SELECT * FROM missing",
    "COMMIT",
    "CREATE TABLE t (g TEXT, v INTEGER); SELECT g, v FROM t GROUP BY g",
]


def run(db, sql):
    p = subprocess.run([sys.executable, "-m", "minidb", db, sql], cwd=ROOT, capture_output=True, text=True)
    return p.returncode, p.stdout.splitlines(), p.stderr


class Cases(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)


def _case(setup, query, expected):
    def test(self):
        db = os.path.join(self.tmp, "db")
        if setup:
            code, _, err = run(db, setup)
            self.assertEqual(code, 0, err)
        code, out, err = run(db, query)
        self.assertEqual(code, 0, err)
        self.assertEqual(out, expected)

    return test


def _error(sql):
    def test(self):
        code, _, err = run(os.path.join(self.tmp, "db"), sql)
        self.assertEqual(code, 1)
        self.assertTrue(err.startswith("error:"))

    return test


for n, c in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(*c))
for n, sql in enumerate(ERRORS):
    setattr(Cases, f"test_error_{n:02d}", _error(sql))

if __name__ == "__main__":
    unittest.main()
