"""Python programs of the minipy task; build_cases.py runs each with CPython 3.12 as prog.py and records
stdout, the exit status and the last line of stderr."""

CASES = []


def c(name, code):
    CASES.append({"name": name, "code": code.strip("\n") + "\n"})


c("hello_and_print_options", '''
print("hello", 1, 2.5, None, True)
print("a", "b", sep="-", end="!\\n")
print()
print(*[1, 2, 3], sep=", ")''')
c("integers", '''
print(7 // 2, -7 // 2, 7 % 3, -7 % 3, 7 % -3, 2 ** 100, 2 ** -1, 10 / 4, 0x1F, 0o17, 0b101, 1_000_000)
print(divmod(17, 5), divmod(-17, 5), pow(3, 4, 5), abs(-12), int("42"), int("  -7 "), int("ff", 16), int(3.99), int(-3.99))
print(123456789 ** 3, (1 << 70) | 1, ~5, 5 & 3, 5 ^ 3, -8 >> 1, bool(0), bool(-1))''')
c("floats", '''
print(0.1 + 0.2, 1 / 3, 1e16, 1e-7, 2.0, -0.0, 3.14159, 1e300 * 1e10, float("1.5"), float("inf"), round(2.675, 2))
print(round(0.5), round(1.5), round(2.5), round(-0.5), round(3.14159, 3), round(1234.5678, -2), int(2.5e3))
print(7.0 // 2, 7.5 % 2, -7.5 % 2, 2 ** 0.5, abs(-1.5), max(1, 2.5), min([3, 1.5, 2]))''')
c("strings_basic", '''
s = "Hello, World"
print(len(s), s[0], s[-1], s[2:5], s[::-1], s[::2], s[7:], s[:-3], s[100:], s * 2, "lo" in s, s.find("o"), s.index("W"))
print(s.lower(), s.upper(), s.title(), "hello world".capitalize(), s.count("l"), s.replace("l", "L", 2))
print(s.split(", "), " a  b ".split(), "a,b,,c".split(","), "x".join(["1", "2", "3"]), s.startswith("He"), s.endswith("ld"))
print("  pad ".strip(), "xxhixx".strip("x"), "  a".lstrip(), "a  ".rstrip() + "|", "42".zfill(5), "ab".center(6, "*"), "ab".ljust(4) + "|", "ab".rjust(4))
print("abc".isalpha(), "123".isdigit(), " \\t".isspace(), "a=b=c".partition("="), "l1\\nl2\\r\\nl3".splitlines())''')
c("string_escapes_and_raw", r'''
print("tab\tnew\\line", 'q"q', "s'q", "\x41é\N{GREEK SMALL LETTER ALPHA}", len("\n"))
print(r"raw\n\t", """triple
quoted""", 'implicit' ' concat')
print(repr("it's"), repr('say "hi"'), repr("both ' and \""), repr("\n\t\\"), repr("é"))''')
c("formatting", '''
x, name = 3.14159, "Ann"
print(f"{x:.2f}|{x:10.3f}|{x:<10.1f}|{42:05d}|{255:x}|{255:#b}|{1234567:,}|{0.25:.1%}|{name!r}|{name:>6}|{name:^7}|")
print(f"{x=}", f"{1 + 2 = }", f"{'nested'}", f"{{braces}}", f"{[1, 2]}")
print("%s is %d years, %.2f m, %5s|%-5s|%x|%r" % ("Bob", 30, 1.756, "r", "l", 255, "q"))
print("{} {} {}".format(1, "a", [2]), "{1}{0}".format("a", "b"), "{name}-{n:03d}".format(name="x", n=7), "{:e}".format(12345.678))''')
c("lists", '''
a = [3, 1, 4, 1, 5]
a.append(9); a.extend([2, 6]); a.insert(0, 0)
print(a, len(a), a.pop(), a.pop(0), a.index(4), a.count(1))
a.remove(1); a.sort(); print(a); a.sort(reverse=True); print(a); a.reverse(); print(a)
b = a.copy(); b[0] = 99; print(a[0], b[0], a + [7], [0] * 3, a[1:3], a[::-2])
a[1:3] = [10, 20, 30]; print(a); del a[0]; del a[::2]; print(a)
print(sorted([3, 1, 2], reverse=True), sorted(["b", "A", "c"], key=str.lower), list(reversed([1, 2, 3])), [1, 2] == [1, 2], [1, 2] < [1, 3])
nested = [[1, 2], [3]]; nested[0].append(5); print(nested, sum([1, 2, 3]), sum([[1], [2]], []))''')
c("tuples_and_unpacking", '''
t = (1, 2, 3)
a, b, c = t; print(a, b, c)
first, *rest = [1, 2, 3, 4]; print(first, rest)
*init, last = "abc"; print(init, last)
x, (y, z) = 1, (2, 3); print(x, y, z)
p, q = q, p = 1, 2; print(p, q)
print((1,), (), tuple([1, 2]), t + (4,), t * 2, t.index(2), t.count(1), len(t), 2 in t, t[1:])
for i, (k, v) in enumerate([("a", 1), ("b", 2)]): print(i, k, v)''')
c("dicts", '''
d = {"a": 1, "b": 2}
d["c"] = 3; print(d, len(d), d["a"], d.get("z"), d.get("z", 0), "b" in d)
print(list(d.keys()), list(d.values()), list(d.items()))
print(d.pop("a"), d.setdefault("x", 10), d.setdefault("b", 99), d)
d.update({"b": 20}, y=5); print(d)
print({k: v * 2 for k, v in d.items() if v > 5}, dict(zip("ab", [1, 2])), dict.fromkeys("xy", 0), dict([(1, 2)]))
del d["x"]; print(d, sorted(d), {1: "a", 1.0: "b", True: "c"})
for k in d: print(k, end=" ")
print()''')
c("sets", '''
s = {3, 1, 2}
s.add(5); s.discard(9); s.remove(1)
print(sorted(s), len(s), 2 in s)
a, b = {1, 2, 3}, {2, 3, 4}
print(sorted(a | b), sorted(a & b), sorted(a - b), sorted(a ^ b), a <= {1, 2, 3, 9}, a.issubset(b), sorted(a.union([7])))
print(sorted({x % 3 for x in range(10)}), frozenset([1, 2]) == frozenset([2, 1]), set() == set(), len(set("hello")))''')
c("control_flow", '''
for i in range(10):
    if i % 2 == 0:
        continue
    if i > 7:
        break
    print(i, end=" ")
else:
    print("no break")
print()
for i in range(3):
    pass
else:
    print("loop finished", i)
n = 0
while n < 5:
    n += 1
else:
    print("while done", n)
x = 15
print("big" if x > 10 else "small", 1 < x < 20, 1 < x > 20, x == 15 == 15.0)
if (y := x * 2) > 20: print("walrus", y)''')
c("functions_args", '''
def f(a, b=2, *args, c, d=4, **kw):
    return (a, b, args, c, d, sorted(kw.items()))
print(f(1, c=3))
print(f(1, 5, 6, 7, c=8, e=9, f=10))
print(f(*[1, 2, 3], **{"c": 0, "z": 1}))
def pos(a, b, /, c): return a + b + c
print(pos(1, 2, c=3))
def defaults(x, acc=[]):
    acc.append(x); return acc
print(defaults(1), defaults(2))
g = lambda x, y=10: x * y
print(g(3), g(3, 2), (lambda *a: sum(a))(1, 2, 3))''')
c("closures_and_scopes", '''
def counter():
    n = 0
    def inc():
        nonlocal n
        n += 1
        return n
    return inc
c1, c2 = counter(), counter()
print(c1(), c1(), c2())
total = 0
def add(x):
    global total
    total += x
add(5); add(7); print(total)
fs = [lambda: i for i in range(3)]
print([f() for f in fs])
fs = [lambda i=i: i for i in range(3)]
print([f() for f in fs])
def outer():
    x = "outer"
    def inner(): return x
    x = "changed"
    return inner()
print(outer())''')
c("recursion", '''
def fact(n): return 1 if n <= 1 else n * fact(n - 1)
def fib(n): return n if n < 2 else fib(n - 1) + fib(n - 2)
def hanoi(n, a, b, c, moves):
    if n == 0: return moves
    hanoi(n - 1, a, c, b, moves); moves.append((a, c)); hanoi(n - 1, b, a, c, moves)
    return moves
print(fact(30), fib(20), len(hanoi(10, "A", "B", "C", [])), hanoi(2, "A", "B", "C", []))''')
c("decorators", '''
def trace(fn):
    def wrapper(*a, **k):
        print("call", fn.__name__, a)
        return fn(*a, **k)
    return wrapper
def repeat(n):
    def deco(fn):
        def w(*a):
            return [fn(*a) for _ in range(n)]
        return w
    return deco
@trace
def add(a, b): return a + b
@repeat(3)
def hi(x): return "hi " + x
print(add(1, 2), hi("you"))''')
c("classes_basic", '''
class Point:
    count = 0
    def __init__(self, x, y):
        self.x, self.y = x, y
        Point.count += 1
    def __repr__(self): return f"Point({self.x}, {self.y})"
    def __str__(self): return f"({self.x}, {self.y})"
    def __eq__(self, o): return isinstance(o, Point) and (self.x, self.y) == (o.x, o.y)
    def __hash__(self): return hash((self.x, self.y))
    def __add__(self, o): return Point(self.x + o.x, self.y + o.y)
    def __mul__(self, k): return Point(self.x * k, self.y * k)
    __rmul__ = __mul__
    def __lt__(self, o): return (self.x, self.y) < (o.x, o.y)
    def norm2(self): return self.x ** 2 + self.y ** 2
p, q = Point(1, 2), Point(3, 4)
print(p, repr(q), p + q, p * 2, 3 * p, p == Point(1, 2), p != q, Point.count, p.norm2(), sorted([q, p]), len({p, Point(1, 2)}))
print([str(p)], f"{p!r}", getattr(p, "x"), hasattr(p, "z"), isinstance(p, Point), type(p).__name__)
setattr(p, "z", 5); print(p.z)''')
c("inheritance_and_super", '''
class Animal:
    def __init__(self, name): self.name = name
    def speak(self): return f"{self.name} makes a sound"
    def describe(self): return f"{type(self).__name__}: {self.speak()}"
class Dog(Animal):
    def __init__(self, name, breed):
        super().__init__(name); self.breed = breed
    def speak(self): return f"{self.name} barks"
class Puppy(Dog):
    def speak(self): return super().speak() + " softly"
for a in [Animal("generic"), Dog("Rex", "lab"), Puppy("Bit", "pug")]:
    print(a.describe())
print(issubclass(Puppy, Animal), isinstance(Puppy("a", "b"), Dog), Puppy.__mro__ == (Puppy, Dog, Animal, object))
class A:
    def who(self): return "A"
class B(A):
    def who(self): return "B" + super().who()
class C(A):
    def who(self): return "C" + super().who()
class D(B, C):
    def who(self): return "D" + super().who()
print(D().who(), [k.__name__ for k in D.__mro__])''')
c("properties_static_class_methods", '''
class Temp:
    unit = "C"
    def __init__(self, c): self._c = c
    @property
    def f(self): return self._c * 9 / 5 + 32
    @f.setter
    def f(self, v): self._c = (v - 32) * 5 / 9
    @staticmethod
    def kind(): return "temperature"
    @classmethod
    def zero(cls): return cls(0)
t = Temp(100)
print(t.f, Temp.kind(), t.kind(), Temp.zero().f, Temp.unit)
t.f = 212; print(t._c)
try:
    del t.f
except AttributeError as e:
    print("AttributeError")''')
c("container_protocols", '''
class Range3:
    def __init__(self, n): self.n = n
    def __len__(self): return self.n
    def __getitem__(self, i):
        if not 0 <= i < self.n: raise IndexError(i)
        return i * 3
    def __contains__(self, v): return v % 3 == 0 and v < self.n * 3
class Countdown:
    def __init__(self, n): self.n = n
    def __iter__(self): return self
    def __next__(self):
        if self.n <= 0: raise StopIteration
        self.n -= 1
        return self.n + 1
r = Range3(4)
print(len(r), r[2], list(r), 6 in r, 7 in r, list(Countdown(3)), sum(Countdown(4)), bool(Range3(0)))
class Adder:
    def __init__(self, k): self.k = k
    def __call__(self, x): return x + self.k
print(Adder(5)(10), callable(Adder(1)), callable(3))''')
c("exceptions", '''
def risky(x):
    if x == 0: raise ValueError("zero!")
    return 10 / x
for v in [2, 0, "a"]:
    try:
        r = risky(v)
    except ValueError as e:
        print("value error:", e, e.args)
    except (TypeError, ZeroDivisionError) as e:
        print("other:", type(e).__name__, e)
    else:
        print("ok", r)
    finally:
        print("finally", v)
class AppError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg); self.code = code
try:
    raise AppError(42, "custom failure")
except Exception as e:
    print(type(e).__name__, e.code, str(e), isinstance(e, AppError))
try:
    try:
        {}["missing"]
    except KeyError as e:
        raise RuntimeError("wrapped") from e
except RuntimeError as e:
    print(e, type(e.__cause__).__name__, repr(e.__cause__))
def f():
    try:
        return "try"
    finally:
        print("cleanup")
print(f())''')
c("builtin_error_messages", '''
tests = [lambda: 1 / 0, lambda: [1][5], lambda: {}["k"], lambda: undefined_name, lambda: 1 + "a", lambda: int("x"),
         lambda: None.attr, lambda: 5(), lambda: 3[0], lambda: [].pop(), lambda: "abc".index("z"), lambda: next(iter([])),
         lambda: (1, 2).append(3), lambda: float("nope"), lambda: {}.pop("q"), lambda: [1, 2].remove(9), lambda: int(None)]
for t in tests:
    try:
        t()
    except Exception as e:
        print(type(e).__name__, "|", e)''')
c("uncaught_exception", '''
def g(): return {"a": 1}["b"]
print("start")
g()''')
c("uncaught_custom_exception", '''
class Boom(Exception): pass
raise Boom("it exploded")''')
c("assert_failure", '''
x = 3
assert x == 3, "fine"
assert x > 5, f"x too small: {x}"''')
c("syntax_error", '''
print("never")
def broken(:
    pass''')
c("with_statement", '''
class Ctx:
    def __init__(self, name): self.name = name
    def __enter__(self): print("enter", self.name); return self.name.upper()
    def __exit__(self, et, ev, tb):
        print("exit", self.name, et.__name__ if et else None)
        return self.name == "swallow"
with Ctx("a") as v, Ctx("b") as w:
    print("body", v, w)
with Ctx("swallow"):
    raise ValueError("hidden")
print("after swallow")
try:
    with Ctx("keep"):
        raise KeyError("shown")
except KeyError as e:
    print("caught", e)''')
c("generators", '''
def gen(n):
    for i in range(n):
        yield i * i
    return "done"
def wrapper():
    result = yield from gen(3)
    yield result
print(list(gen(5)), list(wrapper()), sum(x for x in range(10) if x % 2), next(iter(gen(1))))
g = gen(2); print(next(g), next(g))
try:
    next(g)
except StopIteration as e:
    print("stop", e.value)
def fib():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b
f = fib(); print([next(f) for _ in range(12)])
print(list(zip(gen(3), "abc")), list(map(lambda x: -x, gen(3))), list(filter(None, [0, 1, "", "a"])))''')
c("comprehensions", '''
print([x * y for x in range(1, 4) for y in range(x) if (x + y) % 2])
print({x: x ** 2 for x in range(5)}, {c for c in "mississippi"} == set("misp"), [[r * c for c in range(3)] for r in range(3)])
matrix = [[1, 2, 3], [4, 5, 6]]
print([list(col) for col in zip(*matrix)], [n for row in matrix for n in row if n % 2 == 0])
x = "global"
print([x for x in range(2)], x)''')
c("builtins_misc", '''
print(list(enumerate("ab", start=1)), list(zip([1, 2, 3], "ab")), list(range(10, 0, -3)), len(range(0, 100, 7)), range(5)[2])
print(any([0, "", None]), all([1, "a"]), all([]), max("abc"), min(3, 1, key=lambda v: -v), max([], default="empty"))
print(sorted({"b": 2, "a": 1}.items(), key=lambda kv: kv[1], reverse=True), chr(65), ord("a"), hex(255), bin(5), oct(8))
print(isinstance(True, int), type(1) is int, type("") == str, str(1.0), repr([1, "a"]), bool([]), int(True) + 1)
print(format(3.14159, ".3f"), format(42, "08b"), "abc".encode() if False else "skip", slice(1, 5, 2), list(range(20))[slice(1, 8, 3)])
it = iter([1, 2, 3]); print(next(it), list(it), next(it, "end"))''')
c("math_module", '''
import math
from math import sqrt, pi as PI
print(math.floor(-2.5), math.ceil(2.1), sqrt(16), round(PI, 5), math.gcd(12, 18), math.factorial(10), math.isclose(0.1 + 0.2, 0.3))
print(math.inf > 1e308, math.isnan(float("nan")), math.log(math.e), math.log10(1000), math.hypot(3, 4), math.trunc(-3.7), math.comb(5, 2))''')
c("object_identity_and_equality", '''
a = [1, 2]; b = a; c = [1, 2]
print(a is b, a is c, a == c, None is None, a is not c)
b.append(3); print(a, c)
x = y = []
x.append(1); print(y)
class V:
    def __init__(self, v): self.v = v
print(V(1) == V(1), V(1) != V(1))''')
c("string_methods_more", '''
s = "The quick brown fox"
words = s.split()
print([w[::-1] for w in words], " ".join(sorted(words, key=len)), s.count(" "), s.rfind("o"), s.upper().lower() == s.lower())
print("a-b-c".split("-", 1), "a-b-c".rsplit("-", 1), ",".join(str(i) for i in range(5)), "%-8s|" % "left", "x".join("abc"))
print("CamelCaseString".swapcase(), "hello"[1:4].upper(), "abcabc".replace("b", ""), "tab\\tsep".expandtabs(4), "aaa".lstrip("a") == "")''')
c("big_program_bank", '''
class InsufficientFunds(Exception): pass
class Account:
    _next = 1
    def __init__(self, owner, balance=0):
        self.id = Account._next; Account._next += 1
        self.owner, self.balance, self.history = owner, balance, []
    def deposit(self, amt):
        if amt <= 0: raise ValueError("amount must be positive")
        self.balance += amt; self.history.append(("dep", amt)); return self
    def withdraw(self, amt):
        if amt > self.balance: raise InsufficientFunds(f"{self.owner}: balance {self.balance} < {amt}")
        self.balance -= amt; self.history.append(("wd", amt)); return self
    def __repr__(self): return f"<Account {self.id} {self.owner} {self.balance}>"
class Bank:
    def __init__(self): self.accounts = {}
    def open(self, owner, amt=0):
        a = Account(owner, amt); self.accounts[a.id] = a; return a
    def transfer(self, src, dst, amt):
        self.accounts[src].withdraw(amt); self.accounts[dst].deposit(amt)
    def report(self):
        return sorted(self.accounts.values(), key=lambda a: (-a.balance, a.owner))
bank = Bank()
a, b, c = bank.open("ann", 100), bank.open("bob"), bank.open("cid", 50)
bank.transfer(1, 2, 30)
for args in [(2, 3, 100), (3, 1, 50), (1, 3, -5)]:
    try:
        bank.transfer(*args)
    except InsufficientFunds as e:
        print("insufficient:", e)
    except ValueError as e:
        print("invalid:", e)
print(bank.report(), a.history, sum(acc.balance for acc in bank.accounts.values()))''')
c("big_program_text_stats", '''
text = """It was the best of times, it was the worst of times, it was the age of wisdom,
it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity"""
counts = {}
for raw in text.lower().split():
    w = raw.strip(",.")
    counts[w] = counts.get(w, 0) + 1
top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
print(top)
print(max(counts, key=lambda w: (len(w), w)), len(counts), sum(counts.values()))
lines = text.splitlines()
print([len(l.split()) for l in lines], f"{sum(len(w) for w in counts) / len(counts):.3f}")''')
c("big_program_matrix_class", '''
class Matrix:
    def __init__(self, rows): self.rows = [list(r) for r in rows]
    @classmethod
    def identity(cls, n): return cls([[int(i == j) for j in range(n)] for i in range(n)])
    def __matmul__(self, o): return NotImplemented
    def __mul__(self, o):
        if isinstance(o, (int, float)): return Matrix([[v * o for v in r] for r in self.rows])
        return Matrix([[sum(a * b for a, b in zip(r, col)) for col in zip(*o.rows)] for r in self.rows])
    def __eq__(self, o): return self.rows == o.rows
    def __getitem__(self, ij): i, j = ij; return self.rows[i][j]
    def __repr__(self): return "Matrix(" + repr(self.rows) + ")"
    def transpose(self): return Matrix(zip(*self.rows))
m = Matrix([[1, 2], [3, 4]])
print(m * m, m * 2, m * Matrix.identity(2) == m, m[1, 0], m.transpose(), (m * m)[0, 1])''')
c("generator_pipeline", '''
def read(lines):
    for l in lines: yield l.strip()
def nonempty(it): return (x for x in it if x)
def parse(it):
    for x in it:
        k, _, v = x.partition("=")
        yield k.strip(), int(v)
data = ["a = 1", "", "b= 22 ", "  ", "c =3"]
pairs = dict(parse(nonempty(read(data))))
print(pairs, sum(pairs.values()), sorted(pairs, key=pairs.get, reverse=True))''')
c("inheritance_errors", '''
class Base:
    def area(self): raise NotImplementedError("subclass must implement")
class Sq(Base):
    def __init__(self, s): self.s = s
    def area(self): return self.s ** 2
for shape in [Sq(3), Base()]:
    try:
        print(shape.area())
    except NotImplementedError as e:
        print("not implemented:", e)
print(Sq(2).area(), getattr(Sq(2), "missing", "default"))
try:
    Sq(2).missing
except AttributeError as e:
    print(e)''')
c("recursion_error", '''
def deep(n): return deep(n + 1)
try:
    deep(0)
except RecursionError as e:
    print("RecursionError caught")''')
