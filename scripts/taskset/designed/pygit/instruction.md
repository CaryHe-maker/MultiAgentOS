# pygit 规格：用 Python 实现 git 的核心

在当前目录从零实现一个与 git 兼容的版本控制工具（"实现一个简易 Git"的课程设计）。只用 Python 3 标准库，不安装任何包；**不得调用任何外部程序**（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`），尤其不得调用 git。包名 `pygit`，命令为：

```
python3 -m pygit <命令> [参数...]
```

在当前工作目录（或其上层目录中最近的含 `.git` 的目录）所在的仓库上工作。**兼容的标准是容器里的 `git`（`/usr/bin/git`）**：仓库格式（`.git` 目录、对象、索引文件 `index`、引用）必须与 git 互通——pygit 建的仓库 git 能直接使用且 `git fsck --strict` 无错，git 建的仓库 pygit 能直接使用（包括 `git gc` 之后的打包对象）。下面各命令的行为与输出要与 git 相同（"与 git 相同"指在相同的仓库状态、相同的环境变量下，输出逐字节相同，除非另有说明）。

## 1. 环境

- 作者与提交者取自环境变量 `GIT_AUTHOR_NAME`、`GIT_AUTHOR_EMAIL`、`GIT_AUTHOR_DATE`、`GIT_COMMITTER_NAME`、`GIT_COMMITTER_EMAIL`、`GIT_COMMITTER_DATE`；日期格式为 `<Unix 秒> <时区>`（如 `1700000000 +0800`）。评测时这些变量都会给出。
- 不读取任何 git 配置文件；行为等同于 git 在 `init.defaultBranch=main`、`core.autocrlf=false`、`core.filemode=true` 下的行为。
- 文件只有普通文件、可执行文件（mode `100755`）和目录；不考虑符号链接与子模块。

## 2. 命令

1. `init`：建立 `.git`，HEAD 指向 `refs/heads/main`；输出与 `git init` 相同（`Initialized empty Git repository in <绝对路径>/.git/`）。已是仓库时输出 `Reinitialized existing Git repository in ...`。
2. `hash-object [-w] <文件>`、`cat-file (-t|-s|-p) <对象>`、`write-tree`：与 git 相同（`cat-file -p` 对树对象的输出格式为 `<mode> <type> <sha>\t<name>`，目录的 mode 写作 `040000`）。
3. `add <路径>...`（文件、目录、`.`）：把文件加入索引；目录递归；遵守工作区中各级 `.gitignore`（支持空行、`#` 注释、`*`、`?`、`[...]`、`**`、开头的 `/`、结尾的 `/`、开头的 `!` 取反）。已跟踪但已删除的文件在 `add` 它所在目录时从索引中删除。路径不存在且不在索引中：输出 `fatal: pathspec '<路径>' did not match any files`，退出码 128。
4. `rm [--cached] <路径>...`：与 git 相同（不需要 `-r`）。
5. `commit -m <消息>`：用索引生成树与提交；**只要求输出的第一行与 git 相同**（如 `[main (root-commit) 1a2b3c4] 消息`）。没有可提交的改动时退出码为 1（不要求输出相同）。合并冲突解决后（存在 `MERGE_HEAD`）的提交有两个父提交，然后删除 `MERGE_HEAD`。
6. `status --porcelain`：与 `git status --porcelain` 相同（未跟踪的目录折叠为 `?? 目录/`；不要求重命名检测）。
7. `log [--oneline] [-n <N>] [<起点>]`：与 git 相同（缺省格式包括 `Merge:` 行与日期 `Date:   Tue Nov 14 22:13:20 2023 +0800` 这样的写法，日期按提交中记录的时区显示）。
8. `branch`（列出）、`branch <名> [<起点>]`、`branch -d <名>`：与 git 相同；`-d` 删除尚未合并进 HEAD 的分支时报错（退出码 1，消息不要求相同）。
9. `checkout <分支>`、`checkout -b <名> [<起点>]`、`checkout <提交>`（分离 HEAD）：更新 HEAD、索引与工作区。如果会覆盖未提交的修改，报错（退出码 1）且什么也不改。只要求退出码与执行后仓库、索引、工作区的状态与 git 相同，不要求输出相同。
10. `merge <分支或提交>`：快进时更新分支与工作区；已包含时什么也不做；否则三方合并：按文件合并，同一文件两边都改了的，按行做三方合并（两边的改动不重叠则自动合并，重叠则写入冲突标记 `<<<<<<< HEAD` / `=======` / `>>>>>>> <分支名>`，写入 `MERGE_HEAD`，退出码 1）。没有冲突时自动生成合并提交，消息为 `Merge branch '<分支名>'`（当前分支不是 `main` 时为 `Merge branch '<分支名>' into <当前分支>`）。只要求合并后的树、冲突文件的内容、提交的父提交与消息、退出码与 git 相同，不要求输出相同。
11. `tag <名> [<提交>]`（轻量标签）、`tag -a <名> -m <消息> [<提交>]`（附注标签，标签者取提交者变量）、`tag`（列出）：与 git 相同。
12. `rev-parse <版本>`：支持 `HEAD`、分支名、标签名（附注标签给出标签对象本身）、完整 SHA 与至少 4 位的唯一前缀、`<版本>^`、`<版本>^<n>`、`<版本>~<n>` 及其组合；与 git 相同。
13. `ls-files [-s]`、`ls-tree [-r] <树或提交>`：与 git 相同。
14. `reset [--soft|--mixed|--hard] [<提交>]`：与 git 相同（只要求执行后的状态相同）。
15. `diff --name-status [--cached] [<提交>]`：与 git 相同（不要求重命名检测）。

未列出的命令与选项不要求支持。

## 3. 性能

在 2 个 CPU 的机器上：2000 个文件的 `add .` 加 `commit` 在 15 秒内完成；之后 `status --porcelain` 在 3 秒内返回。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法与支持的命令；`docs/design.md`：对象、索引、引用与打包文件的格式，合并算法。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库；pygit 的测试仓库不要放在当前目录里）。
