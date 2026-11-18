"""Oracle of the mdhtml task: delegates to the reference implementation `cmark --unsafe` 0.30, which
solve.sh installs. It validates the hidden tests and fails, by design, the check that forbids
external programs."""

import subprocess


def to_html(text: str) -> str:
    return subprocess.run(["/usr/bin/cmark", "--unsafe"], input=text.encode("utf-8"), capture_output=True,
                          check=True).stdout.decode("utf-8")
