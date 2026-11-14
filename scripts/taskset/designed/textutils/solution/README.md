# textutils (oracle)

This directory is the oracle of the textutils task, not a real implementation: `python3 -m textutils
<tool> ...` runs the GNU tool of the same name. It shows that the hidden tests (expected outputs recorded
from the same GNU tools with LC_ALL=C) can be passed and fails, by design, the check that forbids
external programs. A real solution implements grep, sed, sort, uniq, cut, tr, wc, head, tail, join,
paste, comm, nl, fold and expand in pure Python.
