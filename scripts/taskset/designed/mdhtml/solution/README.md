# mdhtml (oracle)

This directory is the oracle of the mdhtml task, not a real implementation: `python3 -m mdhtml` and
`mdhtml.to_html` call the reference implementation `cmark --unsafe` 0.30, which `solve.sh` installs.
It shows that the hidden tests (the CommonMark 0.30 examples and composite documents whose
expectations come from the same cmark) can be passed, and it fails one hidden test on purpose: the
static check that forbids external programs.

A real solution implements the CommonMark 0.30 specification in pure Python: the block phase
(container blocks, leaf blocks, lazy continuation, link reference definitions) and the inline phase
(delimiter run algorithm for emphasis, links and images, entities, autolinks, raw HTML).
