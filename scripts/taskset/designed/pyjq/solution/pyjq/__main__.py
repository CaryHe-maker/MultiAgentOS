import os
import sys

os.execv("/usr/bin/jq", ["jq"] + sys.argv[1:])
