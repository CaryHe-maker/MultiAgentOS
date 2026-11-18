"""Shared by lb_dsh_agent.py and pier_dsh_agent.py: the DeepSeek key and the token count of one dsh run.

Model calls go through usage-proxy.mjs (`/r/<runId>/...`), which appends one line per answer to
`<USAGE_DIR>/<runId>.jsonl`; the sums here are the ones agentrun.mjs makes for the small tasks.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

USAGE_DIR = Path(os.environ.get("USAGE_DIR", Path.home() / "bench/usage"))
PROXY_PORT = int(os.environ.get("DSH_PROXY_PORT", "18099"))
NODE_DIR = Path(os.environ.get("DSH_NODE_DIR", Path.home() / ".local/opt/node-v24.19.0-linux-x64"))
DSH_DIR = Path(os.environ.get("DSH_DIR", Path.home() / "dshlab"))


def deepseek_key() -> str:
    """From DEEPSEEK_API_KEY or the file named by MAO_ENV_FILE; never logged."""
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    env_file = os.environ.get("MAO_ENV_FILE")
    if not key and env_file and Path(env_file).is_file():
        for line in Path(env_file).read_text(encoding="utf-8").splitlines():
            if line.startswith("DEEPSEEK_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("\"'")
    if not key:
        raise ValueError("dsh needs DEEPSEEK_API_KEY or MAO_ENV_FILE")
    return key


def usage(run_id: str) -> dict[str, int]:
    total = {"requests": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "failed": 0}
    path = USAGE_DIR / f"{run_id}.jsonl"
    if not path.is_file():
        return total
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if "/messages" not in (entry.get("path") or ""):
            continue
        tokens = entry.get("usage") or {}
        total["requests"] += 1
        total["failed"] += 1 if entry.get("error") or (entry.get("status") or 200) >= 400 else 0
        total["input"] += tokens.get("input_tokens") or 0
        total["output"] += tokens.get("output_tokens") or 0
        total["cacheRead"] += tokens.get("cache_read_input_tokens") or 0
        total["cacheWrite"] += tokens.get("cache_creation_input_tokens") or 0
    return total
