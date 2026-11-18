# minipy (oracle)

This directory is the oracle of the minipy task, not a real implementation: `python3 -m minipy prog.py`
runs the script with CPython. It shows that the hidden tests (expected outputs recorded with the same
CPython 3.12) can be passed and fails, by design, the check that forbids external programs and compiler
services. A real solution has its own tokenizer with indentation tracking, a parser, scopes with closures,
an object model with method resolution order, exceptions and generators, all in pure Python.
