"""What every backend must do. A backend's test case mixes this in and says how to make one:

    class MyBackendTest(BackendContract, unittest.TestCase):
        def make(self):          # a new, empty backend
        def reopen(self, old):   # the same storage opened again (None when it is not persistent)
"""
from taskq.job import STATES, Job


def job(name="j", **fields):
    import uuid

    return Job(id=uuid.uuid4().hex, name=name, **fields)


class BackendContract:
    def make(self):
        raise NotImplementedError

    def reopen(self, old):
        return None

    def test_put_get(self):
        backend = self.make()
        stored = backend.put(job("a", payload={"n": 1, "nested": {"x": [1, 2]}}))
        got = backend.get(stored.id)
        self.assertEqual(got.name, "a")
        self.assertEqual(got.payload, {"n": 1, "nested": {"x": [1, 2]}})
        self.assertEqual(got.state, "queued")
        self.assertIsNone(backend.get("missing"))

    def test_seq_in_order_of_put(self):
        backend = self.make()
        first = backend.put(job("a"))
        second = backend.put(job("b"))
        self.assertLess(first.seq, second.seq)
        self.assertEqual([each.name for each in backend.list()], ["a", "b"])

    def test_claim_earliest_due_then_seq(self):
        backend = self.make()
        backend.put(job("late", run_at=50.0))
        backend.put(job("tie1", run_at=10.0))
        backend.put(job("tie2", run_at=10.0))
        backend.put(job("future", run_at=500.0))
        self.assertEqual(backend.claim(100.0).name, "tie1")
        self.assertEqual(backend.claim(100.0).name, "tie2")
        self.assertEqual(backend.claim(100.0).name, "late")
        self.assertIsNone(backend.claim(100.0))

    def test_claim_marks_running(self):
        backend = self.make()
        stored = backend.put(job("a"))
        claimed = backend.claim(1.0)
        self.assertEqual(claimed.state, "running")
        self.assertEqual(backend.get(stored.id).state, "running")

    def test_save_and_list_by_state(self):
        backend = self.make()
        stored = backend.put(job("a"))
        backend.put(job("b"))
        stored.state = "failed"
        stored.attempts = 3
        stored.last_error = "RuntimeError: no"
        backend.save(stored)
        failed = backend.list("failed")
        self.assertEqual([each.name for each in failed], ["a"])
        self.assertEqual(failed[0].attempts, 3)
        self.assertEqual(failed[0].last_error, "RuntimeError: no")
        self.assertEqual([each.name for each in backend.list("queued")], ["b"])

    def test_counts_every_state(self):
        backend = self.make()
        backend.put(job("a"))
        counts = backend.counts()
        self.assertEqual(set(counts), set(STATES))
        self.assertEqual(counts["queued"], 1)
        self.assertEqual(counts["done"], 0)

    def test_survives_reopening(self):
        backend = self.make()
        first = backend.put(job("a", run_at=5.5, payload={"k": "v"}))
        first.attempts = 1
        backend.save(first)
        backend.close()
        again = self.reopen(backend)
        if again is None:
            self.skipTest("not persistent")
        got = again.get(first.id)
        self.assertEqual(got.payload, {"k": "v"})
        self.assertEqual(got.run_at, 5.5)
        self.assertEqual(got.attempts, 1)
        later = again.put(job("b"))
        self.assertGreater(later.seq, first.seq)
        again.close()
