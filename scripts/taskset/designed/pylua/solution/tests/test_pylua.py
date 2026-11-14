import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [
    ("print(1 + 1)", "2\n"), ("print(7 // 2, 7 / 2)", "3\t3.5\n"), ('print(("x"):rep(3))', "xxx\n"),
    ("print(#{1, 2, 3})", "3\n"), ('print(string.format("%5.2f", 3.14159))', " 3.14\n"),
    ("local t = {3, 1, 2} table.sort(t) print(table.concat(t, ','))", "1,2,3\n"),
    ("print(math.maxinteger + 1 == math.mininteger)", "true\n"), ('print(("a,b"):find(","))', "2\t2\n"),
    ("print(select('#', 1, nil, 3))", "3\n"), ("print(pcall(error, 'x', 0))", "false\tx\n"),
    ('print(("hello"):gsub("l", "L"))', "heLLo\t2\n"), ("print(10 == 10.0, math.type(10.0))", "true\tfloat\n"),
    ("local co = coroutine.wrap(function() coroutine.yield(1) end) print(co())", "1\n"),
    ("print(tostring(nil), tonumber('0x10'))", "nil\t16\n"), ("print(1 << 4, 5 & 3)", "16\t1\n"),
    ("goto a print('no') ::a:: print('yes')", "yes\n"), ("print(utf8.char(65, 66))", "AB\n"),
    ("local s = setmetatable({}, {__tostring = function() return 'S' end}) print(tostring(s))", "S\n"),
    ("print(next({}))", "nil\n"), ("print(('%d'):format(42))", "42\n"),
]


def run(code):
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "p.lua"), "w") as f:
            f.write(code)
        env = dict(os.environ, PYTHONPATH=ROOT)
        return subprocess.run([sys.executable, "-m", "pylua", "p.lua"], cwd=d, env=env, capture_output=True,
                              text=True).stdout


class Cases(unittest.TestCase):
    pass


def _case(code, expected):
    def test(self):
        self.assertEqual(run(code), expected)

    return test


for n, (code, expected) in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(code, expected))
    setattr(Cases, f"test_case_{n:02d}_in_block", _case("do " + code + " end", expected))

if __name__ == "__main__":
    unittest.main()
