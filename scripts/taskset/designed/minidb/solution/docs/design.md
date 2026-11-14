# minidb design

## Storage
The database directory holds `snapshot.json` (generation g: all tables with their rows keyed by
rowid, and the index definitions) and `wal.<g>`, an append-only log. Each committed statement or
transaction appends exactly one JSON line: the list of its changes (insert, update, delete, create,
drop, add column, create index, drop index). The line is written with a single write and flushed.

## Commit and recovery
Opening the database loads the snapshot and replays every complete line of `wal.<g>`. A process
killed during a write leaves at most a torn last line, which fails to parse; replay stops there and
the file is truncated to the last complete line, so a statement or transaction is either fully
present or absent. Statements inside `BEGIN` change only memory; `COMMIT` writes their changes as
one line, `ROLLBACK` restores the state copied at `BEGIN`. When the log has many records the
database writes snapshot g+1 to a temporary file, fsyncs it, renames it over `snapshot.json` and
deletes `wal.<g>`; a crash in between leaves either the old snapshot with its log or the new
snapshot. An exclusive `flock` on `lock` serialises processes.

## Statements
Every statement computes its complete set of changes and checks types and constraints before any
change is applied, so a failing statement has no effect.

## Indexes
Index definitions are stored; a query of the form `WHERE column = literal` on a single table with an
index on that column takes the index path.

## Queries
Parsing produces a tree; column references are bound to positions in the joined row. Execution
follows FROM/JOIN (nested loops), WHERE, grouping with aggregates, HAVING, the select list,
DISTINCT, ORDER BY (stable sorts from the last key to the first, NULL lowest) and LIMIT/OFFSET.
