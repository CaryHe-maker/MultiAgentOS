# pygit (oracle)

This directory is the oracle of the pygit task, not a real implementation: `python3 -m pygit` runs
`/usr/bin/git` with the same arguments. It shows that the hidden tests, which compare pygit with git
scenario by scenario, can be passed. It fails one hidden test on purpose: the static check that
forbids external programs. A real solution implements the object store, the index (DIRC version 2),
refs, packed refs and packfiles, and the commands listed in the specification in pure Python.

Usage: `python3 -m pygit <command> [arguments]` inside a repository.
