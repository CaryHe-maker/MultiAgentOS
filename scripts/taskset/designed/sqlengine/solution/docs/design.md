# sqlengine oracle design

Statements are split with `sqlite3.complete_statement`, executed one by one in autocommit mode (so
`BEGIN`, `COMMIT` and savepoints behave as in a script), and each result row is printed with NULL as
`NULL`, floats as `repr`, and blobs as `x'hex'`. A failing statement prints `error` and the script
continues; an open transaction at the end is rolled back. The database file lives in the given
directory, so data persists between runs. This validates the recorded expectations, not engine logic.
