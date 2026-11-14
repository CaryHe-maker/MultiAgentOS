"""DeepSeek Harness (dsh) as a LoopsBench agent, for the phase 3 control runs (docs/M2/Phase3Plan.md).

    PYTHONPATH=<this dir> loopsbench run -p tasks -t <task> --agent-import-path lb_dsh_agent:DshAgent

Node and dsh are copied from the host into the client container once (``install``); every round runs
``dsh --profile headless`` with the harness's instruction in the container's workspace. Model calls go
through usage-proxy.mjs, published on the host at port 18099 and reached through the Docker gateway
(the harness allows the gateway during solving), so tokens are counted the same way as for the small
tasks run by agentrun.mjs. The key comes from DEEPSEEK_API_KEY or the file named by MAO_ENV_FILE; it
is passed through the Docker API environment and never written to a log.
"""

from __future__ import annotations

import ipaddress
import json
import subprocess
import threading
import time
from pathlib import Path

from dsh_usage import DSH_DIR, NODE_DIR, PROXY_PORT, deepseek_key, usage
from loopsbench.agents.base_agent import AgentResult, BaseAgent
from loopsbench.harness.models import FailureMode
from loopsbench.terminal.tmux_session import TmuxSession

_NODE_IN = "/opt/dshnode"
_DSH_IN = "/opt/dsh"


class DshAgent(BaseAgent):
    def __init__(self, model_name: str | None = None, **kwargs):
        super().__init__(**kwargs)
        self._key = deepseek_key()

    @staticmethod
    def name() -> str:
        return "dsh"

    def get_trajectory_paths(self) -> list[str]:
        return []

    @property
    def model_uses_host_gateway(self) -> bool:
        return True

    @staticmethod
    def _gateway(session: TmuxSession) -> str:
        # The same lookup as the Codex adapter: the address comes from Docker, not from the workspace.
        container = session._container
        manager = getattr(session, "_network_controller", None)
        if manager is not None:
            controller = manager._network_controllers.get("client")
            if controller:
                container = manager._service_container(controller)
        elif container.attrs.get("HostConfig", {}).get("NetworkMode", "").startswith("container:"):
            owner = container.attrs["HostConfig"]["NetworkMode"].split(":", 1)[1]
            container = container.client.containers.get(owner)
        networks = container.attrs.get("NetworkSettings", {}).get("Networks", {}) if container else {}
        for network in networks.values():
            if network.get("Gateway"):
                return str(ipaddress.ip_address(network["Gateway"]))
        raise RuntimeError("Cannot resolve the Docker gateway for the usage proxy")

    def install(self, session: TmuxSession, logging_dir: Path | None = None) -> None:
        container = session._container
        container.exec_run(["mkdir", "-p", _DSH_IN])
        # docker cp streams from disk; the bundle (~1.1 GB) is too large for an in-memory put_archive.
        for src, dest in ((NODE_DIR, _NODE_IN), (DSH_DIR / "node_modules", f"{_DSH_IN}/node_modules")):
            subprocess.run(["docker", "cp", f"{src}", f"{container.id}:{dest}"], check=True, capture_output=True)
        check = container.exec_run([f"{_NODE_IN}/bin/node", f"{_DSH_IN}/node_modules/.bin/dsh", "--version"])
        if check.exit_code != 0:
            raise RuntimeError("dsh does not start in the client container")

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
        timeout_sec: float | None = None,
    ) -> AgentResult:
        container = session._container
        logging_dir = logging_dir or Path(".")
        logging_dir.mkdir(parents=True, exist_ok=True)
        (logging_dir / "instruction.txt").write_text(instruction, encoding="utf-8")
        run_id = f"lbdsh-{int(time.time() * 1000) % 10**10}"
        workdir = "/workspace" if container.exec_run(["test", "-d", "/workspace"]).exit_code == 0 else None
        workdir = workdir or container.attrs.get("Config", {}).get("WorkingDir") or "/"
        env = [
            f"DEEPSEEK_API_KEY={self._key}",
            "DSH_HOME=/tmp/dshhome",
            f"DEEPSEEK_BASE_URL=http://{self._gateway(session)}:{PROXY_PORT}/r/{run_id}",
        ]
        argv = [
            f"{_NODE_IN}/bin/node",
            f"{_DSH_IN}/node_modules/.bin/dsh",
            "--profile",
            "headless",
            # the container is the sandbox; the same freedom as in agentrun.mjs
            "--permission-mode",
            "danger-full-access",
            instruction,
        ]
        api = container.client.api
        exec_id = api.exec_create(container.id, argv, stdout=True, stderr=True, environment=env, workdir=workdir)["Id"]
        started = time.monotonic()
        with open(logging_dir / "dsh.stdout.txt", "w", encoding="utf-8") as out, open(
            logging_dir / "dsh.stderr.txt", "w", encoding="utf-8"
        ) as err:
            stream = api.exec_start(exec_id, demux=True, stream=True)

            def pump() -> None:
                for chunk in stream:
                    if not chunk:
                        continue
                    o, e = chunk
                    if o:
                        out.write(o.decode("utf-8", errors="replace"))
                        out.flush()
                    if e:
                        err.write(e.decode("utf-8", errors="replace"))
                        err.flush()

            # headless dsh may stay silent for a long time, so the deadline is kept by a join, not by output
            reader = threading.Thread(target=pump, daemon=True)
            reader.start()
            reader.join(float(timeout_sec or 86400.0))
            timed_out = reader.is_alive()
            if timed_out:
                # The next round must not share the workspace with a dsh that is still running; images
                # may lack pkill, so the processes are found through /proc.
                container.exec_run(
                    [
                        "sh",
                        "-c",
                        # the bracket keeps this shell's own command line from matching
                        "for p in /proc/[0-9]*; do grep -q '/opt/ds[h]/node_modules' $p/cmdline 2>/dev/null"
                        " && kill -9 ${p#/proc/}; done",
                    ]
                )
                reader.join(30)
                close = getattr(stream, "close", None)
                if callable(close):
                    close()
        exit_code = None if timed_out else api.exec_inspect(exec_id).get("ExitCode")
        tokens = usage(run_id)
        summary = {
            "runId": run_id,
            "seconds": round(time.monotonic() - started, 1),
            "timedOut": timed_out,
            "exitCode": exit_code,
            "usage": tokens,
        }
        (logging_dir / "dsh-usage.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
        return AgentResult(
            # Anthropic-style input excludes cache reads; the total here includes them, like mas.
            total_input_tokens=tokens["input"] + tokens["cacheRead"] + tokens["cacheWrite"],
            total_output_tokens=tokens["output"],
            failure_mode=(FailureMode.AGENT_TIMEOUT if timed_out else FailureMode.NONE).value,
        )
