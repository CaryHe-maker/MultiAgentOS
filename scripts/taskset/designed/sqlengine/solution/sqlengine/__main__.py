"""Oracle of the sqlengine task: executes the script with Python's sqlite3, which the task forbids. It
validates the hidden tests and fails, by design, the check that forbids the sqlite3 module."""

import os
import sqlite3
import sys


def fmt(v):
    if v is None:
        return "NULL"
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, bytes):
        return "x'" + v.hex() + "'"
    return str(v)


def statements(text):
    buf = ""
    for part in text.split(";"):
        buf += part + ";"
        if sqlite3.complete_statement(buf):
            if buf.strip(" \n\t;"):
                yield buf
            buf = ""


os.makedirs(sys.argv[1], exist_ok=True)
db = sqlite3.connect(os.path.join(sys.argv[1], "db.sqlite"), isolation_level=None)
out = sys.stdout
for stmt in statements(sys.stdin.read()):
    try:
        rows = db.execute(stmt).fetchall()
    except sqlite3.Error:
        out.write("error\n")
        continue
    for r in rows:
        out.write("|".join(fmt(v) for v in r) + "\n")
if db.in_transaction:
    db.rollback()
db.close()
