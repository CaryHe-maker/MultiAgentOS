# pyregex (oracle)

This directory is the oracle of the pyregex task, not a real implementation: the package re-exports
Python's `re`, which the task forbids. It shows that the hidden tests (expected results recorded from
the same `re` through the same evaluator) can be passed and fails, by design, the check that forbids
`re`. A real solution parses patterns, compiles them (for example to a backtracking program), matches
with all of re's semantics and reproduces its Pattern and Match API.
