# textutils oracle design

The oracle replaces the Python process with `/usr/bin/<tool>`, so stdout, written files and exit status
are the GNU tools' own. This validates the recorded expectations and the harness, not any tool logic.
A real implementation needs a BRE/ERE translator to Python regular expressions (with POSIX classes,
back-references and GNU extensions such as \w and \b), the sed cycle with pattern and hold spaces,
labels and append queues, and sort keys with field and character positions, per-key modifiers, the
last-resort whole-line comparison, and stable mode.
