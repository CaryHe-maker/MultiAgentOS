#!/bin/bash
# Oracle: a wrapper around gawk --posix (see solution/pyawk/__init__.py).
apt-get update -qq > /dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gawk > /dev/null 2>&1
cp -r /solution/. /app/ && rm -f /app/solve.sh
