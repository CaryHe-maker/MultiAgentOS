import unittest

from taskq import backends
from taskq.queue import Queue


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.queue = Queue(backends.create("memory"), clock=self.clock)
        self.seen = []
        self.handlers = {"ok": self.seen.append, "bad": self.bad}

    def bad(self, payload):
        raise ValueError("bad payload")

    def test_runs_in_order(self):
        self.queue.enqueue("ok", {"n": 1})
        self.queue.enqueue("ok", {"n": 2})
        self.assertEqual(self.queue.run_due(self.handlers), 2)
        self.assertEqual(self.seen, [{"n": 1}, {"n": 2}])

    def test_delay(self):
        self.queue.enqueue("ok", {"n": 1}, delay=30)
        self.assertIsNone(self.queue.run_once(self.handlers))
        self.clock.now += 30
        self.assertEqual(self.queue.run_once(self.handlers).state, "done")

    def test_retry_with_backoff_then_fail(self):
        job_id = self.queue.enqueue("bad", max_attempts=2)
        first = self.queue.run_once(self.handlers)
        self.assertEqual(first.state, "queued")
        self.assertEqual(first.run_at, 1002.0)
        self.assertIsNone(self.queue.run_once(self.handlers))
        self.clock.now += 2
        second = self.queue.run_once(self.handlers)
        self.assertEqual(second.state, "failed")
        self.assertIn("bad payload", self.queue.backend.get(job_id).last_error)

    def test_unknown_handler_fails_the_attempt(self):
        self.queue.enqueue("missing", max_attempts=1)
        self.assertEqual(self.queue.run_once(self.handlers).state, "failed")


if __name__ == "__main__":
    unittest.main()
