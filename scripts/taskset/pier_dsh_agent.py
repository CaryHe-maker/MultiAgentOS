"""DeepSeek Harness (dsh) as a Pier agent for DeepSWE, for the dsh control runs (docs/M2/TaskSet.md).

    PYTHONPATH=<this dir> pier run -p <task> --agent-import-path pier_dsh_agent:DshAgent --ak cap_sec=9000

``setup`` copies Node and dsh from the host into the task container; ``run`` starts
``dsh --profile headless`` once in the task's workdir with the task's instruction (which asks for a
commit; Pier's verifier collects ``git diff <base> HEAD``). The agent runs without network except for
Pier's egress allowlist, which lets through only ``host.docker.internal`` on ports 80 and 443: there
usage-proxy.mjs (published on port 80) counts the tokens the same way as for the small tasks and forwards to the
DeepSeek API. ``cap_sec`` stops dsh inside the container, so nothing keeps writing after the cap.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from dsh_usage import DSH_DIR, NODE_DIR, deepseek_key, usage
from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist

_NODE_IN = "/opt/dshnode"
_DSH_IN = "/opt/dsh"
_PROXY_HOST = "host.docker.internal"


class DshAgent(BaseAgent):
    def __init__(self, *args, cap_sec: int | str = 9000, **kwargs):
        super().__init__(*args, **kwargs)
        self._key = deepseek_key()
        self._cap = int(cap_sec)

    @staticmethod
    def name() -> str:
        return "dsh"

    def version(self) -> str | None:
        return None

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=[_PROXY_HOST])

    async def setup(self, environment: BaseEnvironment) -> None:
        await environment.exec(f"mkdir -p {_NODE_IN} {_DSH_IN}/node_modules", user="root")
        await environment.upload_dir(NODE_DIR, _NODE_IN)
        await environment.upload_dir(DSH_DIR / "node_modules", f"{_DSH_IN}/node_modules")
        check = await environment.exec(f"{_NODE_IN}/bin/node {_DSH_IN}/node_modules/.bin/dsh --version")
        if check.return_code != 0:
            raise RuntimeError("dsh does not start in the task container")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "instruction.txt").write_text(instruction, encoding="utf-8")
        run_id = f"pierdsh-{int(time.time() * 1000) % 10**10}"
        env = environment.agent_process_env(
            {
                "DEEPSEEK_API_KEY": self._key,
                "DSH_HOME": "/tmp/dshhome",
                "DEEPSEEK_BASE_URL": f"http://{_PROXY_HOST}/r/{run_id}",
                # Node's fetch uses HTTP(S)_PROXY, set by Pier for the egress allowlist, only when asked to
                "NODE_USE_ENV_PROXY": "1",
            }
        )
        await environment.upload_file(self.logs_dir / "instruction.txt", "/tmp/dsh-instruction.md")
        await environment.exec("chmod 644 /tmp/dsh-instruction.md", user="root")
        # the container is the sandbox; the same freedom as in agentrun.mjs
        command = (
            f"timeout -k 30 {self._cap} {_NODE_IN}/bin/node {_DSH_IN}/node_modules/.bin/dsh"
            ' --profile headless --permission-mode danger-full-access "$(cat /tmp/dsh-instruction.md)"'
        )
        started = time.monotonic()
        result = None
        try:
            result = await environment.exec(command, env=env, timeout_sec=self._cap + 120)
        finally:
            tokens = usage(run_id)
            context.n_input_tokens = tokens["input"] + tokens["cacheRead"] + tokens["cacheWrite"]
            context.n_cache_tokens = tokens["cacheRead"]
            context.n_output_tokens = tokens["output"]
            summary = {
                "runId": run_id,
                "seconds": round(time.monotonic() - started, 1),
                "exitCode": None if result is None else result.return_code,
                "timedOut": result is not None and result.return_code == 124,
                "usage": tokens,
            }
            context.metadata = {"dsh": summary}
            (self.logs_dir / "dsh-usage.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
            if result is not None:
                (self.logs_dir / "dsh.stdout.txt").write_text(result.stdout or "", encoding="utf-8")
                (self.logs_dir / "dsh.stderr.txt").write_text(result.stderr or "", encoding="utf-8")
