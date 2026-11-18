import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = "b 2\na 10\nc 1\na 10\n"
CASES = [
    (["sort"], "a 10\na 10\nb 2\nc 1\n"), (["sort", "-k2,2n"], "c 1\nb 2\na 10\na 10\n"), (["sort", "-u"], "a 10\nb 2\nc 1\n"),
    (["grep", "a"], "a 10\na 10\n"), (["grep", "-c", "a"], "2\n"), (["grep", "-v", "a"], "b 2\nc 1\n"),
    (["sed", "s/a/A/"], "b 2\nA 10\nc 1\nA 10\n"), (["sed", "-n", "2p"], "a 10\n"), (["sed", "1d"], "a 10\nc 1\na 10\n"),
    (["cut", "-d", " ", "-f1"], "b\na\nc\na\n"), (["cut", "-c1"], "b\na\nc\na\n"), (["tr", "a-c", "A-C"], "B 2\nA 10\nC 1\nA 10\n"),
    (["wc", "-l"], "4\n"), (["head", "-n", "1"], "b 2\n"), (["tail", "-n", "1"], "a 10\n"), (["uniq"], "b 2\na 10\nc 1\na 10\n"),
    (["nl", "-b", "a"], "     1\tb 2\n     2\ta 10\n     3\tc 1\n     4\ta 10\n"), (["fold", "-w", "2"], "b \n2\na \n10\nc \n1\na \n10\n"),
    (["paste", "-s", "-d", ","], "b 2,a 10,c 1,a 10\n"), (["expand"], DATA),
]


def run(argv):
    env = dict(os.environ, PYTHONPATH=ROOT, LC_ALL="C")
    return subprocess.run([sys.executable, "-m", "textutils"] + argv, input=DATA, env=env, capture_output=True,
                          text=True).stdout


class Cases(unittest.TestCase):
    pass


def _case(argv, expected):
    def test(self):
        self.assertEqual(run(argv), expected)

    return test


for n, (argv, expected) in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(argv, expected))
    setattr(Cases, f"test_case_{n:02d}_again", _case(argv, expected))

if __name__ == "__main__":
    unittest.main()
