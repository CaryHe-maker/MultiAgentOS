import os
import sys

os.execv("/usr/bin/lua5.4", ["lua5.4"] + sys.argv[1:])
