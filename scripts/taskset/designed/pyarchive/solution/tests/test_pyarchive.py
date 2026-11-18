import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ, PYTHONPATH=ROOT)


def run(args, cwd, stdin=None):
    return subprocess.run([sys.executable, "-m", "pyarchive"] + args, cwd=cwd, input=stdin, env=ENV, capture_output=True)


class RoundTrips(unittest.TestCase):
    pass


def _gzip_case(data, level):
    def test(self):
        with tempfile.TemporaryDirectory() as d:
            comp = run(["gzip", "-c", level], d, data).stdout
            self.assertEqual(run(["gzip", "-d", "-c"], d, comp).stdout, data)

    return test


def _tar_case(n):
    def test(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "t"))
            for i in range(n):
                with open(os.path.join(d, "t", f"f{i}"), "w") as f:
                    f.write("x" * i)
            run(["tar", "-c", "-f", "a.tar", "t"], d)
            out = os.path.join(d, "o")
            os.makedirs(out)
            run(["tar", "-x", "-f", "a.tar", "-C", out], d)
            self.assertEqual(sorted(os.listdir(os.path.join(out, "t"))), sorted(f"f{i}" for i in range(n)))

    return test


for n in range(14):
    setattr(RoundTrips, f"test_gzip_{n:02d}", _gzip_case(b"abc" * (n * 50), f"-{1 + n % 9}"))
    setattr(RoundTrips, f"test_tar_{n:02d}", _tar_case(n + 1))
    setattr(RoundTrips, f"test_gzip_bytes_{n:02d}", _gzip_case(bytes(range(256)) * n, "-6"))

if __name__ == "__main__":
    unittest.main()
