# pyawk oracle design

The oracle replaces the Python process with `gawk --posix` through `os.execv`, so stdout, stderr,
written files and exit status are gawk's. The hidden tests were recorded with gawk 5.2.1 in POSIX
mode in the same image, so the oracle passes every program test; this validates the recorded
expectations and the test harness, not any interpreter logic.

A real implementation needs: tokenization with the regex/division rule (a `/` starts a regex where an
operand is expected), the newline and semicolon rules of the grammar, a recursive-descent parser with
awk's precedence table (non-associative comparisons, right-associative `^`, implicit concatenation),
values that remember whether they are strnums, CONVFMT/OFMT conversions, field splitting for the
three kinds of FS, paragraph mode, getline variants, output redirection with a table of open files,
and translation of POSIX EREs (bracket classes, intervals) to Python's `re`.
