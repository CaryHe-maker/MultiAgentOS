# pyregex 规格：与 Python `re` 兼容的正则表达式引擎

在当前目录从零实现一个正则表达式引擎（"算法设计 / 编译原理"课程设计）：模式的解析、编译（如回溯虚拟机或 NFA）与匹配，接口与语义与 **Python 3.12 的 `re` 模块**相同。只用 Python 3 标准库，**不得使用 `re`、`sre_compile`、`sre_parse`、`sre_constants`、`_sre` 以及间接依赖它们的模块（如 `fnmatch`、`glob`）**，不得调用外部程序。运行环境没有外网。包名 `pyregex`。

## 1. 接口

`import pyregex as R` 之后，以下内容的行为与 `re` 相同（结果值、异常类型、边界情况）：

- 函数：`compile search match fullmatch findall finditer sub subn split escape purge`；
- 标志：`I IGNORECASE M MULTILINE S DOTALL X VERBOSE A ASCII U UNICODE` 以及它们的按位组合；`R.error`（模式错误时抛出，是 `Exception` 的子类，带 `msg`、`pattern`、`pos` 属性；`msg` 的内容不要求相同）；
- `Pattern` 对象：`search match fullmatch findall finditer sub subn split`（含 `pos`、`endpos` 参数）、`pattern flags groups groupindex`；
- `Match` 对象：`group`（多个参数与组名）、`__getitem__`、`groups`（含 `default`）、`groupdict`（含 `default`）、`start end span`（按组号或组名）、`expand`、`lastindex lastgroup re string pos endpos`。

## 2. 语法与语义

全部 Python 3.12 `re` 语法：字面量与转义（`\a \f \n \r \t \v \x.. \u.... \U........ \N{名称}` 与八进制）、`.`、`^ $ \A \Z \b \B`、字符类（区间、取反、`\d \D \s \S \w \W` 在类内外的含义，Unicode 与 `ASCII` 两种模式）、贪婪 / 非贪婪 / 占有量词（`* + ? {m} {m,} {,n} {m,n}` 及 `?` 与 `+` 后缀）、分组 `( )`、`(?: )`、命名组 `(?P<名>...)` 与反向引用 `\1`、`(?P=名)`、前瞻与后顾（定长）`(?= ) (?! ) (?<= ) (?<! )`、原子组 `(?> )`、条件 `(?(1)yes|no)`、`(?(名)...)`、内联标志 `(?i)` 与局部标志 `(?i:...)`、`(?-i:...)`、注释 `(?#...)`、`VERBOSE` 模式中的空白与注释。忽略大小写的匹配规则（含 Unicode 大小写对应）与 `re` 相同。

`sub` 与 `subn` 的替换模板（`\1`、`\g<1>`、`\g<名>`、转义）与函数替换；`split` 的捕获组与最大次数；`findall` 返回组的规则；空匹配与相邻匹配的处理（Python 3.7 起的规则）都与 `re` 相同。

## 3. 性能

在 2 个 CPU 的机器上：在 1 MB 的文本上做 `findall(r"\b\w+@\w+\.com\b")` 与 `sub(r"(\d+)", r"<\1>")`，各在 20 秒内完成。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：解析、编译与匹配算法、回溯与零宽断言、替换模板的实现。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
