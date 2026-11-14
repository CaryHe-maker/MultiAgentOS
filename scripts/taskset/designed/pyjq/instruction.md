# pyjq 规格：jq 1.7 的 Python 实现

在当前目录从零实现 JSON 处理语言 **jq 1.7**（<https://jqlang.github.io/jq/manual/v1.7/>）的解释器（"编译原理"课程设计 / 毕业设计规模）：词法、语法、基于生成器的求值（回溯、多结果）、路径表达式与赋值、以及完整的内置函数库。只用 Python 3 标准库，不安装任何包；不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`）。运行环境没有外网。包名 `pyjq`。

## 1. 命令行

```
python3 -m pyjq [选项...] <过滤器> [文件...]
```

支持的选项：`-n`（`--null-input`）、`-r`（`--raw-output`）、`-j`（`--join-output`）、`-a`（`--ascii-output`）、`-c`（`--compact-output`）、`-s`（`--slurp`）、`-R`（`--raw-input`）、`-S`（`--sort-keys`）、`-e`（`--exit-status`）、`--tab`、`--indent n`、`--arg 名 值`、`--argjson 名 JSON`、`--slurpfile 名 文件`、`--rawfile 名 文件`、`--args`、`--jsonargs`、`-f 文件`（从文件读过滤器）。输入为连续的 JSON 值（以空白分隔）。

## 2. 要求

**标准输出与退出码与参考实现 `jq` 1.7 相同**（错误消息写到 stderr，内容不要求相同，但退出码要相同：运行时错误为 5，语法错误为 3，`-e` 的规则与 jq 相同）。要实现：

- **语法**：`.`、`..`、`.foo`、`."foo"`、`.[n]`、`.[m:n]`、`.[]`、`?`、`,`、`|`、括号；字面量（数字、字符串及其插值 `\(...)` 与全部转义、`true false null`）；数组与对象构造（含 `{a, $x, "k": v, (expr): v, @base64: ...}` 等简写）；算术与比较运算符、`and or not`、`//`、`if-then-elif-else-end`（含省略 `else`）、`try-catch`、`reduce`、`foreach`（两种与三种参数）、`label $name | ... break $name`、变量 `as $x`（含解构 `as [$a, {b: $c}]` 与 `?//` 备选解构）、`def` 函数定义（含函数参数、`$` 参数、递归、闭包作用域）、注释、格式串 `@text @json @html @uri @csv @tsv @sh @base64 @base64d` 及与字符串插值的组合、`$__loc__`、`$ENV`、`env`。
- **路径与赋值**：`path(f)`、`paths`、`getpath`、`setpath`、`delpaths`、`del`、`to_entries`、`from_entries`、`with_entries`，赋值运算符 `=`、`|=`、`+= -= *= /= %= //=`（与 jq 1.7 相同的语义，包括 `|= empty`）。
- **内置函数**：`length utf8bytelength not keys keys_unsorted values has in map map_values select empty error add any all range floor ceil round sqrt pow log log2 log10 exp exp10 fabs tostring tonumber type infinite nan isinfinite isnan isnormal isvalid sort sort_by group_by unique unique_by min max min_by max_by reverse contains inside startswith endswith ltrimstr rtrimstr explode implode split join ascii_downcase ascii_upcase test match capture scan splits sub gsub recurse env transpose input inputs debug stderr input_filename first last nth until while repeat limit indices index rindex combinations walk splits tojson fromjson todate fromdate now mktime gmtime strftime strptime dateadd datesub date tostream fromstream truncate_stream getpath error halt halt_error builtins input_line_number significand pick have_literal_numbers`（不要求 `now` 的结果相同；正则使用 Oniguruma 的语法，评测只用与 Perl 兼容的常见部分）。
- **数值**：双精度浮点；数值的输出与 jq 1.7 相同——未参与运算的数字保留输入中的写法并以 jq 1.7 的规范形式输出（如 `1.000` 输出 `1.000`，`3e2` 输出 `3E+2`，大整数不丢精度），参与运算的结果按双精度的最短表示输出；整数值不带小数点。
- **输出格式**：缺省 2 个空格缩进的美化输出、`-c` 紧凑输出、`--tab`、`--indent`、`-S`、`-a` 与 jq 1.7 逐字节相同；对象保持键的插入顺序。

## 3. 性能

在 2 个 CPU 的机器上：对一个含 10 万个对象的数组做 `map(select(.v % 7 == 0)) | length` 与 `group_by(.g) | map({g: .[0].g, n: length})`，各在 20 秒内完成。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：解析、生成器求值与回溯、路径表达式、数值表示的设计。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
