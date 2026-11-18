# pylua 规格：Lua 5.4 解释器

在当前目录从零实现一个 **Lua 5.4** 解释器（"编译原理"课程设计 / 毕业设计规模）：词法分析、语法分析、求值（树遍历或编译成自己的字节码均可），以及下面列出的标准库。只用 Python 3 标准库，不安装任何包；不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`）。运行环境没有外网。包名 `pylua`。

## 1. 命令行

```
python3 -m pylua <脚本文件> [参数...]
```

执行脚本；全局表 `arg` 中 `arg[0]` 为脚本名，`arg[1]`… 为参数。标准输入可由 `io.read` 读取。脚本运行结束退出码 0。未被捕获的错误：在 stderr 的第一行输出 `<程序名>: <错误消息>`（程序名部分不限，如 `lua:`；之后可有回溯，内容不限），退出码 1；评测比较第一行中冒号与空格之后的错误消息。语法错误同样输出 `lua: ` 开头的消息并以退出码 1 结束。

## 2. 要求

除下面说明的以外，**标准输出与退出码与参考实现 `lua5.4`（5.4.7）相同**。

- **语言**：Lua 5.4 参考手册（<https://www.lua.org/manual/5.4/>）第 2、3 章的全部内容：词法（长字符串与长注释、全部转义序列含 `\z`、`\x`、`\u{...}`、十进制转义、十六进制整数与浮点数含 `p` 指数）；值与类型；**整数与浮点数两种子类型**（64 位整数的回绕、`//` 与 `%` 的取整规则、浮点与整数的比较与转换、字符串到数值的自动转换）；位运算；全部运算符与优先级；局部变量与属性 `<const>`、`<close>`；多重赋值与多返回值、`...`；`goto` 与标签；数值 `for` 与泛型 `for`；闭包与上值；元表与全部元方法（`__index`、`__newindex`、`__call`、算术与位运算、`__eq`、`__lt`、`__le`、`__concat`、`__len`、`__unm`、`__close`、`__tostring`、`__name`、`__metatable`、`__pairs`）。
- **错误消息**：运行时错误的消息与 lua5.4 相同，包括位置前缀 `<脚本名>:<行号>:` 与变量描述（如 `attempt to index a nil value (local 'x')`、`attempt to call a nil value (global 'f')`、`attempt to perform arithmetic on a string value`、`bad argument #1 to 'insert' (table expected, got nil)`）。`error` 的 `level` 参数、`pcall`、`xpcall` 与消息处理函数。
- **标准库**：
  - 基础函数：`assert error getmetatable ipairs load next pairs pcall print rawequal rawget rawlen rawset select setmetatable tonumber tostring type xpcall`（`load` 只需支持字符串与函数形式的代码块及 `env` 参数）；
  - `string`：`byte char find format gmatch gsub len lower match rep reverse sub upper`，以及字符串的方法调用语法；**Lua 模式**的全部内容（字符类、`%b`、`%f`、捕获与位置捕获、锚点）；`string.format` 的全部转换（含 `%q`、`%a` 除外）；
  - `table`：`concat insert move pack remove sort unpack`；
  - `math`：`abs ceil exp floor fmod huge log max maxinteger min mininteger modf pi sqrt tointeger type ult sin cos tan asin acos atan`（`random` 与 `randomseed` 不要求与参考实现结果相同）；
  - `utf8`：`char charpattern codepoint codes len offset`；
  - `coroutine`：`close create isyieldable resume running status wrap yield`；
  - `io`：`write`，`read`（格式 `"l"`、`"L"`、`"n"`、`"a"` 与数字），`io.lines()`（标准输入）；`os`：`exit`、`getenv`。
- 不要求：`require` 与模块系统、`debug` 库、文件读写、`collectgarbage` 的结果（调用时返回 0 即可）、`__gc` 与弱表、`string.dump`、`string.pack` 系列。
- `tostring` 对表、函数等给出的地址，与 `pairs` 的遍历顺序，不要求与参考实现相同（评测不依赖它们）。

## 3. 性能

在 2 个 CPU 的机器上，计算 `fib(25)`（朴素递归）、对 10 万个整数做 `table.sort`、拼接 10 万个短字符串（`table.concat`），每项在 20 秒内完成。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：词法、语法、求值（含整数与浮点、元方法分派、协程的实现方式）与标准库的设计。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
