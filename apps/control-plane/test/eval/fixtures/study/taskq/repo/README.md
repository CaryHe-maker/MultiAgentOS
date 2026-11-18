# taskq

A small persistent job queue: delayed jobs, retries with backoff, and pluggable storage
backends (`memory`, `json`). Python 3.11+, standard library only.

    python3 -m taskq --db jobs.json enqueue echo --payload '{"text": "hi"}'
    python3 -m taskq --db jobs.json work
    python3 -m taskq --db jobs.json stats

Settings can also come from `taskq.toml` (see `taskq/config.py`).

Tests: `python3 -m unittest discover -s tests -t .`
