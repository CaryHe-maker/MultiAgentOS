# pyawk 规格：POSIX awk 解释器

在当前目录从零实现一个 awk 解释器（"编译原理"课程设计），语言按 **POSIX awk**（IEEE Std 1003.1-2017 中的 awk 一节）。只用 Python 3 标准库，不安装任何包；不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`），因此不要求支持 `system()`、管道输出 `print | "cmd"` 与 `"cmd" | getline`。包名 `pyawk`。

## 1. 命令行

```
python3 -m pyawk [-F <分隔符>] [-v <变量>=<值>]... '<程序>' [<参数>...]
python3 -m pyawk [-F <分隔符>] [-v <变量>=<值>]... -f <程序文件> [-f <程序文件>]... [<参数>...]
```

参数是输入文件，或形如 `变量=值` 的赋值（在读到它的位置时执行）；`-` 表示标准输入；没有输入文件时读标准输入。

## 2. 行为

除下面说明的以外，**输出与退出码与 `gawk --posix`（gawk 5.2）相同**。要实现 POSIX awk 的全部内容，包括：

- 程序结构：`BEGIN`、`END`、模式（表达式、正则、范围 `p1, p2`）、动作；换行与分号的语法规则；注释；用 `\` 续行。
- 记录与字段：`$0`、`$n`（含对 `$0`、`NF` 与字段赋值后的重建）、`NF`、`NR`、`FNR`、`FILENAME`；`FS`（缺省的空白分隔、单个字符、正则）、`OFS`、`ORS`、`RS`（单个字符；`RS=""` 时的段落模式，此时换行也是字段分隔符）、`SUBSEP`、`CONVFMT`、`OFMT`、`ENVIRON`、`ARGC`、`ARGV`、`RSTART`、`RLENGTH`。
- 值与类型：数值、字符串与"数值字符串"（来自输入的字段、`getline`、`ARGV`、`ENVIRON`、`-v` 与命令行赋值、`split` 的结果）的比较规则；未初始化的值；数值转字符串（整数值直接输出，其他用 `CONVFMT`，输出时用 `OFMT`）。
- 表达式：全部运算符及其优先级与结合性（含 `^`、`^=`、自增自减、字符串连接、`in`、`~` 与 `!~`、条件表达式、`getline` 的各种写法与优先级）、正则表达式字面量与动态正则（POSIX ERE，包括字符类 `[[:alpha:]]` 等与区间 `{n,m}`）、转义序列。
- 语句：`if`/`else`、`while`、`do`/`while`、`for`（两种）、`break`、`continue`、`next`、`exit [表达式]`（在 `END` 之外调用时仍会执行 `END`）、`return`、`delete`（数组元素与整个数组）、`print` 与 `printf`（包括输出重定向 `>`、`>>`，以及 `close()`；`"/dev/stdout"`、`"/dev/stderr"` 视为标准输出、标准错误）、`getline`（`getline`、`getline 变量`、`getline < 文件`、`getline 变量 < 文件`）。
- 数组：关联数组、多维下标（`SUBSEP`）、`(i, j) in a`；数组作为函数参数按引用传递。`for (k in a)` 的遍历顺序不限（评测不依赖这个顺序）。
- 函数：用户定义函数（递归、多余的参数作为局部变量）；内置函数 `length`（含不带括号的写法）、`substr`、`index`、`split`、`sub`、`gsub`（替换串中的 `&` 与 `\\&`）、`match`、`sprintf`、`tolower`、`toupper`、`int`、`sqrt`、`exp`、`log`、`sin`、`cos`、`atan2`、`srand`。`rand()` 的结果不要求与 gawk 相同。
- `printf` 的全部转换（`%c %d %i %o %x %X %u %e %E %f %F %g %G %s %%`）与标志、宽度、精度（含 `*`）。
- 错误：语法错误时在 stderr 输出说明、退出码 1，且不执行任何动作；运行时的致命错误（如除以 0、负的字段下标）在 stderr 输出说明、退出码 2。错误消息的内容不要求与 gawk 相同。
- 只要求 POSIX 的内容，不要求 gawk 的扩展（如 `**`、`length(数组)`）。

## 3. 性能

在 2 个 CPU 的机器上，对 10 万行、每行 10 个字段的输入做按字段求和与数组统计的程序，在 15 秒内完成。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：词法（正则与除号的区分、换行规则）、语法分析、求值与类型转换的设计。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
