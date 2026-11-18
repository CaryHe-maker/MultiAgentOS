"""python3 -m sales report EXPORT.csv [--json]"""
import argparse
import json
import sys

from .load import read_rows
from .report import as_json, monthly, render


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="sales")
    commands = parser.add_subparsers(dest="command", required=True)
    report = commands.add_parser("report")
    report.add_argument("export")
    report.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = monthly(read_rows(args.export))
    if args.json:
        json.dump(as_json(result), sys.stdout, indent=1)
        sys.stdout.write("\n")
    else:
        print(render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
