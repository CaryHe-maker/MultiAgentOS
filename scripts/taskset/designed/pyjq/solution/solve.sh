#!/bin/bash
# Oracle: a wrapper around jq 1.7 (see solution/pyjq/__init__.py).
apt-get update -qq > /dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq > /dev/null 2>&1
cp -r /solution/. /app/ && rm -f /app/solve.sh
