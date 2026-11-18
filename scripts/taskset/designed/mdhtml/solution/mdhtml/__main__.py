import sys

from . import to_html

text = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else sys.stdin.buffer.read().decode("utf-8")
sys.stdout.buffer.write(to_html(text).encode("utf-8"))
