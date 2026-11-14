#!/bin/bash
# Oracle: a wrapper around lua5.4 (see solution/pylua/__init__.py).
apt-get update -qq > /dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq lua5.4 > /dev/null 2>&1
cp -r /solution/. /app/ && rm -f /app/solve.sh
