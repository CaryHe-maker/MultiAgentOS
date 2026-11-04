# MultiAgentOS M2 Kernel.Supervisor

> 状态：已评审（阶段 2）。阶段 3 补充 bwrap、遮蔽、进程组与停止升级。

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

## 5. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 2 | 第 3、4 节 |
| 3 | bwrap、SandboxProfile、遮蔽、进程组、SIGKILL 升级、`STOP_UNCONFIRMED` |
