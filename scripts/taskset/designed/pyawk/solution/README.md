# pyawk (oracle)

This directory is the oracle of the pyawk task, not a real implementation: `python3 -m pyawk` runs
`gawk --posix` (installed by `solve.sh`) with the same arguments. It shows that the hidden tests,
whose expected outputs were recorded from the same gawk, can be passed, and it fails one hidden test
on purpose: the static check that forbids external programs.

A real solution implements POSIX awk in pure Python: a lexer that tells regular expressions from
division and handles newlines as terminators, a parser for the full grammar (patterns, ranges,
statements, getline forms, concatenation), and an evaluator with awk's string/number semantics.
