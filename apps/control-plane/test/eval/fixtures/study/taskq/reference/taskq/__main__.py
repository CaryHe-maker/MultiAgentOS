"""python3 -m taskq [--config taskq.toml] [--db PATH] COMMAND

    enqueue NAME [--payload JSON] [--delay SECONDS] [--max-attempts N]   prints the job id
    list [--state STATE]                                                 one job per line
    stats                                                                state=count per line
    work [--once]                                                        runs due jobs
"""
import argparse
import json
import sys

from . import backends, config
from .handlers import HANDLERS
from .queue import Queue


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(prog="taskq")
    top.add_argument("--config", default="taskq.toml")
    top.add_argument("--db", help="where the backend keeps its jobs (its path)")
    top.add_argument("--backend", help="a registered backend; overrides the config file")
    commands = top.add_subparsers(dest="command", required=True)
    enqueue = commands.add_parser("enqueue")
    enqueue.add_argument("name")
    enqueue.add_argument("--payload", default="{}")
    enqueue.add_argument("--delay", type=float, default=0.0)
    enqueue.add_argument("--max-attempts", type=int, default=3)
    listing = commands.add_parser("list")
    listing.add_argument("--state")
    commands.add_parser("stats")
    work = commands.add_parser("work")
    work.add_argument("--once", action="store_true")
    return top


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    settings = config.load(args.config)
    path = args.db or settings.path
    try:
        backend = backends.create(args.backend or settings.backend, path=path)
    except backends.UnknownBackend as error:
        print(error, file=sys.stderr)
        return 2
    queue = Queue(backend)
    try:
        if args.command == "enqueue":
            print(queue.enqueue(args.name, json.loads(args.payload), args.delay, args.max_attempts))
        elif args.command == "list":
            for job in backend.list(args.state):
                print(f"{job.id} {job.name} {job.state} attempts={job.attempts}")
        elif args.command == "stats":
            for state, count in backend.counts().items():
                print(f"{state}={count}")
        elif args.command == "work":
            if args.once:
                queue.run_once(HANDLERS)
            else:
                queue.run_due(HANDLERS)
    finally:
        backend.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
