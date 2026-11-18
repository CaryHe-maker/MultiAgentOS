# sqlengine (oracle)

This directory is the oracle of the sqlengine task, not a real implementation: it executes the
script with Python's `sqlite3` module, which the task forbids, and prints the results in the task's
format. It shows that the hidden tests (expected outputs recorded with the same SQLite 3.46.1) can be
passed and fails, by design, the check that forbids `sqlite3`. A real solution implements storage,
parsing, planning and execution of the SQLite dialect in pure Python, including type affinity.
