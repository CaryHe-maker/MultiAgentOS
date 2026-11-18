import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [
    (".", '{"a":1}', '{\n  "a": 1\n}\n'), ("-c .", '{"a":[1,2]}', '{"a":[1,2]}\n'), (".a", '{"a":1}', "1\n"),
    (".[]", "[1,2]", "1\n2\n"), ("-c map(.*2)", "[1,2]", "[2,4]\n"), ("length", '"abc"', "3\n"),
    ("keys", '{"b":1,"a":2}', '[\n  "a",\n  "b"\n]\n'), ("-r .", '"x"', "x\n"), ("add", "[1,2,3]", "6\n"),
    ("-c [.[]|select(.>1)]", "[1,2,3]", "[2,3]\n"), (".a // 5", "{}", "5\n"), ("-c sort", "[3,1,2]", "[1,2,3]\n"),
    ('-r "\(.a)-\(.b)"', '{"a":1,"b":"x"}', "1-x\n"), ("type", "null", '"null"\n'), ("-c to_entries", '{"a":1}', '[{"key":"a","value":1}]\n'),
    ("reduce .[] as $x (0; .+$x)", "[1,2,3]", "6\n"), ('-c split(",")', '"a,b"', '["a","b"]\n'), ("-c .a = 2", '{"a":1}', '{"a":2}\n'),
    ("-c [range(3)]", "null", "[0,1,2]\n"), ("-c del(.a)", '{"a":1,"b":2}', '{"b":2}\n'),
]


def run(args, stdin):
    env = dict(os.environ, PYTHONPATH=ROOT)
    return subprocess.run([sys.executable, "-m", "pyjq"] + args.split(" ", 1)[:1] + (args.split(" ", 1)[1:] if args.startswith("-") else []),
                          input=stdin, env=env, capture_output=True, text=True).stdout


class Cases(unittest.TestCase):
    pass


def _case(args, stdin, expected):
    def test(self):
        argv = args.split(" ", 1) if args.startswith("-") else [args]
        env = dict(os.environ, PYTHONPATH=ROOT)
        out = subprocess.run([sys.executable, "-m", "pyjq"] + argv, input=stdin, env=env, capture_output=True,
                             text=True).stdout
        self.assertEqual(out, expected)

    return test


for n, case in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(*case))
    setattr(Cases, f"test_case_{n:02d}_again", _case(*case))

if __name__ == "__main__":
    unittest.main()
