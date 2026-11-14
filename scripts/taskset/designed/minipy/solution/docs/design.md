# minipy oracle design

The oracle replaces the process with CPython, so stdout, the exit status and the last traceback line are
the reference interpreter's. This validates the recorded expectations, not interpreter logic. A real
implementation tokenizes with an indentation stack (INDENT/DEDENT, bracket nesting), parses with
precedence climbing, resolves names with LEGB scoping and cells for closures, models classes with C3
linearization for super(), implements generators with Python generators or threads, and reproduces the
messages of the built-in exceptions.
