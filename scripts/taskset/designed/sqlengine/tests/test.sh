#!/bin/bash
# Hidden tests of the designed task, run in the project directory after the agent has finished.
cd /app && PROJECT=/app python3 /tests/run_hidden.py
