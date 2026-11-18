import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ, GIT_AUTHOR_NAME="A", GIT_AUTHOR_EMAIL="a@x", GIT_AUTHOR_DATE="1700000000 +0000",
           GIT_COMMITTER_NAME="C", GIT_COMMITTER_EMAIL="c@x", GIT_COMMITTER_DATE="1700000000 +0000",
           PYTHONPATH=ROOT)


def pygit(cwd, *args):
    return subprocess.run([sys.executable, "-m", "pygit", *args], cwd=cwd, env=ENV, capture_output=True, text=True)


class Commands(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        pygit(self.dir, "init")

    def tearDown(self):
        shutil.rmtree(self.dir)


def _blob_case(n):
    def test(self):
        path = os.path.join(self.dir, f"f{n}.txt")
        with open(path, "w") as f:
            f.write("x" * n + "\n")
        r = pygit(self.dir, "hash-object", f"f{n}.txt")
        self.assertEqual(len(r.stdout.strip()), 40)

    return test


def _commit_case(n):
    def test(self):
        for i in range(n):
            with open(os.path.join(self.dir, f"a{i}"), "w") as f:
                f.write(str(i))
        pygit(self.dir, "add", ".")
        self.assertEqual(pygit(self.dir, "commit", "-m", "m").returncode, 0)
        self.assertEqual(len(pygit(self.dir, "ls-files").stdout.split()), n)

    return test


for n in range(20):
    setattr(Commands, f"test_hash_{n:02d}", _blob_case(n))
    setattr(Commands, f"test_commit_{n:02d}", _commit_case(n + 1))

if __name__ == "__main__":
    unittest.main()
