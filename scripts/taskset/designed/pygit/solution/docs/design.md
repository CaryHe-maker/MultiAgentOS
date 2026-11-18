# pygit oracle design

The oracle delegates every command to the real git with `os.execv`, so its repository format,
output and exit codes are git's by construction. This keeps the hidden tests honest: each test runs
the same scenario through pygit and through git, and any difference in object ids, porcelain output,
working trees or index contents comes from the implementation under test, never from the tests.

A real implementation needs: loose objects (zlib-compressed `<type> <size>\0<data>`, SHA-1 ids), tree
entry ordering (directories sort as if named with a trailing slash), the DIRC version 2 index with
stat data and sorted entries, refs and `packed-refs`, packfiles with version 2 indexes and OFS/REF
deltas, revision parsing, and a line-based three-way merge for content conflicts.
