import os
import tempfile
import unittest

from taskq import backends
from tests.backend_contract import BackendContract


class MemoryBackendTest(BackendContract, unittest.TestCase):
    def make(self):
        return backends.create("memory")


class JsonBackendTest(BackendContract, unittest.TestCase):
    def make(self):
        return backends.create("json", path=os.path.join(tempfile.mkdtemp(), "jobs.json"))

    def reopen(self, old):
        return backends.create("json", path=old.path)


class RegistryTest(unittest.TestCase):
    def test_names(self):
        self.assertIn("memory", backends.names())
        self.assertIn("json", backends.names())

    def test_unknown(self):
        with self.assertRaises(backends.UnknownBackend):
            backends.create("nope")


if __name__ == "__main__":
    unittest.main()
