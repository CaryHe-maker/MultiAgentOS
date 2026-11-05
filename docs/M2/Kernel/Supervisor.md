# MultiAgentOS M2 Kernel.Supervisor

> 状态：已评审（阶段 2）；阶段 3 的第 5、6 节为草稿，待评审。

## 1. 定位

Supervisor 是进程内唯一启动子进程的地方，按 `executionKind` 运行 Executor。
M1 的机制见归档的 [M1 Supervisor](../../History/M1/Kernel/Supervisor.md)，本文只写 M2 的变化。

## 2. 相对 M1 的变化

| M1 | M2 | 阶段 |
|---|---|---|
| 子进程只有 `rg` | 增加 `git`（影子仓库的快照与恢复） | 2 |
| 无写入 Executor | `FILE_WRITE`、`FILE_EDIT` 在进程内运行（M2Design 第 2.5 节） | 2 |
| — | bwrap、`cancelExecution`、`STOP_UNCONFIRMED` 停机 | 3 |

## 3. `git` 子进程（阶段 2）

- `SubprocessRunner.run` 的命令扩展为 `'rg' | 'git'`，并接受 `env` 与 `stdin`。`git` 的环境只含调用方给出的变量与 `PATH`，不继承其余环境。
- 只有 Execution 的快照使用 `git`；Executor 不能启动它。
- 输出超过上限、被信号终止或退出码非零时，调用方按快照失败处理，不重试。

## 4. 启动探测

组合根在启动 Supervisor 之前执行一次 `git --version`。失败时把启动预设降为 `readonly` 并提示用户（M2Design 第 4.6 节）。

## 5. 沙盒（阶段 3）

字段见 [Interface/KernelSupervisor](../Interface/KernelSupervisor.md)。Supervisor 只做三件事：把 `SandboxProfile` 变成 bwrap 的参数并启动、管理进程的生命周期、探测可用性。判断允许与否是 Core 的事，Supervisor 只校验批准的内容没有被换掉。

- **参数的构造是纯函数**（`buildBwrapArgs(profile, command)`），顺序固定，由测试逐项断言：`--unshare-pid`、`--unshare-ipc`、`--unshare-uts`、`--die-with-parent`、`--new-session`、`--json-status-fd`；`--clearenv` 后只设白名单中的变量；
  `--ro-bind / /` → `/run`、`/mnt`、`/media` 以空 `--tmpfs` 遮蔽（宿主的 docker.sock、会话总线、agent 套接字与 WSL 中的 Windows 盘；共享网络时 `/run/systemd/resolve` 与 `/mnt/wsl/resolv.conf` 只读挂回，保留域名解析；仓库在后面重新挂回，位于 `/mnt` 下也可用）→ `$HOME` 以 `--tmpfs` 遮蔽 → `--size`（缺省 512 MiB）限定大小的 `--tmpfs /tmp` → 白名单目录与 `PATH` 中位于 `$HOME` 之下的目录（`sandbox.mountPath`）只读挂回 → 凭据文件以空文件遮蔽 → 仓库只读挂回 → 可写根目录 `--bind` → `protectedExisting` 以 `--ro-bind` 重新挂载 → `.git/config` 以去掉凭据的副本只读覆盖（远程 URL 中的 `user:token@`、含 token、password、secret、authorization、extraheader 的配置行被去掉，其余设置不变；副本在命令结束后删除）→ `maskedFiles`、`maskedDirs` 遮蔽 → `dataDir` 遮蔽 → `--unshare-net`（`network = false`）。
  已验证的写法见 M2TechStack 第 3.1 节：遮蔽用空的普通文件而不是 `/dev/null`，`--tmpfs /tmp` 在仓库挂载之前。
- **资源限制**：命令经 `prlimit --nproc --fsize --data` 启动，`--data`（`RLIMIT_DATA`，私有可写内存，缺省为物理内存的一半）使一条把内存吃满的命令自己失败（`MemoryError`、`Cannot allocate memory`），而不是拖垮整机；V8 为堆预留的不可写地址空间不计入，所以 node 不受影响；进程数上限（缺省 2048；Linux 5.14 起按 bwrap 的用户命名空间计数，更早的内核加上该用户已有的进程数）与单文件大小上限（缺省 2 GiB）使 fork 炸弹和写满磁盘不会拖垮宿主；`/tmp` 的大小见上。
- **`git_inspect`** 的 `git` 经同一个 Supervisor 在只读 profile（`writableRoots` 为空、不联网）中运行，`.git/config` 里的 filter 等设置即使被触发也只能在沙盒内、只读地运行；没有沙盒可用时回退到原来的直接运行，固定参数与 `GIT_CONFIG_*` 不变。
- **环境变量**：白名单构造（`PATH`、`HOME`、`LANG`、`TERM`；`HOME` 为沙盒内的空目录）；构造后断言没有名称匹配 `*KEY*`、`*SECRET*`、`*TOKEN*`、`*PASSWORD*`、`*CREDENTIAL*` 的变量，否则拒绝启动并写审计。
- **进程**：以 `child-pid` 为内层进程组；停止的升级顺序见 M2Design 第 4.7 节。进程内的 Executor 没有 SIGKILL 一步。
- **输出**：stdout 与 stderr 合并读取，超过 `maxOutputBytes` 时保留头尾，其余丢弃并标记 `truncated`；Supervisor 不解释内容，只识别沙盒拒绝的固定文字（`Read-only file system`、`Network is unreachable`）并计数。
- **探测**：Session 开始时以真实 profile 运行 `/bin/true`；失败时按原因分类（没有 `bwrap`、命名空间被限制、profile 启动失败），并给出使用说明中的修复提示。
- **没有 `bwrap` 的平台**（如 Windows）：探测为 `NO_BWRAP`，按 `sandbox.unavailable` 处理。

## 6. 停机（阶段 3）

`STOP_UNCONFIRMED` 是系统故障：Execution 收到该事实后，经 Core 的 `reportSystemFault` 请求组合根停机（[SystemFaultHandling](../SystemFaultHandling.md)）。Supervisor 在停机时对全部子进程组发 SIGKILL。

## 7. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 2 | 第 3、4 节 |
| 3 | 第 5、6 节：bwrap、SandboxProfile、遮蔽、进程组、SIGKILL 升级、`STOP_UNCONFIRMED`、`cancelExecution` |
