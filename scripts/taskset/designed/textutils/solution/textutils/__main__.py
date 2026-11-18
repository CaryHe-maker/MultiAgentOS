"""Oracle of the textutils task: runs the GNU tool of the same name. It validates the hidden tests and
fails, by design, the check that forbids external programs."""
import os
import sys

os.execv("/usr/bin/" + sys.argv[1], sys.argv[1:])
