import os
import sys

os.environ["PATH"] = "/usr/bin:/bin:" + os.environ.get("PATH", "")
os.execv("/usr/bin/" + sys.argv[1], sys.argv[1:])
