import os
import sys

os.execv("/usr/bin/git", ["git"] + sys.argv[1:])
