import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [
    ("SELECT 1;", "1\n"), ("SELECT 'a' || 'b';", "ab\n"), ("SELECT NULL;", "NULL\n"), ("SELECT 7 / 2;", "3\n"),
    ("SELECT 7.0 / 2;", "3.5\n"), ("SELECT typeof(1.0);", "real\n"), ("SELECT x'0a';", "x'0a'\n"),
    ("SELECT upper('a');", "A\n"), ("SELECT length('abc');", "3\n"), ("SELECT 1 = 1.0;", "1\n"),
    ("CREATE TABLE t(a); INSERT INTO t VALUES (2), (1); SELECT a FROM t ORDER BY a;", "1\n2\n"),
    ("CREATE TABLE t(a); INSERT INTO t VALUES (2), (1); SELECT count(*), sum(a) FROM t;", "2|3\n"),
    ("SELEC 1; SELECT 2;", "error\n2\n"), ("SELECT abs(-3);", "3\n"), ("SELECT coalesce(NULL, 5);", "5\n"),
    ("WITH c(x) AS (SELECT 1) SELECT x FROM c;", "1\n"), ("SELECT 1 UNION SELECT 2 ORDER BY 1;", "1\n2\n"),
    ("SELECT round(2.5);", "3.0\n"), ("SELECT CAST('5' AS INTEGER) + 1;", "6\n"), ("SELECT 'x' LIKE 'X';", "1\n"),
]


def run(script):
    with tempfile.TemporaryDirectory() as d:
        env = dict(os.environ, PYTHONPATH=ROOT)
        return subprocess.run([sys.executable, "-m", "sqlengine", os.path.join(d, "db")], input=script, env=env,
                              capture_output=True, text=True).stdout


class Cases(unittest.TestCase):
    pass


def _case(sql, expected):
    def test(self):
        self.assertEqual(run(sql), expected)

    return test


for n, (sql, expected) in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(sql, expected))
    setattr(Cases, f"test_case_{n:02d}_repeat", _case(sql + "\n", expected))

if __name__ == "__main__":
    unittest.main()
