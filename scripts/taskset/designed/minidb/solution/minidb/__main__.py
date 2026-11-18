import sys

from .engine import Database


def main() -> int:
    if len(sys.argv) not in (2, 3):
        sys.stderr.write("usage: python3 -m minidb <database directory> [SQL]\n")
        return 2
    text = sys.argv[2] if len(sys.argv) == 3 else sys.stdin.read()
    return Database(sys.argv[1]).run(text)


sys.exit(main())
