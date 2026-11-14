#!/bin/bash
# Oracle: wrappers around GNU tar, GNU gzip and Info-ZIP (see solution/pyarchive/__init__.py).
apt-get update -qq > /dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zip unzip > /dev/null 2>&1
cp -r /solution/. /app/ && rm -f /app/solve.sh
