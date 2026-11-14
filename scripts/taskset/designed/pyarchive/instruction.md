# pyarchive 规格：tar、gzip、zip 归档与压缩工具

在当前目录从零实现与 GNU tar、GNU gzip、Info-ZIP zip/unzip 兼容的归档与压缩工具（"数据压缩 / 操作系统"课程设计）：**DEFLATE 压缩与解压（RFC 1951）、CRC-32、gzip 格式（RFC 1952）、zip 格式（PKWARE APPNOTE）、tar 格式（ustar、GNU、pax）**都要自己实现。只用 Python 3 标准库；**不得使用 `zlib`、`gzip`、`zipfile`、`tarfile`、`bz2`、`lzma`、`binascii.crc32`、`shutil` 的归档函数**，不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`）。运行环境没有外网。包名 `pyarchive`，用法：

```
python3 -m pyarchive <工具> [选项...] [参数...]        工具为 tar、gzip、gunzip、zip、unzip
```

## 1. tar

- `tar -c -f <归档> [-z] [-C <目录>] [--format=ustar|gnu|pax] [--mtime=@<秒>] [--owner=<n>] [--group=<n>] [--numeric-owner] [--sort=name] [--mode=<八进制>] <路径>...`：创建归档；目录递归；`-z` 时外面再套 gzip。
- `tar -t [-v] -f <归档>`、`tar -x [-v] -f <归档> [-C <目录>]`：列出、解开；自动识别 gzip 压缩的归档。`-x` 恢复文件内容、目录、权限位与修改时间；支持普通文件、目录、符号链接与硬链接；拒绝写出到解开目录之外的路径（`..` 与绝对路径按 GNU tar 的方式处理：去掉开头的 `/`，含 `..` 的成员跳过并报错）。
- **兼容性**：在 `--format=ustar` 或 `--format=gnu`、`--mtime=@<秒>`、`--owner=0 --group=0 --numeric-owner`、`--sort=name`、`--mode=` 都给出、且不用 `-z` 时，创建的归档与 GNU tar 1.35 相同选项下的输出**逐字节相同**（含记录块的填充）。`tar -tvf` 的输出与 GNU tar 的输出相同（`TZ=UTC`）。能正确读出 GNU tar 用 `ustar`、`gnu`（长文件名 `././@LongLink`）、`pax`（长文件名与扩展头）三种格式写的归档。
- 退出码：成功 0，有成员出错 2。

## 2. gzip

- `gzip [-c] [-d] [-k] [-f] [-n|-N] [-1..-9] [-t] [-l] [文件...]`、`gunzip`（等同 `gzip -d`）：与 GNU gzip 的行为相同（缺省压缩并删除原文件、生成 `.gz`；`-c` 写到标准输出；`-k` 保留原文件；`-d` 解压；`-t` 检查；`-l` 列出的格式与 GNU gzip 相同；没有文件时处理标准输入到标准输出）。
- 解压：任何合法的 gzip 数据（多个成员连接、FNAME/FCOMMENT/FEXTRA/FHCRC 字段、存储块、固定与动态 Huffman 块），校验 CRC-32 与长度，出错时报错并以退出码 1 结束。
- 压缩：输出必须是合法的 gzip 数据（GNU gzip 与其他实现都能解开），`-n` 时头部不含文件名与时间；**压缩率**：在评测给出的文本与二进制样本上，`-6` 的输出不大于 GNU `gzip -6` 输出的 1.10 倍，`-9` 不大于 `gzip -9` 的 1.10 倍，`-1` 不大于 `gzip -1` 的 1.25 倍。
- 速度：1 MB 文本在 `-6` 下压缩与解压各在 20 秒内完成。

## 3. zip 与 unzip

- `zip [-r] [-q] [-0..-9] [-j] <归档.zip> <路径>...`：创建或追加；目录递归（`-r`）；`-0` 为存储，其余为 deflate（与 Info-ZIP 一样，压缩后不变小的成员可以改为存储）。生成的归档能被 Info-ZIP `unzip` 与其他实现解开、校验通过，记录文件名、修改时间（DOS 时间）与 Unix 权限（外部属性）。
- `unzip [-l] [-t] [-o] [-q] [-d <目录>] <归档.zip> [成员...]`：列出（`-l` 的格式与 Info-ZIP unzip 6.0 相同）、检查、解开；支持存储与 deflate 两种方法、数据描述符（流式写入的归档）、目录成员、恢复 Unix 权限。
- 不要求：加密、zip64、其他压缩方法、注释的编辑。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：DEFLATE 编码（LZ77 匹配查找、Huffman 树构造与长度限制、块的划分）、解码、三种归档格式的读写。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
