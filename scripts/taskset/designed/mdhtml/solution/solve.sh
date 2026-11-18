#!/bin/bash
# Oracle: a wrapper around cmark 0.30 --unsafe (see solution/mdhtml/__init__.py).
apt-get update -qq > /dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cmark > /dev/null 2>&1
cp -r /solution/. /app/ && rm -f /app/solve.sh
