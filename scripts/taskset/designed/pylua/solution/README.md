# pylua (oracle)

This directory is the oracle of the pylua task, not a real implementation: `python3 -m pylua` runs
`lua5.4` (installed by `solve.sh`) with the same arguments. It shows that the hidden tests,
whose expected outputs were recorded from the same lua5.4, can be passed, and it fails one hidden test
on purpose: the static check that forbids external programs.

A real solution implements Lua 5.4 in pure Python: a lexer, a parser for the full grammar, an
evaluator with integer and float subtypes, metamethod dispatch, coroutines (for example on threads or
generators), and the standard library including Lua patterns and string.format.
