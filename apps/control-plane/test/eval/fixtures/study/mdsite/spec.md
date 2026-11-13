# mdsite 规格

用 Python 3 标准库实现静态博客生成器 `mdsite` 包，命令 `python3 -m mdsite build <源目录> <输出目录>`。

## 源目录

- `site.toml`：`title = "..."`、`base_url = "https://example.org"`（结尾没有 `/`）。
- `posts/*.md`：每篇文章。文件名去掉 `.md` 就是 slug。
- `templates/page.html`（可选）：页面模板，`{{ site_title }}`、`{{ title }}`、`{{ content }}` 三个占位符原样替换；没有这个文件时用内置模板（内容自定，但必须含这三项）。

## 文章头

文件以 `---` 开头的一行起，到下一行 `---` 止，每行 `键: 值`：

- `title`（必需）、`date`（必需，`YYYY-MM-DD`）、`tags`（可选，逗号分隔，去掉两端空格，统一小写）、`draft`（可选，`true` 时不生成这篇，也不出现在任何列表里）。
- 缺 title、缺 date 或 date 不是合法日期：命令以退出码 1 结束，stderr 写出出错的文件名，**输出目录里不写任何文件**。

## Markdown 子集：`mdsite.markdown.to_html(text) -> str`

块之间用一个换行 `\n` 连接，结果首尾没有空白。

- `#` 到 `######` 加一个空格开头的行：`<h1>…</h1>` 到 `<h6>…</h6>`。
- 以 `- ` 开头的连续行：一个 `<ul>`，每行一个 `<li>…</li>`，写成 `<ul><li>a</li><li>b</li></ul>`（中间没有换行）。
- 以 ` ``` ` 开头的行到下一个 ` ``` ` 行：`<pre><code>…</code></pre>`，里面的行按原样用 `\n` 连接，只做 HTML 转义，不做行内格式。
- 其余连续的非空行是一个段落：各行去掉首尾空白后用一个空格连接，`<p>…</p>`。空行分隔块。
- 行内（标题、列表项、段落里）：先把 `&`、`<`、`>` 转义为 `&amp;`、`&lt;`、`&gt;`，再处理 `` `code` `` → `<code>code</code>`（其中不再做其它行内格式）、`**粗**` → `<strong>粗</strong>`、`*斜*` → `<em>斜</em>`、`[文字](地址)` → `<a href="地址">文字</a>`。

例：

    to_html("# Hi\n\nSome *very* **bold** `a<b` text\nwith [a link](https://x.org).\n\n- one\n- two")
    == '<h1>Hi</h1>\n<p>Some <em>very</em> <strong>bold</strong> <code>a&lt;b</code> text with <a href="https://x.org">a link</a>.</p>\n<ul><li>one</li><li>two</li></ul>'

## 输出目录

- `posts/<slug>.html`：文章页（模板替换后的完整页面，`{{ content }}` 是 `to_html` 的结果）。
- `index.html`：所有文章，日期新的在前（同一天按 slug 排），每篇一行
  `<li><a href="posts/<slug>.html">标题</a> <time>YYYY-MM-DD</time></li>`，放在一个 `<ul>` 里。
- `tags/<tag>.html`：该标签的文章，格式同 index，但链接是 `../posts/<slug>.html`。
- `feed.xml`：RSS 2.0（`<rss version="2.0"><channel>`），channel 有 `title`、`link`（base_url）；最多 20 个 `item`，日期新的在前，每个有 `title`、`link`（`<base_url>/posts/<slug>.html`）、`pubDate`（当天 00:00 UTC，RFC 822 格式，如 `Tue, 05 May 2026 00:00:00 +0000`）。标题里的 `&` `<` `>` 要转义。
- 输出目录里原有的文件先清空再生成。

另外：`tests/` 下至少 15 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过；README.md 写明用法与文章格式。
