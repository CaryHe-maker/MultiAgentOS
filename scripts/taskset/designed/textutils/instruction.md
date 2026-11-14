# textutils 规格：GNU 文本处理工具集

在当前目录从零实现一组与 GNU 版本兼容的文本处理命令行工具（"Linux 系统编程"课程设计）。只用 Python 3 标准库，不安装任何包；不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`）。运行环境没有外网。包名 `textutils`，用法：

```
python3 -m textutils <工具> [选项...] [文件...]
```

没有文件参数或文件为 `-` 时读标准输入。**标准输出、写到的文件与退出码与本机的 GNU 工具相同**（GNU coreutils 9.x、GNU grep 3.x、GNU sed 4.9，`LC_ALL=C`）；出错时在 stderr 输出说明（内容不要求相同）。要实现的工具与选项：

- `grep`：基本正则（BRE，缺省）、`-E`（ERE）、`-F`；`-i -v -c -n -o -w -x -l -L -h -H -q -s -m N -A N -B N -C N -e PAT（可多个） -f FILE -r`（递归目录，按文件名排序输出不作要求时评测会排序）；多文件时的文件名前缀与 `--` 分组分隔；退出码 0/1/2。
- `sed`：POSIX sed 的全部内容：地址（行号、`$`、`/正则/`、`\c正则c`、`first~step`、`addr1,addr2`、`addr,+N`、`0,/re/`、`!`）；命令 `s`（标志 `g p N i I w file`，替换中的 `&`、`\1`–`\9`、`\n`、`\L \U \l \u \E`）、`y`、`p P d D n N g G h H x b t T :label = l q Q a i c r w {}` 与 `;`/换行分隔；选项 `-n -e -f -E -r -s -i`（就地修改，含后缀）以及 `-z`。
- `sort`：`-n -r -u -f -b -d -g -h -M -V -s -t C -k POS1[,POS2]`（含字段内字符位置与每个键的修饰符）、`-o FILE`、`-c`；GNU 的最后比较（全行比较作为平局判定，`-s` 关闭）。
- `uniq`：`-c -d -u -i -f N -s N -w N`，以及输出文件参数。
- `cut`：`-b -c -f`（列表与区间）、`-d`、`-s`、`--complement`、`--output-delimiter`。
- `tr`：集合语法（区间、`[:class:]`、`[c*n]`、转义）、`-d -s -c -t` 及其组合。
- `wc`：`-l -w -c -m -L`，多文件时的合计行与对齐宽度。
- `head`、`tail`：`-n [-]N`、`-c [-]N`、`tail -n +N`，多文件时的标题行，`-q -v`。
- `join`：`-1 -2 -j -t -a -v -e -o`（含 `0` 与 `auto`），`-i`。
- `paste`：`-d`（循环分隔符与转义）、`-s`。
- `comm`：`-1 -2 -3`、`--output-delimiter`。
- `nl`：`-b a|t|n|pRE`、`-n ln|rn|rz`、`-w`、`-s`、`-v`、`-i`。
- `fold`：`-w -b -s`。
- `expand`：`-t N` 与制表位列表、`-i`。

## 性能

在 2 个 CPU 的机器上，对 50 万行的文件做 `sort -k2,2n`、`grep -c 正则`、`sed 's/a/b/g'`、`wc`，每项在 30 秒内完成。

## 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：正则（BRE/ERE 到 Python 正则的转换与差异）、sed 的执行模型、sort 的键比较。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
