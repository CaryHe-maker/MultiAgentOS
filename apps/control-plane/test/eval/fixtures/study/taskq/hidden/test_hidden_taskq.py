import os
import subprocess
import sys
import tempfile
import unittest

from taskq import backends
from taskq.queue import Queue
from tests.backend_contract import BackendContract


class HiddenSqliteContract(BackendContract, unittest.TestCase):
    def make(self):
        self.last_path = os.path.join(tempfile.mkdtemp(), "jobs.sqlite")
        return backends.create("sqlite", path=self.last_path)

    def reopen(self, old):
        return backends.create("sqlite", path=self.last_path)


class HiddenSqliteQueue(unittest.TestCase):
    def test_registered(self):
        self.assertIn("sqlite", backends.names())

    def test_retry_and_delay_on_sqlite(self):
        now = [1000.0]
        path = os.path.join(tempfile.mkdtemp(), "q.sqlite")
        queue = Queue(backends.create("sqlite", path=path), clock=lambda: now[0])

        def bad(payload):
            raise RuntimeError("boom")

        job_id = queue.enqueue("bad", max_attempts=2)
        later = queue.enqueue("ok", {"x": 1}, delay=10)
        self.assertEqual(queue.run_once({"bad": bad}).state, "queued")
        queue.backend.close()
        queue = Queue(backends.create("sqlite", path=path), clock=lambda: now[0])
        self.assertIsNone(queue.run_once({"bad": bad}))
        now[0] += 10
        ran = []
        self.assertEqual(queue.run_due({"bad": bad, "ok": ran.append}), 2)
        self.assertEqual(ran, [{"x": 1}])
        self.assertEqual(queue.backend.get(job_id).state, "failed")
        self.assertIn("boom", queue.backend.get(job_id).last_error)
        self.assertEqual(queue.backend.get(later).state, "done")
        with open(path, "rb") as handle:
            self.assertEqual(handle.read(15), b"SQLite format 3")


class HiddenSqliteCli(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def run_taskq(self, *args):
        return subprocess.run([sys.executable, "-m", "taskq", *args], capture_output=True, text=True)

    def test_backend_flag(self):
        db = os.path.join(self.dir, "flag.sqlite")
        common = ("--config", os.path.join(self.dir, "none.toml"), "--backend", "sqlite", "--db", db)
        self.assertEqual(self.run_taskq(*common, "enqueue", "echo", "--payload", '{"text": "from sqlite"}').returncode, 0)
        work = self.run_taskq(*common, "work")
        self.assertEqual(work.returncode, 0, work.stderr)
        self.assertIn("from sqlite", work.stdout)
        self.assertIn("done=1", self.run_taskq(*common, "stats").stdout.split())
        with open(db, "rb") as handle:
            self.assertEqual(handle.read(15), b"SQLite format 3")

    def test_config_names_sqlite(self):
        config = os.path.join(self.dir, "taskq.toml")
        db = os.path.join(self.dir, "conf.sqlite")
        with open(config, "w", encoding="utf8") as handle:
            handle.write(f'[backend]\nname = "sqlite"\npath = "{db.replace(chr(92), "/")}"\n')
        self.assertEqual(self.run_taskq("--config", config, "enqueue", "fail", "--max-attempts", "1").returncode, 0)
        self.run_taskq("--config", config, "work")
        self.assertIn("failed=1", self.run_taskq("--config", config, "stats").stdout.split())
        self.assertTrue(os.path.exists(db))

    def test_flag_overrides_config(self):
        config = os.path.join(self.dir, "taskq.toml")
        with open(config, "w", encoding="utf8") as handle:
            handle.write('[backend]\nname = "json"\n')
        db = os.path.join(self.dir, "over.sqlite")
        self.assertEqual(self.run_taskq("--config", config, "--backend", "sqlite", "--db", db, "enqueue", "echo").returncode, 0)
        with open(db, "rb") as handle:
            self.assertEqual(handle.read(15), b"SQLite format 3")


if __name__ == "__main__":
    unittest.main()
