import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [
    ("print(1 + 2)", "3\n"), ("print('a' * 3)", "aaa\n"), ("x = [1, 2]\nx.append(3)\nprint(x)", "[1, 2, 3]\n"),
    ("print(7 // 2, 7 % 3)", "3 1\n"), ("print({'a': 1}['a'])", "1\n"), ("def f(n): return n * 2\nprint(f(4))", "8\n"),
    ("print([i * i for i in range(4)])", "[0, 1, 4, 9]\n"), ("print(len('abc'))", "3\n"), ("print(sorted([3, 1, 2]))", "[1, 2, 3]\n"),
    ("class A:\n    def m(self): return 5\nprint(A().m())", "5\n"), ("try:\n    1 / 0\nexcept ZeroDivisionError:\n    print('z')", "z\n"),
    ("print(f'{3.14159:.2f}')", "3.14\n"), ("a, *b = 1, 2, 3\nprint(b)", "[2, 3]\n"), ("print(2 ** 64)", "18446744073709551616\n"),
    ("def g():\n    yield 1\n    yield 2\nprint(list(g()))", "[1, 2]\n"), ("print('x' if 1 else 'y')", "x\n"),
    ("print(sum(range(5)))", "10\n"), ("print(max([4, 9, 2]))", "9\n"), ("s = {1, 2}\ns.add(3)\nprint(len(s))", "3\n"),
    ("import math\nprint(math.sqrt(9))", "3.0\n"),
]


def run(code):
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "p.py"), "w") as f:
            f.write(code + "\n")
        env = dict(os.environ, PYTHONPATH=ROOT)
        return subprocess.run([sys.executable, "-m", "minipy", "p.py"], cwd=d, env=env, capture_output=True,
                              text=True).stdout


class Cases(unittest.TestCase):
    pass


def _case(code, expected):
    def test(self):
        self.assertEqual(run(code), expected)

    return test


for n, (code, expected) in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(code, expected))
    setattr(Cases, f"test_case_{n:02d}_in_function", _case("def main():\n" + "".join("    " + l + "\n" for l in code.splitlines()) + "main()", expected))

if __name__ == "__main__":
    unittest.main()
