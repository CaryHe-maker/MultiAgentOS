"""Durable state: a JSON snapshot plus an append-only log of committed changes (instruction.md 6).

`snapshot.json` holds {"gen": g, "tables": ..., "indexes": ...}; `wal.<g>` holds one JSON line per
commit. A commit is one write of one complete line, so a killed process leaves either the whole
line or a torn last line, which replay ignores. Compaction writes snapshot g+1 through a temporary
file and os.replace, then removes wal.<g>. An exclusive flock serialises processes.
"""

from __future__ import annotations

import fcntl
import json
import os

COMPACT_AFTER = 4000


class Table:
    def __init__(self, name, columns, next_rowid=1, rows=None):
        self.name = name
        self.columns = columns  # list of column dicts (sql.Parser.column_def)
        self.next_rowid = next_rowid
        self.rows = rows if rows is not None else {}  # rowid -> list of values

    def copy(self):
        return Table(self.name, [dict(c) for c in self.columns], self.next_rowid, dict(self.rows))

    def col_index(self, name):
        low = name.lower()
        for i, c in enumerate(self.columns):
            if c["name"].lower() == low:
                return i
        return None


class State:
    def __init__(self):
        self.tables: dict[str, Table] = {}
        self.indexes: dict[str, tuple[str, str]] = {}  # name -> (table key, column name)

    def copy(self):
        s = State()
        s.tables = {k: t.copy() for k, t in self.tables.items()}
        s.indexes = dict(self.indexes)
        return s


def apply(state: State, op: list) -> None:
    kind = op[0]
    if kind == "ins" or kind == "upd":
        t = state.tables[op[1]]
        t.rows[op[2]] = op[3]
        t.next_rowid = max(t.next_rowid, op[2] + 1)
    elif kind == "del":
        del state.tables[op[1]].rows[op[2]]
    elif kind == "create":
        state.tables[op[1]] = Table(op[2]["name"], op[2]["columns"])
    elif kind == "drop":
        del state.tables[op[1]]
        for name in [n for n, (t, _) in state.indexes.items() if t == op[1]]:
            del state.indexes[name]
    elif kind == "addcol":
        t = state.tables[op[1]]
        t.columns.append(op[2])
        default = op[2]["default"]
        for rid in t.rows:
            t.rows[rid] = t.rows[rid] + [default]
    elif kind == "cidx":
        state.indexes[op[1]] = (op[2], op[3])
    elif kind == "didx":
        del state.indexes[op[1]]
    else:
        raise ValueError(kind)


class Store:
    def __init__(self, path: str):
        self.path = path
        os.makedirs(path, exist_ok=True)
        self.lock = open(os.path.join(path, "lock"), "a+")
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        self.state, self.gen, self.records = self._load()
        self.wal = open(self._wal_path(self.gen), "ab")

    def _wal_path(self, gen):
        return os.path.join(self.path, f"wal.{gen}")

    def _load(self):
        state, gen = State(), 0
        snap = os.path.join(self.path, "snapshot.json")
        if os.path.exists(snap):
            with open(snap, encoding="utf-8") as f:
                data = json.load(f)
            gen = data["gen"]
            for key, t in data["tables"].items():
                state.tables[key] = Table(t["name"], t["columns"], t["next_rowid"],
                                          {int(r): v for r, v in t["rows"].items()})
            state.indexes = {k: tuple(v) for k, v in data["indexes"].items()}
        records = 0
        wal = self._wal_path(gen)
        if os.path.exists(wal):
            with open(wal, "rb") as f:
                data = f.read()
            good = 0
            for line in data.split(b"\n"):
                if not line:
                    continue
                try:
                    ops = json.loads(line)
                except ValueError:
                    break  # torn last record
                for op in ops:
                    apply(state, op)
                records += 1
                good += len(line) + 1
            if good < len(data):
                with open(wal, "r+b") as f:
                    f.truncate(good)
        for name in os.listdir(self.path):
            if name.startswith("wal.") and name != f"wal.{gen}":
                os.remove(os.path.join(self.path, name))
        return state, gen, records

    def commit(self, ops: list) -> None:
        if not ops:
            return
        self.wal.write(json.dumps(ops, separators=(",", ":")).encode() + b"\n")
        self.wal.flush()
        self.records += 1

    def close(self) -> None:
        if self.records >= COMPACT_AFTER:
            self._compact()
        self.wal.close()
        self.lock.close()

    def _compact(self) -> None:
        gen = self.gen + 1
        data = {
            "gen": gen,
            "tables": {k: {"name": t.name, "columns": t.columns, "next_rowid": t.next_rowid,
                           "rows": {str(r): v for r, v in t.rows.items()}}
                       for k, t in self.state.tables.items()},
            "indexes": {k: list(v) for k, v in self.state.indexes.items()},
        }
        tmp = os.path.join(self.path, "snapshot.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, os.path.join(self.path, "snapshot.json"))
        self.wal.close()
        os.remove(self._wal_path(self.gen))
        self.gen = gen
        self.wal = open(self._wal_path(gen), "ab")
