import os
import subprocess
import sys
import tempfile
import unittest


class CliTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.db = os.path.join(self.dir, "jobs.json")

    def taskq(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "taskq", "--config", os.path.join(self.dir, "none.toml"), "--db", self.db, *args],
            capture_output=True,
            text=True,
        )

    def test_enqueue_work_stats(self):
        self.assertEqual(self.taskq("enqueue", "echo", "--payload", '{"text": "hi"}').returncode, 0)
        self.assertEqual(self.taskq("enqueue", "fail", "--max-attempts", "1").returncode, 0)
        work = self.taskq("work")
        self.assertIn("hi", work.stdout)
        stats = self.taskq("stats").stdout.split()
        self.assertIn("done=1", stats)
        self.assertIn("failed=1", stats)

    def test_config_file(self):
        config = os.path.join(self.dir, "taskq.toml")
        with open(config, "w", encoding="utf8") as handle:
            handle.write('[backend]\nname = "nope"\n')
        done = subprocess.run(
            [sys.executable, "-m", "taskq", "--config", config, "stats"], capture_output=True, text=True
        )
        self.assertEqual(done.returncode, 2)
        self.assertIn("unknown backend", done.stderr)


if __name__ == "__main__":
    unittest.main()
