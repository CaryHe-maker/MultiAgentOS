# pylua oracle design

The oracle replaces the Python process with `lua5.4` (5.4.7) through `os.execv`, so stdout, the error
line and the exit status are the reference interpreter's. The hidden tests were recorded with the same
interpreter in the same image, so the oracle passes every program test; this validates the recorded
expectations and the harness, not any interpreter logic.

A real implementation needs a lexer for long brackets and all escapes, a recursive-descent parser
with Lua's precedence (right-associative `..` and `^`), scoping with upvalues shared by closures,
64-bit integer arithmetic with wraparound next to IEEE floats, metamethod dispatch for every operator,
to-be-closed variables, coroutines, error values with position prefixes, and the string library's
pattern matcher and formatter.
