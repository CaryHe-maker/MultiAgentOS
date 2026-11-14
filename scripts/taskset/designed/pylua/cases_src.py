"""Lua programs of the pylua task; build_cases.py runs each with lua5.4 as `prog.lua` and records stdout,
stderr and the exit status. Each case: name, code, stdin, args."""

CASES = []


def c(name, code, stdin="", args=()):
    CASES.append({"name": name, "code": code.strip("\n") + "\n", "stdin": stdin, "args": list(args)})


# ---------------- lexical
c("hello", 'print("hello, world")')
c("print_multiple", 'print(1, "a", nil, true, false, 2.5)')
c("long_strings", '''
local a = [[line1
line2]]
local b = [==[with ]] inside]==]
print(a); print(b)
--[[ long
comment ]] print("after comment")
--[==[ another ]==] print("x")''')
c("escapes", r'''
print("tab\tnew\\nline", "q\"q", 'single\'s')
print("\65\066\x43\u{48}\u{4E2D}", #"\u{4E2D}")
print("a\z
      b")
print("\0x" == "\0" .. "x", #"\0abc")''')
c("numerals", '''
print(0xff, 0XA, 1e2, .5, 3., 0x.8p1, 0x1p4, 1E-2, 0xA.8p0)
print(math.type(1), math.type(1.0), math.type(0x10), math.type(1e2))
print(9007199254740993, 0x7fffffffffffffff, 0xffffffffffffffff)''')
c("comments_and_semicolons", '''
local x = 1; local y = 2;;; -- comment
print(x + y) ;''')

# ---------------- integers and floats
c("int_float_arith", '''
print(7 // 2, -7 // 2, 7 % 3, -7 % 3, 7 % -3, 7.0 // 2, -7.5 % 2, 7 / 2, 4 / 2)
print(3 + 0.0, 2^10, 2^0.5, 10 // 0.0, -10 % math.huge)
print(1 == 1.0, math.type(3 // 1), math.type(3 / 1))''')
c("integer_overflow_wraps", '''
print(math.maxinteger + 1 == math.mininteger, math.mininteger - 1 == math.maxinteger)
print(math.maxinteger * 2, -math.mininteger, math.mininteger // -1)
print(math.maxinteger + 1.0, 2^63, math.tointeger(2^53), math.tointeger(3.5))''')
c("division_by_zero", '''
print(pcall(function() return 1 // 0 end))
print(pcall(function() return 1 % 0 end))
print(1 / 0, -1 / 0, 0/0 ~= 0/0, 1.0 // 0, 1 % 0.0 ~= 1 % 0.0)''')
c("float_formatting", '''
print(0.1, 1/3, 100.0, 1e15, 1e16, 2^53, -0.0, 1e100, 123456789012.5, 3.14159265358979)
print(tostring(1e300 * 1e10), tostring(-1e300 * 1e10), 2^63 == math.maxinteger + 1.0)''')
c("string_coercion", '''
print("10" + 5, "3.5" * 2, "0x10" + 0, 10 .. 20, 1.5 .. "", "  7  " * 1)
print(pcall(function() return "abc" + 1 end))
print("10" == 10, tonumber("  0x1p4  "), tonumber("1e1"), tonumber("z", 36), tonumber("ff", 16), tonumber("8", 8))
print(tonumber("12a"), tonumber(""), tonumber("1 2"), tonumber("0x"), tonumber(nil))''')
c("comparisons", '''
print(1 < 2, 1 < 1.5, "a" < "b", "Z" < "a", "abc" < "abd", "" < "a", 2 <= 2.0, math.mininteger < -2^63 + 1)
print(pcall(function() return 1 < "2" end))
print(pcall(function() return {} < {} end))''')
c("bitwise", '''
print(5 & 3, 5 | 3, 5 ~ 3, ~0, 1 << 4, 256 >> 4, -1 >> 60, 1 << 64, 1 << 63)
print(3.0 & 1, "3" | 0)
print(pcall(function() return 1.5 & 1 end))''')
c("math_lib", '''
print(math.abs(-3), math.abs(-3.5), math.ceil(3.2), math.floor(-3.2), math.fmod(7, 3), math.fmod(-7, 3), math.fmod(-7.5, 2))
print(math.max(3, 9, 2), math.min(3.5, 1, 2), math.huge, -math.huge, math.pi)
print(math.modf(3.7), math.modf(-3.7), math.sqrt(16), math.exp(0), math.log(8, 2), math.log(100, 10), math.log(1))
print(math.tointeger("8"), math.ult(1, -1), math.type("1"), math.floor(2^31 + 0.5), math.ceil(-0.5))
print(string.format("%.4f %.4f %.4f %.4f", math.sin(1), math.cos(1), math.tan(1), math.atan(1, 2)))''')

# ---------------- strings
c("string_basic", '''
local s = "Hello World"
print(#s, s:upper(), s:lower(), s:len(), s:rep(2, "-"), s:reverse(), ("x"):rep(0), ("ab"):rep(3))
print(s:sub(1, 5), s:sub(-5), s:sub(3, -3), s:sub(0), s:sub(20), s:sub(-100, 2), s:sub(5, 4))
print(s:byte(1), s:byte(-1), s:byte(1, 3), string.char(72, 105), s:byte(100))''')
c("string_find", '''
local s = "hello world from lua"
print(s:find("world"), s:find("o", 6), s:find("xyz"), s:find("l+"), s:find(".", 1, true), s:find("", 3))
print(s:find("(o)(r)"), s:find("%s"), s:find("o", -3), ("a.b"):find(".", 1, true), ("a+b"):find("+", 1, true))''')
c("string_match", '''
print(("key = value"):match("(%w+)%s*=%s*(%w+)"))
print(("2024-01-15"):match("(%d+)-(%d+)-(%d+)"))
print(("  trim me  "):match("^%s*(.-)%s*$") .. "|")
print(("abc"):match("()b()"), ("hello"):match(".-l"), ("hello"):match(".*l"), ("x"):match("y"))
print(("[test]"):match("%[(.*)%]"), ("f(a(b)c)d"):match("%b()"), ("THE (quick) fox"):match("%f[%a]%a+", 5))''')
c("string_gmatch", '''
for w in ("one two  three"):gmatch("%a+") do io.write(w, ";") end print()
for k, v in ("a=1, b=2, c=3"):gmatch("(%w+)=(%w+)") do io.write(k, "->", v, " ") end print()
for pos in ("abcabc"):gmatch("()b") do io.write(pos, " ") end print()
local n = 0 for _ in ("aaa"):gmatch("") do n = n + 1 end print(n)''')
c("string_gsub", '''
print(("hello world"):gsub("o", "0"))
print(("hello world"):gsub("o", "0", 1))
print(("hello"):gsub("", "-"))
print(("abc"):gsub("%w", "%0%0"), ("abc"):gsub("(a)(b)", "%2%1"))
print(("$name is $age"):gsub("%$(%w+)", {name = "Ann", age = 30}))
print(("1 2 3"):gsub("%d", function(d) return d * 2 end))
print(("x y"):gsub("%w", function(c) if c == "x" then return nil end return false end))
print(pcall(string.gsub, "abc", "(", "x"))''')
c("pattern_classes", '''
local s = "Ab1 _-.\\t\\n#"
for _, cls in ipairs({"%a", "%d", "%l", "%u", "%s", "%w", "%x", "%p", "%c", "%A", "[%a_]", "[^%w]", "[a-c]", "[%-]"}) do
  local out = {}
  for ch in s:gmatch(cls) do out[#out + 1] = string.byte(ch) end
  print(cls, table.concat(out, ","))
end''')
c("string_format", '''
print(string.format("%d|%5d|%-5d|%05d|%+d|%x|%X|%o|%c", 42, 42, 42, 42, 42, 255, 255, 8, 65))
print(string.format("%s|%10s|%-10s|%.2s|%5.1f|%e|%g|%g|%g", "hi", "right", "left", "abc", 3.14159, 1234.5, 0.0001, 1e20, 100))
print(string.format("%q", 'a "quoted"\\n\\0 string'))
print(string.format("%q|%q|%q", 10, 2.5, math.mininteger))
print(string.format("%5.2s|%.3d|%i|%%|%s|%s", "xyz", 5, 7, nil, true))
print(string.format("%.14g|%.3f|%10.4f", 2^0.5, 2/3, -1.5))
print(pcall(string.format, "%d", 1.5))''')
c("tostring_tonumber", '''
print(tostring(10), tostring(10.0), tostring(-0.0), tostring(nil), tostring(true), tostring("s"))
print(tonumber("10"), tonumber("10.0"), tonumber(" 10 "), tonumber("1e2"), tonumber("0x1F"), tonumber("-0x10"))
print(tonumber("10", 2), tonumber("777", 8), tonumber("zz", 36), tonumber("12", 2), math.type(tonumber("3")))''')
c("string_concat_and_len", '''
local t = {}
for i = 1, 5 do t[#t + 1] = i end
print(table.concat(t, ", "), #t, #"abc" + #"", "a" .. "b" .. "c" .. 1 .. 2.0)
print(pcall(function() return "a" .. nil end))
print(pcall(function() return "a" .. {} end))''')
c("utf8_lib", '''
print(utf8.char(72, 228, 8364, 128512), utf8.len("häll€"), #"häll€")
for p, c in utf8.codes("aé€") do io.write(p, ":", c, " ") end print()
print(utf8.codepoint("héllo", 1, -1))
print(utf8.offset("aé€b", 3), utf8.offset("aé€b", -1), utf8.len("\\xff"), utf8.charpattern)''')

# ---------------- tables
c("table_constructors", '''
local t = {1, 2, 3, x = "a", ["y z"] = "b", [10] = "ten", 4; 5}
print(#t, t[4], t[5], t.x, t["y z"], t[10], t[11])
local u = {[1] = "a", "b"}
print(u[1])
local function three() return 1, 2, 3 end
local v = {three(), three()}
print(#v, v[1], v[2], v[4])
local w = {three(), (three())}
print(#w)''')
c("table_insert_remove", '''
local t = {}
table.insert(t, "a"); table.insert(t, "c"); table.insert(t, 2, "b"); table.insert(t, 1, "z")
print(table.concat(t, ","), #t)
print(table.remove(t), table.remove(t, 1), table.concat(t, ","), table.remove({}), #t)
print(pcall(table.insert, t, 5, "x"))
print(pcall(table.insert, nil, 1))''')
c("table_sort", '''
local t = {5, 2, 8, 1, 9, 3}
table.sort(t) print(table.concat(t, " "))
table.sort(t, function(a, b) return a > b end) print(table.concat(t, " "))
local words = {"banana", "Apple", "cherry", "apple"}
table.sort(words) print(table.concat(words, " "))
local people = {{n = "a", age = 30}, {n = "b", age = 20}, {n = "c", age = 25}}
table.sort(people, function(x, y) return x.age < y.age end)
for _, p in ipairs(people) do io.write(p.n) end print()
print(pcall(table.sort, {3, "a", 1}))''')
c("table_concat_unpack_pack_move", '''
print(table.concat({1, 2, 3}), table.concat({"a", "b"}, "-", 2), table.concat({}, "x"), table.concat({1, 2, 3}, "", 2, 3))
print(table.unpack({1, 2, 3})); print(table.unpack({1, 2, 3}, 2)); print(table.unpack({1, nil, 3}, 1, 3))
local p = table.pack(1, nil, 3) print(p.n, p[1], p[2], p[3])
local a = table.move({1, 2, 3}, 1, 3, 2) print(table.concat(a, ","))
local b = table.move({1, 2, 3}, 1, 3, 1, {}) print(#b)
print(pcall(table.concat, {1, {}, 3}))''')
c("length_with_border", '''
local t = {1, 2, 3}
t[#t + 1] = 4
print(#t)
t[#t] = nil
print(#t)
local s = setmetatable({}, {__len = function() return 42 end})
print(#s, rawlen({1, 2}), rawlen("abc"))''')
c("ipairs_pairs_next", '''
local t = {10, 20, nil, 40}
for i, v in ipairs(t) do io.write(i, "=", v, " ") end print()
local keys = {}
for k in pairs({a = 1, b = 2, c = 3}) do keys[#keys + 1] = k end
table.sort(keys) print(table.concat(keys))
print(next({}), next({5}))
local m = setmetatable({}, {__pairs = function(t) return function(_, k) if not k then return 1, "one" end end, t, nil end})
for k, v in pairs(m) do print(k, v) end''')

# ---------------- functions and closures
c("varargs", '''
local function f(...)
  local a, b = ...
  print(select("#", ...), a, b, select(2, ...))
  local t = {...}
  return #t, ...
end
print(f(1, nil, 3))
print(f())
print(select(-1, "a", "b", "c"), select("#"), pcall(select, 0, 1))''')
c("multiple_returns_adjust", '''
local function mr() return 1, 2, 3 end
local a, b, c, d = mr()
print(a, b, c, d)
local x, y = mr(), 10
print(x, y)
print(mr(), mr())
print((mr()))
local t = {mr(), mr()}
print(#t)''')
c("closures_counter", '''
local function counter()
  local n = 0
  return function() n = n + 1 return n end, function() return n end
end
local inc, get = counter()
inc() inc()
local inc2 = counter()
inc2()
print(get(), inc(), inc2())
local fs = {}
for i = 1, 3 do fs[i] = function() return i end end
print(fs[1](), fs[2](), fs[3]())
local j = 0
local gs = {}
while j < 3 do j = j + 1; local k = j; gs[j] = function() return k end end
print(gs[1](), gs[3]())''')
c("recursion_and_tailcalls", '''
local function fact(n) if n <= 1 then return 1 end return n * fact(n - 1) end
print(fact(20), fact(21))
local function loop(n, acc) if n == 0 then return acc end return loop(n - 1, acc + 1) end
print(loop(100000, 0))
local function ack(m, n) if m == 0 then return n + 1 elseif n == 0 then return ack(m - 1, 1) else return ack(m - 1, ack(m, n - 1)) end end
print(ack(2, 3))''')
c("methods_and_self", '''
local Account = {}
Account.__index = Account
function Account.new(b) return setmetatable({balance = b}, Account) end
function Account:deposit(v) self.balance = self.balance + v return self end
function Account:get() return self.balance end
local a = Account.new(100)
print(a:deposit(50):deposit(25):get(), Account.get(a), a.balance)''')
c("upvalues_shared", '''
local function make()
  local x = 0
  local function add(n) x = x + n end
  local function get() return x end
  return add, get
end
local add, get = make()
add(5) add(7)
print(get())''')

# ---------------- control flow
c("if_elseif", '''
for _, v in ipairs({-1, 0, 1, 10}) do
  if v < 0 then print("neg") elseif v == 0 then print("zero") elseif v < 5 then print("small") else print("big") end
end
print(nil and 1, false or "d", 1 and 2, nil or false, 0 and "zero is true", "" and "empty is true")''')
c("numeric_for", '''
for i = 1, 3 do io.write(i, " ") end print()
for i = 10, 1, -3 do io.write(i, " ") end print()
for i = 1, 0 do io.write("never") end
for i = 1.0, 2.0, 0.5 do io.write(i, " ") end print()
for i = math.maxinteger - 2, math.maxinteger do io.write(i, " ") end print()
print(pcall(function() for i = 1, 10, 0 do end end))
local n = 0 for i = 1, 3 do local i = i * 2 n = n + i end print(n)''')
c("while_repeat_break", '''
local i = 0
while true do i = i + 1 if i > 5 then break end end
print(i)
local j = 0
repeat local k = j j = j + 1 until k >= 3
print(j)
for x = 1, 3 do for y = 1, 3 do if y == 2 then break end io.write(x, y, " ") end end print()''')
c("goto_continue", '''
for i = 1, 5 do
  if i % 2 == 0 then goto continue end
  io.write(i, " ")
  ::continue::
end
print()
do
  local k = 1
  ::top::
  k = k + 1
  if k < 4 then goto top end
  print(k)
end''')
c("do_blocks_scope", '''
local x = 1
do local x = 2 print(x) end
print(x)
local y <const> = 5
print(y)''')

# ---------------- metatables
c("metatable_arith", '''
local V = {}
V.__index = V
local function vec(x, y) return setmetatable({x = x, y = y}, V) end
V.__add = function(a, b) return vec(a.x + b.x, a.y + b.y) end
V.__sub = function(a, b) return vec(a.x - b.x, a.y - b.y) end
V.__mul = function(a, b) if type(a) == "number" then return vec(a * b.x, a * b.y) end return vec(a.x * b, a.y * b) end
V.__unm = function(a) return vec(-a.x, -a.y) end
V.__eq = function(a, b) return a.x == b.x and a.y == b.y end
V.__lt = function(a, b) return a.x < b.x end
V.__le = function(a, b) return a.x <= b.x end
V.__tostring = function(a) return "(" .. a.x .. "," .. a.y .. ")" end
V.__concat = function(a, b) return tostring(a) .. "&" .. tostring(b) end
V.__len = function(a) return 2 end
V.__call = function(self, k) return self[k] end
V.__idiv = function(a, b) return "idiv" end
V.__mod = function(a, b) return "mod" end
V.__pow = function(a, b) return "pow" end
V.__div = function(a, b) return "div" end
V.__band = function(a, b) return "band" end
V.__shl = function(a, b) return "shl" end
V.__bnot = function(a) return "bnot" end
local a, b = vec(1, 2), vec(3, 4)
print(tostring(a + b), tostring(a - b), tostring(2 * a), tostring(a * 3), tostring(-a))
print(a == vec(1, 2), a ~= b, a < b, a <= b, a > b, #a, a("x"), a .. b, a .. "s")
print(a // b, a % 1, 2 ^ a, a / a, a & 1, 1 << a, ~a)''')
c("index_newindex", '''
local defaults = {color = "red", size = 1}
local t = setmetatable({}, {__index = defaults})
print(t.color, t.size, t.other, rawget(t, "color"))
local log = {}
local proxy = setmetatable({}, {__index = function(_, k) return k .. "!" end, __newindex = function(t, k, v) rawset(t, k, v * 2); log[#log + 1] = k end})
proxy.a = 5
print(proxy.a, proxy.b, table.concat(log, ","))
local chain = setmetatable({}, {__index = setmetatable({}, {__index = {deep = "found"}})})
print(chain.deep)
local ro = setmetatable({}, {__newindex = function() error("read-only table", 2) end})
print(pcall(function() ro.x = 1 end))''')
c("metatable_protection", '''
local t = setmetatable({}, {__metatable = "locked"})
print(getmetatable(t), pcall(setmetatable, t, {}))
print(getmetatable("abc").__index == string, ("x"):upper())''')
c("inheritance", '''
local Animal = {} Animal.__index = Animal
function Animal.new(name, sound) local self = setmetatable({}, Animal) self.name = name self.sound = sound return self end
function Animal:speak() return self.name .. " says " .. self.sound end
local Dog = setmetatable({}, {__index = Animal}) Dog.__index = Dog
function Dog.new(name) local self = Animal.new(name, "woof") return setmetatable(self, Dog) end
function Dog:fetch() return self.name .. " fetches" end
local d = Dog.new("Rex")
print(d:speak(), d:fetch(), getmetatable(d) == Dog)''')
c("eq_only_same_types", '''
local mt = {__eq = function() return true end}
local a, b = setmetatable({}, mt), setmetatable({}, mt)
print(a == b, a == 1, rawequal(a, b), a ~= b)''')
c("close_variables", '''
do
  local x <close> = setmetatable({}, {__close = function(o, e) print("closing x", e) end})
  local y <close> = setmetatable({}, {__close = function(o, e) print("closing y", e) end})
  print("in block")
end
print(pcall(function()
  local z <close> = setmetatable({}, {__close = function(o, e) print("closing z with", e) end})
  error("boom")
end))''')

# ---------------- errors
c("error_values_and_levels", '''
print(pcall(error, "msg"))
print(pcall(error, "msg", 0))
local ok, e = pcall(error, {code = 42}) print(ok, type(e), e.code)
print(select(2, pcall(error)))
local function f() error("deep", 2) end
local function g() f() end
print(pcall(g))
print(pcall(function() error("lvl1") end))''')
c("runtime_error_messages", '''
local t = nil
print(pcall(function() return t.x end))
print(pcall(function() local a = {} return a.b.c end))
print(pcall(function() undefinedfn() end))
print(pcall(function() local s = "x" return s + 1 end))
print(pcall(function() return #nil end))
print(pcall(function() return {} .. "x" end))
print(pcall(function() local q = {} q.f() end))
print(pcall(string.rep))
print(pcall(string.sub))
print(pcall(setmetatable, 1, {}))
print(pcall(ipairs))''')
c("xpcall_handler", '''
print(xpcall(function() error("oops") end, function(m) return "handled: " .. m end))
print(xpcall(function(a, b) return a + b end, print, 3, 4))
print(xpcall(function() local x = nil; return x.y end, function(m) return (m:gsub("^.-:%d+: ", "")) end))''')
c("assert_forms", '''
print(pcall(assert, false))
print(pcall(assert, nil, "custom"))
print(pcall(assert, 1 == 1, "unused"))
print(select("#", assert(1, 2, 3)))''')
c("uncaught_error_exit", '''
print("before")
local t = {}
t.x.y = 1''')
c("uncaught_error_object", '''
error(setmetatable({}, {__tostring = function() return "custom error object" end}))''')
c("syntax_error", '''
print("not reached")
local x = = 1''')
c("os_exit_code", '''
print("bye")
os.exit(3)''')

# ---------------- coroutines
c("coroutine_basic", '''
local co = coroutine.create(function(a, b)
  print("start", a, b)
  local c = coroutine.yield(a + b)
  print("got", c)
  local d, e = coroutine.yield(c * 2)
  return d + e
end)
print(coroutine.resume(co, 1, 2))
print(coroutine.status(co))
print(coroutine.resume(co, 10))
print(coroutine.resume(co, 3, 4))
print(coroutine.status(co), coroutine.resume(co))''')
c("coroutine_wrap_generator", '''
local function range(n) return coroutine.wrap(function() for i = 1, n do coroutine.yield(i) end end) end
local s = 0 for i in range(10) do s = s + i end print(s)
local function perm(a, n, out)
  n = n or #a
  if n <= 1 then coroutine.yield(table.concat(a)) else
    for i = 1, n do a[n], a[i] = a[i], a[n]; perm(a, n - 1); a[n], a[i] = a[i], a[n] end
  end
end
local all = {}
for p in coroutine.wrap(function() perm({"a", "b", "c"}) end) do all[#all + 1] = p end
table.sort(all) print(table.concat(all, " "))''')
c("coroutine_errors_and_status", '''
local co = coroutine.create(function() error("inside") end)
print(coroutine.resume(co))
print(coroutine.status(co), coroutine.resume(co))
local th, main = coroutine.running() print(coroutine.isyieldable(), type(th), main)
local w = coroutine.wrap(function() error({1}) end)
local ok2, e2 = pcall(w) print(ok2, type(e2), e2[1])
local co2 = coroutine.create(function() print(coroutine.isyieldable(), coroutine.status(coroutine.running())) end)
coroutine.resume(co2)
local co3 = coroutine.create(function() coroutine.yield() end)
coroutine.resume(co3)
print(coroutine.close(co3), coroutine.status(co3))''')
c("producer_consumer", '''
local producer = coroutine.create(function()
  for _, item in ipairs({"a", "b", "c"}) do coroutine.yield(item) end
  return "done"
end)
while true do
  local ok, v = coroutine.resume(producer)
  if coroutine.status(producer) == "dead" then print("final", v) break end
  print("consumed", v)
end''')

# ---------------- load and environments
c("load_chunks", '''
local f = load("return 1 + 2") print(f())
local g = load("local a, b = ... return a * b") print(g(6, 7))
print(load("syntax error here"))
local env = {print = print, x = 99}
local h = load("x = x + 1 return x", "chunk", "t", env) print(h(), env.x, x)
local parts = {"return ", "4", "2"}
local i = 0
print(load(function() i = i + 1 return parts[i] end)())''')
c("global_env", '''
x = 10
print(_G.x, _G._G == _G)
_G.y = 20
print(y)
local _ENV = {print = print}
z = 5
print(z)''')

# ---------------- io
c("io_read_formats", '''
local n = io.read("n")
local rest = io.read("l")
local line = io.read("L")
local num2 = io.read("n")
local all = io.read("a")
print(n, math.type(n), "[" .. rest .. "]", line, num2, #all)
print(io.read("l"), io.read("a"))''', stdin="42 tail\nsecond line\n3.5\nremaining\ntext\n")
c("io_lines_and_write", '''
local total, count = 0, 0
for line in io.lines() do count = count + 1 total = total + tonumber(line:match("%d+")) end
io.write("lines: ", count, ", sum: ", total, "\\n")
io.write(1, " ", 2.5, "\\n")''', stdin="a 10\nb 20\nc 30\n")
c("args_table", '''
print(#arg, arg[1], arg[2], arg[0])
print(...)''', args=["first", "second arg"])

# ---------------- bigger programs
c("json_like_serializer", '''
local function ser(v, ind)
  ind = ind or ""
  local t = type(v)
  if t == "table" then
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local out = {}
    for _, k in ipairs(keys) do out[#out + 1] = ind .. "  " .. tostring(k) .. ": " .. ser(v[k], ind .. "  ") end
    return "{\\n" .. table.concat(out, ",\\n") .. "\\n" .. ind .. "}"
  elseif t == "string" then return string.format("%q", v)
  else return tostring(v) end
end
print(ser({name = "x", list = {1, 2, {a = true}}, n = 1.5, z = false}))''')
c("sieve_primes", '''
local N = 200
local is = {}
for i = 2, N do is[i] = true end
for i = 2, math.floor(math.sqrt(N)) do if is[i] then for j = i * i, N, i do is[j] = false end end end
local out = {}
for i = 2, N do if is[i] then out[#out + 1] = i end end
print(#out, table.concat(out, " ", 1, 15), out[#out])''')
c("string_builder_wordcount", '''
local text = [[the quick brown fox jumps over the lazy dog the fox]]
local counts = {}
for w in text:gmatch("%a+") do counts[w] = (counts[w] or 0) + 1 end
local words = {}
for w, n in pairs(counts) do words[#words + 1] = {w = w, n = n} end
table.sort(words, function(a, b) if a.n ~= b.n then return a.n > b.n end return a.w < b.w end)
for i = 1, 4 do io.write(words[i].w, "=", words[i].n, " ") end print()''')
c("queue_class_and_errors", '''
local Queue = {}
Queue.__index = Queue
function Queue.new() return setmetatable({first = 1, last = 0, items = {}}, Queue) end
function Queue:push(v) self.last = self.last + 1 self.items[self.last] = v end
function Queue:pop()
  if self.first > self.last then error("queue is empty", 2) end
  local v = self.items[self.first]; self.items[self.first] = nil; self.first = self.first + 1; return v
end
local q = Queue.new()
for i = 1, 3 do q:push(i * i) end
print(q:pop(), q:pop(), q:pop())
print(pcall(q.pop, q))
print(pcall(function() return q:pop() end))''')
c("memoize_and_varargs_key", '''
local function memoize(f)
  local cache = {}
  return function(...)
    local key = table.concat({...}, ",")
    if cache[key] == nil then cache[key] = f(...) end
    return cache[key]
  end
end
local calls = 0
local slow = memoize(function(a, b) calls = calls + 1 return a ^ b end)
print(slow(2, 10), slow(2, 10), slow(3, 2), calls)''')
c("matrix_multiply", '''
local function mat(n) local m = {} for i = 1, n do m[i] = {} for j = 1, n do m[i][j] = i + j end end return m end
local function mul(a, b)
  local n, c = #a, {}
  for i = 1, n do c[i] = {} for j = 1, n do local s = 0 for k = 1, n do s = s + a[i][k] * b[k][j] end c[i][j] = s end end
  return c
end
local c = mul(mat(4), mat(4))
for i = 1, 4 do print(table.concat(c[i], " ")) end''')
c("gsub_template_engine", '''
local tpl = "Dear ${name}, you owe ${amount} (${missing})."
local vars = {name = "Bob", amount = string.format("%.2f", 12.5)}
print((tpl:gsub("%${(%w+)}", function(k) return vars[k] end)))
local csv = "a,b,,d"
local fields = {}
for f in (csv .. ","):gmatch("([^,]*),") do fields[#fields + 1] = "<" .. f .. ">" end
print(table.concat(fields), #fields)''')
c("integer_float_keys", '''
local t = {}
t[1] = "int"; t[1.0] = "float overwrites"; t[2.5] = "real"
print(t[1], #t, t[2.5])
t["1"] = "string key"
print(t[1], t["1"])
print(pcall(function() t[0/0] = 1 end))
print(pcall(function() t[nil] = 1 end))''')
