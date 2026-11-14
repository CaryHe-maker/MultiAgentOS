# pyjq (oracle)

This directory is the oracle of the pyjq task, not a real implementation: `python3 -m pyjq ...` runs
jq 1.7 (installed by `solve.sh`) with the same arguments. It shows that the hidden tests (expected
outputs recorded with the same jq) can be passed and fails, by design, the check that forbids external
programs. A real solution implements the jq language in pure Python: parser, generator-based evaluation
with backtracking, path expressions and assignment, the builtin library, and jq 1.7 number output.
