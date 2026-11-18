# mdhtml 规格：CommonMark Markdown 转 HTML

在当前目录从零实现一个完全符合 **CommonMark 规范 0.30**（<https://spec.commonmark.org/0.30/>）的 Markdown 到 HTML 转换器（"编译原理 / 文本处理"课程设计）。只用 Python 3 标准库，不安装任何包；不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`）。包名 `mdhtml`。

## 1. 接口

- 命令：`python3 -m mdhtml [文件]`：读入文件（缺省为标准输入，UTF-8），把 HTML 写到标准输出，退出码 0。
- 函数：`mdhtml.to_html(text: str) -> str`，结果与命令的输出相同。

## 2. 要求

- 输出与参考实现 `cmark` 0.30 在 `--unsafe` 选项下（原始 HTML 原样输出，不过滤危险链接）的输出**逐字节相同**；也就是规范中每个示例给出的 HTML。规范的全部内容都要实现：块结构（段落、标题两种写法、分隔线、代码块两种写法、HTML 块的七种开始条件、链接引用定义、块引用、列表与列表项及其松紧、空行规则）、行内结构（反斜杠转义、实体与数字字符引用、代码段、强调与加重的分隔符算法、链接与图片的全部形式、自动链接、原始 HTML、硬换行与软换行）、制表符的处理、以及 HTML 输出中的转义规则。
- 不要求任何扩展语法（表格、删除线等）。
- 评分除了规范中的示例，还包括把多个示例组合在一起的文档；结果与 `cmark --unsafe` 比较。
- 速度：1 MB 的普通文档在 10 秒内转换完成。

## 3. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：两阶段解析（块结构、行内结构）的设计与分隔符算法的实现。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
