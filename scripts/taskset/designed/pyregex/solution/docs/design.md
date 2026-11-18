# pyregex oracle design

The oracle binds every public name of `re` to the package, so results are identical by construction;
this validates the recorded expectations and the evaluator, not engine logic. A real implementation
needs a parser that follows sre_parse's grammar and error rules, a compiler to a backtracking
instruction list (with marks for groups, repeat counters, lookaround sub-programs and atomic cuts),
case folding as re does it, and a template engine for sub with group references.
