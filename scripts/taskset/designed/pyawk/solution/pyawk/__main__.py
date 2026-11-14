import os
import sys

os.execv("/usr/bin/gawk", ["gawk", "--posix"] + sys.argv[1:])
