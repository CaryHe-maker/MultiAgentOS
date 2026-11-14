# minipy 规格：用 Python 写的 Python 子集解释器

在当前目录从零实现一个 Python 语言子集的解释器（"编译原理"课程设计 / 毕业设计规模）：自己写词法分析（含缩进与 `INDENT`/`DEDENT`）、语法分析与求值（树遍历或自己的字节码）。只用 Python 3 标准库；**不得使用 `exec`、`eval`、`compile`、`__import__`、`importlib`、`ast`、`tokenize`、`token`、`codeop`、`code`、`dis`、`runpy`、`symtable`、`parser`**，不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`）。运行环境没有外网。包名 `minipy`。

## 1. 命令行

```
python3 -m minipy <脚本文件>
```

执行脚本。正常结束退出码 0。未捕获的异常：在 stderr 输出回溯（内容不限），**最后一行为 `<异常类名>: <消息>`**（与 CPython 相同；没有消息时只有类名），退出码 1。语法错误：stderr 最后一行以 `SyntaxError` 开头，退出码 1。

## 2. 要求

**标准输出、退出码与未捕获异常的最后一行与 CPython 3.12 执行同一脚本相同。** 要实现的子集：

- **词法与语法**：缩进块、续行（括号内与 `\`）、注释；整数（十进制、`0x 0o 0b`、下划线分隔）、浮点、字符串（单双引号、三引号、前缀 `r b f`、全部转义）、`True False None`；表达式的全部运算符与优先级（含 `**`、`//`、`@` 除外、位运算、比较链 `a < b < c`、`is`、`in`、`not in`、`and or not`、条件表达式、`lambda`、海象 `:=`）；下标与切片（含步长与负数、切片赋值与删除）；属性；调用（位置、关键字、`*args`、`**kwargs` 展开）。
- **语句**：赋值（多目标、元组与列表解包、带星号的解包、增量赋值）、`del`、`pass`、`if/elif/else`、`while/else`、`for/else`、`break`、`continue`、`return`、函数定义（默认值、`*args`、仅关键字参数、`**kwargs`、`/` 仅位置参数）、装饰器、`global`、`nonlocal`、闭包、`class`（单继承与多继承的 MRO、`super()`、类属性与实例属性、`@property`、`@staticmethod`、`@classmethod`、`__init__ __repr__ __str__ __eq__ __lt__ __le__ __gt__ __ge__ __hash__ __len__ __getitem__ __setitem__ __contains__ __iter__ __next__ __call__ __add__` 等算术与反向算术方法、`__bool__ __enter__ __exit__`）、`try/except/else/finally`（异常类层次、`except (A, B) as e`、`raise`、`raise ... from ...`、裸 `raise`、异常的 `args` 与自定义异常类）、`with`（多个上下文管理器）、`assert`、生成器（`yield`、`yield from`、生成器表达式、`send` 不要求）、推导式（列表、字典、集合，含多重 `for` 与 `if`）、`import math`、`from math import ...`（只要求 `math` 模块）。
- **类型与内置函数**：`int`（任意精度）`float bool str list tuple dict set frozenset range slice` 与 `NoneType`；它们的常用方法（`str` 的 `split join strip lstrip rstrip replace find index count startswith endswith upper lower title capitalize isdigit isalpha isspace zfill center ljust rjust format partition rsplit rfind swapcase expandtabs splitlines`，`list` 的 `append extend insert pop remove index count sort reverse copy clear`，`dict` 的 `get keys values items pop setdefault update copy clear fromkeys`，`set` 的 `add remove discard pop union intersection difference symmetric_difference issubset issuperset update` 与运算符）；内置函数 `print`（`sep end`）`len range enumerate zip map filter sorted reversed sum min max abs round divmod pow isinstance issubclass hasattr getattr setattr callable repr str int float bool list tuple dict set frozenset chr ord hex bin oct any all iter next type object super format hash id`（`id` 与 `hash` 的值不要求相同）；字符串格式化（`%` 运算、`str.format`、f-string 含格式说明 `:>10.2f`、`!r`、`=`）；`float` 的 `repr` 与 CPython 相同；内置异常 `Exception ValueError TypeError KeyError IndexError ZeroDivisionError AttributeError NameError StopIteration RuntimeError AssertionError NotImplementedError LookupError ArithmeticError OverflowError RecursionError` 及它们的标准消息（如 `division by zero`、`list index out of range`、`name 'x' is not defined`、`'int' object is not subscriptable`）。
- 不要求：`async`/`await`、`match` 语句、元类、`__slots__`、`exec` 一类、文件 I/O、除 `math` 外的模块、`global` 以外的作用域反射（`locals()` 等）。

## 3. 性能

在 2 个 CPU 的机器上：朴素递归的 `fib(22)`、对 2 万个整数的冒泡排序的前 2000 个元素、10 万次字典更新，各在 30 秒内完成。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法与支持的子集；`docs/design.md`：词法（缩进）、语法、作用域与闭包、对象模型与方法查找、异常与生成器的实现。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
