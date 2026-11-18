import os
import sys

os.execv(sys.executable, [sys.executable] + sys.argv[1:])
