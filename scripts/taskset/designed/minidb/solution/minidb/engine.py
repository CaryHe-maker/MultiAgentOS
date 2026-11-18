"""Statement execution and expression evaluation (instruction.md sections 1, 3-5)."""

from __future__ import annotations

import math
import re
from decimal import ROUND_HALF_UP, Decimal

from .sql import Parser, SqlError, split_statements
from .storage import State, Store, apply

_UPPER = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def fmt(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, float):
        return repr(v)
    return str(v)


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def truth(v):
    if v is None:
        return None
    if isinstance(v, str):
        raise SqlError("text used as a condition")
    return v != 0


def compare(a, b):
    """-1/0/1 under the comparison rules; numbers vs text is an error."""
    if is_num(a) and is_num(b) or isinstance(a, str) and isinstance(b, str):
        return (a > b) - (a < b)
    raise SqlError("cannot compare a number with text")


def sort_key(v):
    if v is None:
        return (0, 0)
    if is_num(v):
        return (1, v)
    return (2, v)


def group_key(v):
    # GROUP BY and DISTINCT treat NULLs as equal and 1 = 1.0.
    return ("n", None) if v is None else (("v", v) if is_num(v) else ("s", v))


def contains_agg(e) -> bool:
    if not isinstance(e, tuple):
        return False
    if e[0] == "agg":
        return True
    return any(contains_agg(x) for x in _children(e))


def _children(e):
    kind = e[0]
    if kind in ("lit", "col", "pos", "gref", "out"):
        return []
    if kind == "agg":
        return [e[2]] if e[2] is not None else []
    if kind == "fn":
        return list(e[2])
    if kind == "case":
        out = []
        for c, r in e[1]:
            out += [c, r]
        return out + ([e[2]] if e[2] is not None else [])
    if kind == "in":
        return [e[1]] + list(e[2])
    if kind == "between":
        return [e[1], e[2], e[3]]
    if kind in ("cmp", "bin"):
        return [e[2], e[3]]
    if kind in ("and", "or"):
        return [e[1], e[2]]
    if kind in ("not", "neg", "isnull", "like"):
        return [x for x in e[1:] if isinstance(x, tuple)]
    raise SqlError("bad expression")


class Scope:
    """The tables of a FROM clause: (alias, table) pairs and their offsets in the joined row."""

    def __init__(self, entries):
        self.entries = []
        off = 0
        for alias, table in entries:
            self.entries.append((alias.lower(), table, off))
            off += len(table.columns)
        self.width = off

    def resolve(self, qual, name):
        hits = []
        for alias, table, off in self.entries:
            if qual is not None and alias != qual:
                continue
            i = table.col_index(name)
            if i is not None:
                hits.append(off + i)
        if qual is not None and not any(a == qual for a, _, _ in self.entries):
            raise SqlError(f"no such table: {qual}")
        if not hits:
            raise SqlError(f"no such column: {name}")
        if len(hits) > 1:
            raise SqlError(f"ambiguous column: {name}")
        return hits[0]


class Evaluator:
    def __init__(self, scope: Scope | None):
        self.scope = scope

    def bind(self, e):
        """Replaces column references by row positions; raises for unknown columns."""
        kind = e[0]
        if kind == "col":
            if self.scope is None:
                raise SqlError(f"no such column: {e[2]}")
            return ("pos", self.scope.resolve(e[1], e[2]))
        if kind == "lit":
            return e
        if kind == "agg":
            return ("agg", e[1], self.bind(e[2]) if e[2] is not None else None, e[3])
        if kind == "fn":
            return ("fn", e[1], [self.bind(a) for a in e[2]])
        if kind == "case":
            return ("case", [(self.bind(c), self.bind(r)) for c, r in e[1]],
                    self.bind(e[2]) if e[2] is not None else None)
        if kind == "in":
            return ("in", self.bind(e[1]), [self.bind(x) for x in e[2]], e[3])
        if kind == "between":
            return ("between", self.bind(e[1]), self.bind(e[2]), self.bind(e[3]), e[4])
        if kind in ("cmp", "bin"):
            return (kind, e[1], self.bind(e[2]), self.bind(e[3]))
        if kind in ("and", "or"):
            return (kind, self.bind(e[1]), self.bind(e[2]))
        if kind in ("not", "neg"):
            return (kind, self.bind(e[1]))
        if kind == "isnull":
            return ("isnull", self.bind(e[1]), e[2])
        if kind == "like":
            return ("like", self.bind(e[1]), self.bind(e[2]), e[3])
        raise SqlError("bad expression")


def ev(e, row, aggs=None):
    """Evaluates a bound expression. `aggs` maps id(agg node) -> value inside grouped evaluation."""
    kind = e[0]
    if kind == "lit":
        return e[1]
    if kind == "pos":
        return row[e[1]]
    if kind == "agg":
        if aggs is None:
            raise SqlError("misuse of aggregate function")
        return aggs[id(e)]
    if kind == "grp":
        return e[1]
    if kind == "bin":
        a, b = ev(e[2], row, aggs), ev(e[3], row, aggs)
        op = e[1]
        if op == "||":
            return None if a is None or b is None else fmt(a) + fmt(b)
        if a is None or b is None:
            return None
        if not is_num(a) or not is_num(b):
            raise SqlError("text in arithmetic")
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if b == 0:
            return None
        if isinstance(a, int) and isinstance(b, int):
            q = abs(a) // abs(b)
            q = q if (a >= 0) == (b >= 0) else -q
            return q if op == "/" else a - b * q
        return a / b if op == "/" else math.fmod(a, b)
    if kind == "neg":
        a = ev(e[1], row, aggs)
        if a is None:
            return None
        if not is_num(a):
            raise SqlError("text in arithmetic")
        return -a
    if kind == "cmp":
        a, b = ev(e[2], row, aggs), ev(e[3], row, aggs)
        if a is None or b is None:
            return None
        c = compare(a, b)
        op = e[1]
        r = {"=": c == 0, "!=": c != 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0}[op]
        return int(r)
    if kind == "and":
        a = truth(ev(e[1], row, aggs))
        if a is False:
            return 0
        b = truth(ev(e[2], row, aggs))
        if b is False:
            return 0
        return None if a is None or b is None else 1
    if kind == "or":
        a = truth(ev(e[1], row, aggs))
        if a is True:
            return 1
        b = truth(ev(e[2], row, aggs))
        if b is True:
            return 1
        return None if a is None or b is None else 0
    if kind == "not":
        a = truth(ev(e[1], row, aggs))
        return None if a is None else int(not a)
    if kind == "isnull":
        a = ev(e[1], row, aggs)
        return int((a is None) != e[2])
    if kind == "like":
        a, p = ev(e[1], row, aggs), ev(e[2], row, aggs)
        if a is None or p is None:
            return None
        if not isinstance(a, str) or not isinstance(p, str):
            raise SqlError("LIKE needs text")
        rx = "".join(".*" if ch == "%" else "." if ch == "_" else re.escape(ch) for ch in p)
        r = re.fullmatch(rx, a, re.IGNORECASE | re.ASCII | re.DOTALL) is not None
        return int(r != e[3])
    if kind == "in":
        a = ev(e[1], row, aggs)
        vals = [ev(x, row, aggs) for x in e[2]]
        if a is None:
            return None
        saw_null = False
        for v in vals:
            if v is None:
                saw_null = True
            elif compare(a, v) == 0:
                return int(not e[3])
        return None if saw_null else int(e[3])
    if kind == "between":
        a, lo, hi = (ev(x, row, aggs) for x in e[1:4])
        ge = None if a is None or lo is None else compare(a, lo) >= 0
        le = None if a is None or hi is None else compare(a, hi) <= 0
        if ge is False or le is False:
            r = 0
        elif ge is None or le is None:
            return None
        else:
            r = 1
        return int(not r) if e[4] else r
    if kind == "case":
        for c, r in e[1]:
            if truth(ev(c, row, aggs)) is True:
                return ev(r, row, aggs)
        return ev(e[2], row, aggs) if e[2] is not None else None
    if kind == "fn":
        return call(e[1], [ev(a, row, aggs) for a in e[2]])
    raise SqlError("bad expression")


def call(fn, args):
    if fn == "COALESCE":
        return next((a for a in args if a is not None), None)
    if any(a is None for a in args):
        return None
    if fn in ("LENGTH", "UPPER", "LOWER"):
        if not isinstance(args[0], str):
            raise SqlError(f"{fn} needs text")
        s = args[0]
        return len(s) if fn == "LENGTH" else s.translate(_UPPER if fn == "UPPER" else _LOWER)
    if fn == "ABS":
        if not is_num(args[0]):
            raise SqlError("ABS needs a number")
        return abs(args[0])
    if fn == "ROUND":
        x = args[0]
        n = args[1] if len(args) > 1 else 0
        if not is_num(x) or not isinstance(n, int):
            raise SqlError("ROUND needs a number and an integer")
        q = Decimal(repr(float(x)) if isinstance(x, float) else x)
        return float(q.quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP))
    if fn == "SUBSTR":
        s, start = args[0], args[1]
        if not isinstance(s, str) or not isinstance(start, int):
            raise SqlError("SUBSTR needs text and integers")
        if len(args) == 3 and not isinstance(args[2], int):
            raise SqlError("SUBSTR needs text and integers")
        if start < 1:
            return ""
        end = len(s) if len(args) == 2 else start - 1 + max(args[2], 0)
        return s[start - 1 : end]
    raise SqlError(f"no such function: {fn}")


def aggregate(fn, values, distinct):
    if fn == "COUNT":
        vals = [v for v in values if v is not None]
        if distinct:
            vals = list({group_key(v): v for v in vals}.values())
        return len(vals)
    vals = [v for v in values if v is not None]
    if fn in ("SUM", "AVG"):
        if any(not is_num(v) for v in vals):
            raise SqlError(f"{fn} needs numbers")
        if not vals:
            return None
        if fn == "AVG":
            return float(sum(vals)) / len(vals)
        return sum(vals) if all(isinstance(v, int) for v in vals) else float(sum(vals))
    if not vals:
        return None
    best = vals[0]
    for v in vals[1:]:
        c = compare(v, best)
        if (fn == "MIN" and c < 0) or (fn == "MAX" and c > 0):
            best = v
    return best


class Database:
    def __init__(self, path):
        self.store = Store(path)
        self.state: State = self.store.state
        self.tx: State | None = None  # snapshot at BEGIN
        self.tx_ops: list = []
        self.out: list[str] = []

    # -- running scripts --
    def run(self, text) -> int:
        import sys

        code = 0
        try:
            for stmt_text in split_statements(text):
                try:
                    stmt = Parser(stmt_text).statement()
                    self.execute(stmt)
                except SqlError as exc:
                    if self.tx is not None:
                        self.state = self.store.state = self.tx
                        self.tx, self.tx_ops = None, []
                    sys.stdout.write("".join(line + "\n" for line in self.out))
                    self.out = []
                    sys.stderr.write(f"error: {exc}\n")
                    code = 1
                    break
                sys.stdout.write("".join(line + "\n" for line in self.out))
                self.out = []
            if self.tx is not None:
                self.state = self.store.state = self.tx
                self.tx, self.tx_ops = None, []
        finally:
            self.store.close()
        return code

    def commit(self, ops):
        for op in ops:
            apply(self.state, op)
        if self.tx is not None:
            self.tx_ops += ops
        else:
            self.store.commit(ops)

    def table(self, name):
        t = self.state.tables.get(name.lower())
        if t is None:
            raise SqlError(f"no such table: {name}")
        return t

    # -- statements --
    def execute(self, s):
        kind = s[0]
        getattr(self, "do_" + kind)(*s[1:])

    def do_begin(self):
        if self.tx is not None:
            raise SqlError("already in a transaction")
        self.tx, self.tx_ops = self.state.copy(), []

    def do_commit(self):
        if self.tx is None:
            raise SqlError("no transaction")
        self.store.commit(self.tx_ops)
        self.tx, self.tx_ops = None, []

    def do_rollback(self):
        if self.tx is None:
            raise SqlError("no transaction")
        self.state = self.store.state = self.tx
        self.tx, self.tx_ops = None, []

    def check_type(self, col, v):
        if v is None:
            return None
        t = col["type"]
        if t == "INTEGER" and isinstance(v, int):
            return v
        if t == "REAL" and is_num(v):
            return float(v)
        if t == "TEXT" and isinstance(v, str):
            return v
        raise SqlError(f"type mismatch for column {col['name']}")

    def do_create_table(self, name, cols, if_not_exists):
        key = name.lower()
        if key in self.state.tables:
            if if_not_exists:
                return
            raise SqlError(f"table {name} already exists")
        seen = set()
        for c in cols:
            if c["name"].lower() in seen:
                raise SqlError(f"duplicate column {c['name']}")
            seen.add(c["name"].lower())
            c["default"] = self.check_type(c, c["default"])
        if sum(c["pk"] for c in cols) > 1:
            raise SqlError("more than one PRIMARY KEY")
        self.commit([["create", key, {"name": name, "columns": cols}]])

    def do_drop_table(self, name, if_exists):
        key = name.lower()
        if key not in self.state.tables:
            if if_exists:
                return
            raise SqlError(f"no such table: {name}")
        self.commit([["drop", key]])

    def do_add_column(self, name, col):
        t = self.table(name)
        if t.col_index(col["name"]) is not None:
            raise SqlError(f"duplicate column {col['name']}")
        if col["pk"] or col["unique"] or (col["notnull"] and col["default"] is None):
            raise SqlError("cannot add this column")
        col["default"] = self.check_type(col, col["default"])
        self.commit([["addcol", name.lower(), col]])

    def do_create_index(self, name, table, col):
        t = self.table(table)
        if name.lower() in self.state.indexes:
            raise SqlError(f"index {name} already exists")
        if t.col_index(col) is None:
            raise SqlError(f"no such column: {col}")
        self.commit([["cidx", name.lower(), table.lower(), col.lower()]])

    def do_drop_index(self, name):
        if name.lower() not in self.state.indexes:
            raise SqlError(f"no such index: {name}")
        self.commit([["didx", name.lower()]])

    def check_rows(self, t, rows: dict):
        """Checks NOT NULL and UNIQUE over the whole table after a change."""
        for i, c in enumerate(t.columns):
            if c["notnull"] and any(r[i] is None for r in rows.values()):
                raise SqlError(f"NOT NULL constraint failed: {c['name']}")
            if c["unique"]:
                seen = set()
                for r in rows.values():
                    v = r[i]
                    if v is None:
                        continue
                    if v in seen:
                        raise SqlError(f"UNIQUE constraint failed: {c['name']}")
                    seen.add(v)

    def do_insert(self, name, cols, rows):
        t = self.table(name)
        if cols is None:
            idx = list(range(len(t.columns)))
        else:
            idx = []
            for c in cols:
                i = t.col_index(c)
                if i is None:
                    raise SqlError(f"no such column: {c}")
                if i in idx:
                    raise SqlError(f"duplicate column {c}")
                idx.append(i)
        e = Evaluator(None)
        new = []
        for values in rows:
            if len(values) != len(idx):
                raise SqlError("wrong number of values")
            row = [c["default"] for c in t.columns]
            for i, v in zip(idx, values):
                row[i] = self.check_type(t.columns[i], ev(e.bind(v), []))
            new.append(row)
        merged = dict(t.rows)
        ops = []
        rid = t.next_rowid
        for row in new:
            merged[rid] = row
            ops.append(["ins", name.lower(), rid, row])
            rid += 1
        self.check_rows(t, merged)
        self.commit(ops)
        self.out.append(f"inserted {len(new)}")

    def matching(self, t, where):
        scope = Scope([(t.name, t)])
        cond = Evaluator(scope).bind(where) if where is not None else None
        if cond is not None and contains_agg(cond):
            raise SqlError("misuse of aggregate function")
        return scope, [(rid, r) for rid, r in t.rows.items() if cond is None or truth(ev(cond, r)) is True]

    def do_update(self, name, sets, where):
        t = self.table(name)
        scope, hits = self.matching(t, where)
        e = Evaluator(scope)
        bound = []
        for col, expr in sets:
            i = t.col_index(col)
            if i is None:
                raise SqlError(f"no such column: {col}")
            if any(i == j for j, _ in bound):
                raise SqlError(f"duplicate column {col}")
            b = e.bind(expr)
            if contains_agg(b):
                raise SqlError("misuse of aggregate function")
            bound.append((i, b))
        merged = dict(t.rows)
        ops = []
        for rid, r in hits:
            nr = list(r)
            for i, b in bound:
                nr[i] = self.check_type(t.columns[i], ev(b, r))
            merged[rid] = nr
            ops.append(["upd", name.lower(), rid, nr])
        self.check_rows(t, merged)
        self.commit(ops)
        self.out.append(f"updated {len(hits)}")

    def do_delete(self, name, where):
        t = self.table(name)
        _, hits = self.matching(t, where)
        self.commit([["del", name.lower(), rid] for rid, _ in hits])
        self.out.append(f"deleted {len(hits)}")

    # -- SELECT --
    def do_select(self, distinct, items, source, joins, where, group, having, order, limit, offset):
        self.out.extend(self.select(distinct, items, source, joins, where, group, having, order, limit, offset))

    def indexed_rows(self, t, alias, where):
        """Fast path: WHERE <indexed column> = <literal> on a single table."""
        if where is None or where[0] != "cmp" or where[1] != "=":
            return None
        a, b = where[2], where[3]
        if a[0] == "lit":
            a, b = b, a
        if a[0] != "col" or b[0] != "lit" or (a[1] is not None and a[1] != alias.lower()):
            return None
        cols = {c for (tk, c) in self.state.indexes.values() if tk == t.name.lower()}
        if a[2] not in cols:
            return None
        i = t.col_index(a[2])
        v = b[1]
        if v is None:
            return []
        if (is_num(v)) != (t.columns[i]["type"] != "TEXT"):
            return None  # let the normal path raise the type error
        return [r for r in t.rows.values() if r[i] is not None and compare(r[i], v) == 0]

    def select(self, distinct, items, source, joins, where, group, having, order, limit, offset):
        entries = []
        if source is not None:
            entries.append((source[1], self.table(source[0])))
            for _, ref, _ in joins:
                entries.append((ref[1], self.table(ref[0])))
            aliases = [a.lower() for a, _ in entries]
            if len(set(aliases)) != len(aliases):
                raise SqlError("duplicate table alias")
        scope = Scope(entries) if entries else None
        e = Evaluator(scope)

        # rows of FROM and JOIN
        if scope is None:
            rows = [[]]
        else:
            first = entries[0][1]
            fast = self.indexed_rows(first, entries[0][0], where) if not joins else None
            rows = fast if fast is not None else [list(r) for r in first.rows.values()]
            for (left, ref, on), (_, table) in zip(joins, entries[1:]):
                width = len(table.columns)
                partial = Scope(entries[: entries.index((ref[1], table)) + 1])
                cond = Evaluator(partial).bind(on)
                if contains_agg(cond):
                    raise SqlError("misuse of aggregate function")
                joined = []
                for r in rows:
                    hit = False
                    for r2 in table.rows.values():
                        cand = r + r2
                        if truth(ev(cond, cand)) is True:
                            joined.append(cand)
                            hit = True
                    if left and not hit:
                        joined.append(r + [None] * width)
                rows = joined
        if where is not None:
            cond = e.bind(where)
            if contains_agg(cond):
                raise SqlError("misuse of aggregate function")
            rows = [r for r in rows if truth(ev(cond, r)) is True]

        # select items
        headers, exprs = [], []
        for k, item in enumerate(items, start=1):
            if item[0] == "star":
                if scope is None:
                    raise SqlError("no tables for *")
                found = False
                for alias, table, off in scope.entries:
                    if item[1] is None or alias == item[1].lower():
                        found = True
                        for i, c in enumerate(table.columns):
                            headers.append(c["name"])
                            exprs.append(("pos", off + i))
                if not found:
                    raise SqlError(f"no such table: {item[1]}")
            else:
                _, ex, alias = item
                if alias:
                    headers.append(alias)
                elif ex[0] == "col":
                    alias_tab = scope.entries if scope else []
                    pos = scope.resolve(ex[1], ex[2]) if scope else None
                    name = ex[2]
                    for _, table, off in alias_tab:
                        if off <= pos < off + len(table.columns):
                            name = table.columns[pos - off]["name"]
                    headers.append(name)
                else:
                    headers.append(f"expr{k}")
                exprs.append(e.bind(ex))
        alias_names = {}
        col = 0
        for item in items:
            if item[0] == "star":
                for alias, table, off in scope.entries:
                    if item[1] is None or alias == item[1].lower():
                        col += len(table.columns)
            else:
                if item[2]:
                    alias_names.setdefault(item[2].lower(), col)
                col += 1

        order_bound = []
        for oe, desc in order:
            if oe[0] == "lit" and isinstance(oe[1], int):
                if not 1 <= oe[1] <= len(exprs):
                    raise SqlError("ORDER BY position out of range")
                order_bound.append((("out", oe[1] - 1), desc))
            elif oe[0] == "col" and oe[1] is None and oe[2] in alias_names:
                order_bound.append((("out", alias_names[oe[2]]), desc))
            else:
                order_bound.append((e.bind(oe), desc))
        having_b = e.bind(having) if having is not None else None
        group_b = [e.bind(g) for g in group]
        for g in group_b:
            if contains_agg(g):
                raise SqlError("misuse of aggregate function")

        grouped = bool(group_b) or having_b is not None or any(contains_agg(x) for x in exprs) or any(
            contains_agg(x) for x, _ in order_bound if x[0] != "out")
        results = []  # (output values, order values)
        if grouped:
            exprs_g = [self.group_expr(x, group_b) for x in exprs]
            having_g = self.group_expr(having_b, group_b) if having_b is not None else None
            order_g = [(x if x[0] == "out" else self.group_expr(x, group_b), d) for x, d in order_bound]
            groups: dict = {}
            for r in rows:
                key = tuple(group_key(ev(g, r)) for g in group_b)
                groups.setdefault(key, []).append(r)
            if not group_b and not groups:
                groups[()] = []
            for members in groups.values():
                gvals = [ev(g, members[0]) for g in group_b] if members else []
                aggs = {}
                for node in self.agg_nodes(exprs_g + ([having_g] if having_g else []) +
                                           [x for x, _ in order_g if x[0] != "out"]):
                    vals = [None] * len(members) if node[2] is None else [ev(node[2], m) for m in members]
                    if node[2] is None:
                        aggs[id(node)] = len(members)
                    else:
                        aggs[id(node)] = aggregate(node[1], vals, node[3])
                env = (gvals, aggs)
                if having_g is not None and truth(self.ev_group(having_g, env)) is not True:
                    continue
                out = [self.ev_group(x, env) for x in exprs_g]
                keys = [out[x[1]] if x[0] == "out" else self.ev_group(x, env) for x, _ in order_g]
                results.append((out, keys))
        else:
            for r in rows:
                out = [ev(x, r) for x in exprs]
                keys = [out[x[1]] if x[0] == "out" else ev(x, r) for x, _ in order_bound]
                results.append((out, keys))

        if distinct:
            seen, uniq = set(), []
            for out, keys in results:
                k = tuple(group_key(v) for v in out)
                if k not in seen:
                    seen.add(k)
                    uniq.append((out, keys))
            results = uniq
        for i in range(len(order_bound) - 1, -1, -1):
            results.sort(key=lambda rk: sort_key(rk[1][i]), reverse=order_bound[i][1])
        if offset:
            results = results[offset:]
        if limit is not None:
            results = results[:limit]
        return ["|".join(headers)] + ["|".join(fmt(v) for v in out) for out, _ in results]

    def group_expr(self, x, group_b):
        """Rewrites a bound expression for grouped evaluation; bare columns must be grouped."""
        for i, g in enumerate(group_b):
            if x == g:
                return ("gref", i)
        kind = x[0]
        if kind == "agg":
            if x[2] is not None and contains_agg(x[2]):
                raise SqlError("aggregate functions cannot be nested")
            return x
        if kind == "pos":
            raise SqlError("column must appear in GROUP BY or be used in an aggregate function")
        if kind == "lit":
            return x
        if kind == "fn":
            return ("fn", x[1], [self.group_expr(a, group_b) for a in x[2]])
        if kind == "case":
            return ("case", [(self.group_expr(c, group_b), self.group_expr(r, group_b)) for c, r in x[1]],
                    self.group_expr(x[2], group_b) if x[2] is not None else None)
        if kind == "in":
            return ("in", self.group_expr(x[1], group_b), [self.group_expr(v, group_b) for v in x[2]], x[3])
        if kind == "between":
            return ("between", *(self.group_expr(v, group_b) for v in x[1:4]), x[4])
        if kind in ("cmp", "bin"):
            return (kind, x[1], self.group_expr(x[2], group_b), self.group_expr(x[3], group_b))
        if kind in ("and", "or"):
            return (kind, self.group_expr(x[1], group_b), self.group_expr(x[2], group_b))
        if kind in ("not", "neg"):
            return (kind, self.group_expr(x[1], group_b))
        if kind == "isnull":
            return ("isnull", self.group_expr(x[1], group_b), x[2])
        if kind == "like":
            return ("like", self.group_expr(x[1], group_b), self.group_expr(x[2], group_b), x[3])
        raise SqlError("bad expression")

    def agg_nodes(self, exprs):
        found = []

        def walk(x):
            if not isinstance(x, tuple):
                return
            if x[0] == "agg":
                found.append(x)
                return
            if x[0] in ("gref", "pos", "lit"):
                return
            for c in _children(x):
                walk(c)

        for x in exprs:
            walk(x)
        return found

    def ev_group(self, x, env):
        gvals, aggs = env
        if x[0] == "gref":
            return gvals[x[1]] if gvals else None
        return ev(self._subst(x, gvals), [], aggs)

    def _subst(self, x, gvals):
        if not isinstance(x, tuple):
            return x
        if x[0] == "gref":
            return ("lit", gvals[x[1]] if gvals else None)
        if x[0] == "agg":
            return x
        if x[0] in ("lit", "pos"):
            return x
        if x[0] == "fn":
            return ("fn", x[1], [self._subst(a, gvals) for a in x[2]])
        if x[0] == "case":
            return ("case", [(self._subst(c, gvals), self._subst(r, gvals)) for c, r in x[1]],
                    self._subst(x[2], gvals) if x[2] is not None else None)
        if x[0] == "in":
            return ("in", self._subst(x[1], gvals), [self._subst(v, gvals) for v in x[2]], x[3])
        return tuple(self._subst(v, gvals) if isinstance(v, tuple) else v for v in x)
