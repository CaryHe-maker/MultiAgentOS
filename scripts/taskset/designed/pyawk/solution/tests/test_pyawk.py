import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = "a 1\nb 2\nc 3\n"
CASES = [
    ("{ print $1 }", "a\nb\nc\n"), ("{ s += $2 } END { print s }", "6\n"), ("NR == 2", "b 2\n"),
    ("END { print NR }", "3\n"), ("/b/", "b 2\n"), ("$2 > 1 { print $1 }", "b\nc\n"),
    ("{ print NF }", "2\n2\n2\n"), ("{ print $NF }", "1\n2\n3\n"), ('BEGIN { print "x" }', "x\n"),
    ("{ $1 = toupper($1); print }", "A 1\nB 2\nC 3\n"), ('{ printf "%s=%d;", $1, $2 } END { print "" }', "a=1;b=2;c=3;\n"),
    ("{ print length($0) }", "3\n3\n3\n"), ('{ print substr($0, 1, 1) }', "a\nb\nc\n"), ("{ n++ } END { print n }", "3\n"),
    ('BEGIN { OFS = "-" } { $1 = $1; print }', "a-1\nb-2\nc-3\n"), ("{ print $2 * 2 }", "2\n4\n6\n"),
    ('{ a[NR] = $1 } END { print a[3] a[1] }', "ca\n"), ("NR % 2", "a 1\nc 3\n"),
    ('{ gsub(/[0-9]/, "#"); print }', "a #\nb #\nc #\n"), ("END { print $1 }", "c\n"),
]


class Cases(unittest.TestCase):
    pass


def _case(prog, expected):
    def test(self):
        p = subprocess.run([sys.executable, "-m", "pyawk", prog], cwd=ROOT, input=DATA, capture_output=True, text=True)
        self.assertEqual(p.stdout, expected)

    return test


for n, (prog, expected) in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(prog, expected))
    setattr(Cases, f"test_case_{n:02d}_again", _case(prog, expected))

if __name__ == "__main__":
    unittest.main()
