"""Lexer and parser for the minidb SQL subset (instruction.md sections 2, 4, 5)."""

from __future__ import annotations

import re


class SqlError(Exception):
    pass


KEYWORDS = {
    "SELECT", "DISTINCT", "FROM", "AS", "JOIN", "LEFT", "ON", "WHERE", "GROUP", "BY", "HAVING",
    "ORDER", "ASC", "DESC", "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
    "DELETE", "CREATE", "TABLE", "IF", "NOT", "EXISTS", "DROP", "ALTER", "ADD", "COLUMN", "INDEX",
    "PRIMARY", "KEY", "UNIQUE", "DEFAULT", "NULL", "AND", "OR", "IS", "LIKE", "IN", "BETWEEN",
    "CASE", "WHEN", "THEN", "ELSE", "END", "BEGIN", "COMMIT", "ROLLBACK", "INTEGER", "REAL", "TEXT",
}
AGGREGATES = {"COUNT", "SUM", "AVG", "MIN", "MAX"}
FUNCTIONS = {"LENGTH": (1, 1), "UPPER": (1, 1), "LOWER": (1, 1), "ABS": (1, 1), "ROUND": (1, 2),
             "SUBSTR": (2, 3), "COALESCE": (1, None)}

_TOKEN = re.compile(
    r"\s+|--[^\n]*|(?P<num>[0-9]+(?:\.[0-9]+)?)|(?P<id>[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<str>'(?:[^']|'')*')|(?P<op><>|!=|<=|>=|\|\||[-+*/%=<>(),.*])"
)


def split_statements(text: str) -> list[str]:
    """Splits at semicolons outside strings and comments."""
    out, cur, i, n = [], [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "'":
            j = i + 1
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            cur.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("--", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            cur.append(text[i:j])
            i = j
        elif c == ";":
            out.append("".join(cur))
            cur = []
            i += 1
        else:
            cur.append(c)
            i += 1
    out.append("".join(cur))
    return [s for s in out if tokenize_or_empty(s)]


def tokenize_or_empty(s: str) -> bool:
    return bool(re.sub(r"--[^\n]*", "", s).strip())


def tokenize(text: str) -> list[tuple[str, object]]:
    tokens, pos = [], 0
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise SqlError(f"unexpected character {text[pos]!r}")
        pos = m.end()
        if m.group("num"):
            v = m.group("num")
            tokens.append(("num", float(v) if "." in v else int(v)))
        elif m.group("id"):
            up = m.group("id").upper()
            tokens.append(("kw", up) if up in KEYWORDS else ("id", m.group("id")))
        elif m.group("str"):
            tokens.append(("str", m.group("str")[1:-1].replace("''", "'")))
        elif m.group("op"):
            tokens.append(("op", m.group("op")))
    tokens.append(("eof", None))
    return tokens


class Parser:
    def __init__(self, text: str):
        self.t = tokenize(text)
        self.i = 0

    # -- helpers --
    def peek(self, k: int = 0):
        return self.t[self.i + k]

    def next(self):
        tok = self.t[self.i]
        self.i += 1
        return tok

    def is_kw(self, *words, k=0):
        kind, v = self.peek(k)
        return kind == "kw" and v in words

    def is_op(self, *ops, k=0):
        kind, v = self.peek(k)
        return kind == "op" and v in ops

    def accept_kw(self, *words):
        if self.is_kw(*words):
            return self.next()[1]
        return None

    def accept_op(self, *ops):
        if self.is_op(*ops):
            return self.next()[1]
        return None

    def expect_kw(self, word):
        if not self.accept_kw(word):
            raise SqlError(f"expected {word}")

    def expect_op(self, op):
        if not self.accept_op(op):
            raise SqlError(f"expected {op!r}")

    def ident(self) -> str:
        kind, v = self.next()
        if kind != "id":
            raise SqlError("expected an identifier")
        return v

    def end(self):
        if self.peek()[0] != "eof":
            raise SqlError(f"unexpected {self.peek()[1]!r}")

    # -- statements --
    def statement(self):
        if self.is_kw("SELECT"):
            stmt = self.select()
        elif self.accept_kw("INSERT"):
            stmt = self.insert()
        elif self.accept_kw("UPDATE"):
            stmt = self.update()
        elif self.accept_kw("DELETE"):
            self.expect_kw("FROM")
            table = self.ident()
            where = self.expr() if self.accept_kw("WHERE") else None
            stmt = ("delete", table, where)
        elif self.accept_kw("CREATE"):
            stmt = self.create()
        elif self.accept_kw("DROP"):
            if self.accept_kw("TABLE"):
                if_exists = bool(self.accept_kw("IF"))
                if if_exists:
                    self.expect_kw("EXISTS")
                stmt = ("drop_table", self.ident(), if_exists)
            else:
                self.expect_kw("INDEX")
                stmt = ("drop_index", self.ident())
        elif self.accept_kw("ALTER"):
            self.expect_kw("TABLE")
            table = self.ident()
            self.expect_kw("ADD")
            self.expect_kw("COLUMN")
            stmt = ("add_column", table, self.column_def())
        elif self.accept_kw("BEGIN"):
            stmt = ("begin",)
        elif self.accept_kw("COMMIT"):
            stmt = ("commit",)
        elif self.accept_kw("ROLLBACK"):
            stmt = ("rollback",)
        else:
            raise SqlError("unknown statement")
        self.end()
        return stmt

    def create(self):
        if self.accept_kw("INDEX"):
            name = self.ident()
            self.expect_kw("ON")
            table = self.ident()
            self.expect_op("(")
            col = self.ident()
            self.expect_op(")")
            return ("create_index", name, table, col)
        self.expect_kw("TABLE")
        if_not_exists = False
        if self.accept_kw("IF"):
            self.expect_kw("NOT")
            self.expect_kw("EXISTS")
            if_not_exists = True
        table = self.ident()
        self.expect_op("(")
        cols = [self.column_def()]
        while self.accept_op(","):
            cols.append(self.column_def())
        self.expect_op(")")
        return ("create_table", table, cols, if_not_exists)

    def column_def(self):
        name = self.ident()
        ctype = self.accept_kw("INTEGER", "REAL", "TEXT")
        if not ctype:
            raise SqlError("expected a column type")
        col = {"name": name, "type": ctype, "pk": False, "notnull": False, "unique": False, "default": None}
        while True:
            if self.accept_kw("PRIMARY"):
                self.expect_kw("KEY")
                col["pk"] = col["notnull"] = col["unique"] = True
            elif self.accept_kw("NOT"):
                self.expect_kw("NULL")
                col["notnull"] = True
            elif self.accept_kw("UNIQUE"):
                col["unique"] = True
            elif self.accept_kw("DEFAULT"):
                neg = bool(self.accept_op("-"))
                kind, v = self.next()
                if kind == "num":
                    col["default"] = -v if neg else v
                elif kind == "str" and not neg:
                    col["default"] = v
                elif kind == "kw" and v == "NULL" and not neg:
                    col["default"] = None
                else:
                    raise SqlError("DEFAULT needs a literal")
            else:
                return col

    def insert(self):
        self.expect_kw("INTO")
        table = self.ident()
        cols = None
        if self.accept_op("("):
            cols = [self.ident()]
            while self.accept_op(","):
                cols.append(self.ident())
            self.expect_op(")")
        self.expect_kw("VALUES")
        rows = [self.paren_list()]
        while self.accept_op(","):
            rows.append(self.paren_list())
        return ("insert", table, cols, rows)

    def paren_list(self):
        self.expect_op("(")
        items = [self.expr()]
        while self.accept_op(","):
            items.append(self.expr())
        self.expect_op(")")
        return items

    def update(self):
        table = self.ident()
        self.expect_kw("SET")
        sets = []
        while True:
            col = self.ident()
            self.expect_op("=")
            sets.append((col, self.expr()))
            if not self.accept_op(","):
                break
        where = self.expr() if self.accept_kw("WHERE") else None
        return ("update", table, sets, where)

    def select(self):
        self.expect_kw("SELECT")
        distinct = bool(self.accept_kw("DISTINCT"))
        items = [self.select_item()]
        while self.accept_op(","):
            items.append(self.select_item())
        sources, joins = None, []
        if self.accept_kw("FROM"):
            sources = self.table_ref()
            while self.is_kw("JOIN", "LEFT"):
                left = bool(self.accept_kw("LEFT"))
                self.expect_kw("JOIN")
                ref = self.table_ref()
                self.expect_kw("ON")
                joins.append((left, ref, self.expr()))
        where = self.expr() if self.accept_kw("WHERE") else None
        group = []
        if self.accept_kw("GROUP"):
            self.expect_kw("BY")
            group = [self.expr()]
            while self.accept_op(","):
                group.append(self.expr())
        having = self.expr() if self.accept_kw("HAVING") else None
        order = []
        if self.accept_kw("ORDER"):
            self.expect_kw("BY")
            while True:
                e = self.expr()
                desc = self.accept_kw("ASC", "DESC") == "DESC"
                order.append((e, desc))
                if not self.accept_op(","):
                    break
        limit = offset = None
        if self.accept_kw("LIMIT"):
            limit = self.int_literal()
            if self.accept_kw("OFFSET"):
                offset = self.int_literal()
        return ("select", distinct, items, sources, joins, where, group, having, order, limit, offset)

    def int_literal(self):
        kind, v = self.next()
        if kind != "num" or not isinstance(v, int):
            raise SqlError("LIMIT and OFFSET need non-negative integers")
        return v

    def table_ref(self):
        name = self.ident()
        alias = None
        if self.accept_kw("AS"):
            alias = self.ident()
        elif self.peek()[0] == "id":
            alias = self.ident()
        return (name, alias or name)

    def select_item(self):
        if self.accept_op("*"):
            return ("star", None)
        if self.peek()[0] == "id" and self.is_op(".", k=1) and self.is_op("*", k=2):
            name = self.ident()
            self.next()
            self.next()
            return ("star", name)
        e = self.expr()
        alias = self.ident() if self.accept_kw("AS") else None
        return ("expr", e, alias)

    # -- expressions --
    def expr(self):
        return self.or_expr()

    def or_expr(self):
        e = self.and_expr()
        while self.accept_kw("OR"):
            e = ("or", e, self.and_expr())
        return e

    def and_expr(self):
        e = self.not_expr()
        while self.accept_kw("AND"):
            e = ("and", e, self.not_expr())
        return e

    def not_expr(self):
        if self.accept_kw("NOT"):
            return ("not", self.not_expr())
        return self.comparison()

    def comparison(self):
        e = self.additive()
        while True:
            op = self.accept_op("=", "!=", "<>", "<", "<=", ">", ">=")
            if op:
                e = ("cmp", "!=" if op == "<>" else op, e, self.additive())
                continue
            if self.accept_kw("IS"):
                neg = bool(self.accept_kw("NOT"))
                self.expect_kw("NULL")
                e = ("isnull", e, neg)
                continue
            neg = False
            if self.is_kw("NOT") and self.is_kw("LIKE", "IN", "BETWEEN", k=1):
                self.next()
                neg = True
            if self.accept_kw("LIKE"):
                e = ("like", e, self.additive(), neg)
            elif self.accept_kw("IN"):
                e = ("in", e, self.paren_list(), neg)
            elif self.accept_kw("BETWEEN"):
                lo = self.additive()
                self.expect_kw("AND")
                e = ("between", e, lo, self.additive(), neg)
            else:
                return e

    def additive(self):
        e = self.multiplicative()
        while True:
            op = self.accept_op("+", "-", "||")
            if not op:
                return e
            e = ("bin", op, e, self.multiplicative())

    def multiplicative(self):
        e = self.unary()
        while True:
            op = self.accept_op("*", "/", "%")
            if not op:
                return e
            e = ("bin", op, e, self.unary())

    def unary(self):
        if self.accept_op("-"):
            return ("neg", self.unary())
        return self.primary()

    def primary(self):
        kind, v = self.peek()
        if kind == "num" or kind == "str":
            self.next()
            return ("lit", v)
        if kind == "kw" and v == "NULL":
            self.next()
            return ("lit", None)
        if kind == "kw" and v == "CASE":
            self.next()
            whens = []
            while self.accept_kw("WHEN"):
                cond = self.expr()
                self.expect_kw("THEN")
                whens.append((cond, self.expr()))
            if not whens:
                raise SqlError("CASE needs WHEN")
            other = self.expr() if self.accept_kw("ELSE") else None
            self.expect_kw("END")
            return ("case", whens, other)
        if self.accept_op("("):
            e = self.expr()
            self.expect_op(")")
            return e
        if kind == "id":
            name = self.next()[1]
            if self.accept_op("("):
                return self.call(name.upper())
            if self.accept_op("."):
                return ("col", name.lower(), self.ident().lower())
            return ("col", None, name.lower())
        raise SqlError(f"unexpected {v!r}")

    def call(self, fn):
        if fn in AGGREGATES:
            if fn == "COUNT" and self.accept_op("*"):
                self.expect_op(")")
                return ("agg", "COUNT", None, False)
            distinct = bool(self.accept_kw("DISTINCT"))
            if distinct and fn != "COUNT":
                raise SqlError("DISTINCT is only allowed in COUNT")
            arg = self.expr()
            self.expect_op(")")
            return ("agg", fn, arg, distinct)
        if fn not in FUNCTIONS:
            raise SqlError(f"no such function: {fn}")
        args = []
        if not self.accept_op(")"):
            args = [self.expr()]
            while self.accept_op(","):
                args.append(self.expr())
            self.expect_op(")")
        lo, hi = FUNCTIONS[fn]
        if len(args) < lo or (hi is not None and len(args) > hi):
            raise SqlError(f"wrong number of arguments to {fn}")
        return ("fn", fn, args)
