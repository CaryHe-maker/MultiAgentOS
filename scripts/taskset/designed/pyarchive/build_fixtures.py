"""Builds tests/fixtures of the pyarchive task inside the task image with Info-ZIP zip/unzip installed: zip
archives made by Info-ZIP (deflate at two levels, stored, streamed from stdin with a data descriptor, with
directories and modes) and the expected `unzip -l` listings (TZ=UTC). GNU tar and gzip are part of the base
image, so the hidden tests compare with them directly.
Usage (in the container): python3 build_fixtures.py <tests dir>
"""

import json
import os
import random
import shutil
import stat
import subprocess
import sys

out = os.path.join(sys.argv[1], "fixtures")
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
work = "/tmp/zipwork"
shutil.rmtree(work, ignore_errors=True)
os.makedirs(os.path.join(work, "proj", "src", "deep"))
rng = random.Random(7)
words = ["alpha", "beta", "gamma", "delta", "epsilon", "zip", "archive", "deflate", "huffman", "lz77"]
files = {
    "proj/README.txt": "".join(" ".join(rng.choice(words) for _ in range(12)) + "\n" for _ in range(400)),
    "proj/src/main.py": "print('hello')\n" * 50,
    "proj/src/deep/data.bin": bytes(rng.randrange(256) for _ in range(5000)),
    "proj/src/deep/zeros.bin": bytes(20000),
    "proj/empty.txt": "",
    "proj/run.sh": "#!/bin/sh\necho run\n",
}
for name, data in files.items():
    path = os.path.join(work, name)
    with open(path, "wb") as f:
        f.write(data.encode() if isinstance(data, str) else data)
    os.utime(path, (1700000000, 1700000000))
os.chmod(os.path.join(work, "proj/run.sh"), 0o755)
os.chmod(os.path.join(work, "proj/README.txt"), 0o600)
for d in ("proj/src/deep", "proj/src", "proj"):
    os.utime(os.path.join(work, d), (1700000000, 1700000000))
env = {"PATH": "/usr/bin:/bin", "TZ": "UTC", "LC_ALL": "C"}


def sh(args, **kw):
    return subprocess.run(args, cwd=work, env=env, capture_output=True, check=True, **kw)


sh(["zip", "-q", "-r", "-9", os.path.join(out, "deflate9.zip"), "proj"])
sh(["zip", "-q", "-r", "-1", os.path.join(out, "deflate1.zip"), "proj"])
sh(["zip", "-q", "-r", "-0", os.path.join(out, "stored.zip"), "proj"])
with open(os.path.join(work, "proj/README.txt"), "rb") as f:
    sh(["zip", "-q", os.path.join(out, "stream.zip"), "-"], stdin=f)
listings = {}
for z in ("deflate9.zip", "deflate1.zip", "stored.zip", "stream.zip"):
    listings[z] = subprocess.run(["unzip", "-l", os.path.join(out, z)], env=env, capture_output=True, text=True,
                                 check=True).stdout.replace(out + "/", "")
json.dump({"unzip_l": listings, "zip": sh(["zip", "-v"]).stdout.decode().splitlines()[1].strip(),
           "modes": {os.path.relpath(k, "proj"): stat.S_IMODE(os.stat(os.path.join(work, k)).st_mode) for k in files}},
          open(os.path.join(out, "expected.json"), "w"), indent=1)
shutil.copytree(os.path.join(work, "proj"), os.path.join(out, "proj"), symlinks=True)
print(sorted(os.listdir(out)))
