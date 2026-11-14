# pyjq oracle design

The oracle replaces the Python process with `/usr/bin/jq` (1.7), so stdout and the exit status are the
reference interpreter's. This validates the recorded expectations and the harness, not interpreter
logic. A real implementation evaluates each filter as a Python generator over input values, tracks
paths alongside values for path(f) and the assignment operators, keeps number literals in their decimal
form until arithmetic touches them, and reproduces jq's pretty printer and its sort order of values.
