"""Runs the hidden tests against the project in the working directory and writes the reward.

/logs/verifier/reward.txt gets the fraction of hidden tests passed; summary.json lists each test.
"""

import json
import os
import sys
import unittest

here = os.path.dirname(os.path.abspath(__file__))
project = os.environ.setdefault("PROJECT", os.getcwd())
sys.path.insert(0, here)
suite = unittest.defaultTestLoader.discover(here, pattern="test_hidden_*.py", top_level_dir=here)


class Recorder(unittest.TextTestResult):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.passed = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed.append(test.id())


result = unittest.TextTestRunner(resultclass=Recorder, verbosity=2).run(suite)
total = result.testsRun
failed = [t.id() for t, _ in result.failures + result.errors]
reward = round(len(result.passed) / total, 4) if total else 0.0
os.makedirs("/logs/verifier", exist_ok=True)
with open("/logs/verifier/reward.txt", "w") as f:
    f.write(f"{reward}\n")
with open("/logs/verifier/summary.json", "w") as f:
    json.dump({"total": total, "passed": len(result.passed), "failed": failed, "reward": reward}, f, indent=1)
print(f"hidden tests: {len(result.passed)}/{total} passed, reward {reward}")
