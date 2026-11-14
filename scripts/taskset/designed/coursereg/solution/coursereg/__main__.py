import argparse

from .app import serve

parser = argparse.ArgumentParser(prog="python3 -m coursereg")
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--data", required=True)
args = parser.parse_args()
serve(args.port, args.data)
