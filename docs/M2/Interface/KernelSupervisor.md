# MultiAgentOS M2 接口：Kernel 内部的沙盒与执行取消

> 状态：草稿（阶段 3，待评审）。设计以 [M2Design](../M2Design.md) 第 4.7、5、6、7.6、7.7 节为准，本文只写字段与调用关系。
> 版本规则、命名与 Schema 清单见 [README](README.md)；发布版只有 major 1。

## 1. 范围

| 边界 | 内容 |
|---|---|
| Core → Execution → Supervisor | 命令的执行范围 `SandboxScope`、`ExecutionRequest` 的 `COMMAND` 与 `GIT_INSPECT` 两种、`cancelExecution` |
| Supervisor → Executor | `ExecutorEnvironment.sandbox`（`SandboxRunner`） |
| Monitor → Core | `MemoryPressure` 控制消息 |
| Core → Workflow | `RunInterrupted`（带原因）、`WrapUpReason = MEMORY_LIMIT`、`QUOTA_EXHAUSTED(quota = 'MEMORY')` |

## 2. SandboxProfile 与 SandboxScope

SandboxProfile 由 Core 在签发 `command.exec` 的 Lease 时计算，Execution 在派发前补上扫描得出的列表。模型、Workflow 与配置都不能选择或放宽它。

```ts
interface SandboxProfile {
  repositoryRoot: string;          // realpath
  workdir: string;                 // 相对仓库根目录，根目录为 ''；realpath 后必须在仓库内
  writableRoots: string[];         // 相对仓库根目录；main 为 ['']，worker 为 writeScope（阶段 4）
  network: boolean;                // 只有批准了 command.network 的那一条命令为 true
  homeReadOnly: string[];          // 以只读挂回的 $HOME 下的工具链与缓存目录（绝对路径；配置 kernel.sandboxHomeReadOnly）
  homeMaskedFiles: string[];       // 挂回目录中的凭据文件，以空文件遮蔽（绝对路径；缺省列表可追加、不可删除）
  dataDir?: string;                // 位于 $HOME 之外时单独以空 tmpfs 遮蔽
  // 以下由 Execution 派发前扫描得出，不属于用户看到并批准的内容：
  maskedFiles: string[];           // 命中 repositoryExclusions 的秘密类规则与 kernel.sandboxMaskedPatterns 的文件，相对仓库根目录
  maskedDirs: string[];
  protectedExisting: string[];     // 已存在的 .git/（任何位置）、.multiagentos/、任一目录中的 AGENTS.md（排除规则命中的目录除外）
}

type SandboxScope = {
  kind: 'SANDBOX';
  backend: 'BWRAP' | 'UNISOLATED';   // UNISOLATED 只在 sandbox.unavailable = 'ask-unisolated' 且用户逐条批准后出现
  profile: SandboxProfile;
  approvalDigest: string;            // 见第 3 节
};
```

`writableRoots` 与 Core 的第 ③ 步判定、文件工具使用同一个函数 `writableRoots(profile)`（contracts，阶段 2 的 `isWritable` 旁）；沙盒的 `--bind` 参数由它得出，三处使用同一份结果（不变量 5.4 的第 4 层）。

## 3. 批准绑定确切内容

```text
approvalDigest = sha256(canonicalJson({ command, workdir, network, writableRoots, backend }))
```

- Core 在询问时计算，询问展示这些内容；Lease 与 `SandboxScope` 带着它。
- Supervisor 启动进程之前，用 `ExecutionRequest` 中实际要执行的 `command`、`workdir` 与 profile 重新计算，不一致返回 `REJECTED(APPROVAL_MISMATCH)`，不启动。
- 启动前还要复查：工作目录仍然存在且 realpath 后在仓库内；每个可写根目录不是符号链接；名单（`deniedCommands`）再匹配一次（Supervisor 经注入的 `CommandAnalyzer`，与 Core 同一个实现）。

## 4. COMMAND

`ExecutionRequest.executionKind = 'COMMAND'`，`scope` 为 `SandboxScope`。

```ts
// executor.CommandInput（Workflow 填 command、workdir?、timeoutMs?、network?；模型看到的 RunCommandArgs 相同）
interface RunCommandArgs { command: string /* 1..8000 */; workdir?: string; timeoutMs?: number /* ≤ 600000 */; network?: boolean }

// kernel.execution.CommandExecutorInput（Core 补全后交给 Executor）
interface CommandExecutorInput { command: string; timeoutMs: number }

interface CommandOutput {
  exitCode: number | null;           // 被信号终止或超时时为 null
  signal: string | null;
  timedOut: boolean;
  backend: 'BWRAP' | 'UNISOLATED';
  sandboxDenials: number;            // 输出中识别出的沙盒拒绝（只读文件系统、网络不可达）的次数
}
```

- 预览保留输出的头与尾（stdout 与 stderr 合并，按产生顺序），超出上限时全文另存为完整输出（`maxFullOutputBytes`）。非零退出码、超时前已有的输出都是 OK 结果。
- 沙盒启动失败（`SANDBOX_UNAVAILABLE`）、`APPROVAL_MISMATCH`、环境变量断言失败（`ENV_ASSERTION_FAILED`，写审计）为 REJECTED；超时是 `TERMINATED(UNIT_TIMEOUT)`，Executor 交回已读到的输出。
- 受保护路径被命令新建（`.git`、`AGENTS.md`、`.multiagentos`）：Execution 在命令前后比较，新建的移入 `kernel-execution/quarantine/`，结果改为 `REJECTED(PROTECTED_PATH_CREATED)` 并写审计。

## 5. GIT_INSPECT

```ts
interface GitInspectArgs {
  action: 'status' | 'diff' | 'log' | 'show' | 'blame';
  staged?: boolean; path?: string; rev?: string; limit?: number /* log ≤ 50 */; lines?: string /* blame: "10,20" */;
}
```

固定子命令表；不接受任意参数。经 `SubprocessRunner` 以 `git` 运行（`--no-pager`、`--no-ext-diff`、`--no-textconv`、`-c core.hooksPath=/dev/null`、`-c core.fsmonitor=false`，`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`），
以 pathspec 排除 `repositoryExclusions` 命中的文件。`scope.kind` 为 `REPOSITORY`，能力 `repo.read`。

## 6. SandboxRunner（Supervisor → Executor）

```ts
interface SandboxRunner {
  run(options: {
    scope: SandboxScope; command: string; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal;
  }): Promise<{
    exitCode: number | null; signal: string | null; output: string; truncated: boolean;
    timedOut: boolean; denials: number;
  }>;
}
```

只有 `executionKind = 'COMMAND'` 的 Executor 拿到真实的 `SandboxRunner`，其余得到一个拒绝一切的实现。

**停止的升级**（M2Design 第 4.7 节）：`signal` 触发后，对 `--json-status-fd` 报告的 `child-pid` 的进程组发 SIGTERM；`cancelGraceMs` 后对外层进程组发 SIGKILL；再等 `killGraceMs`。仍无法确认已停止时，`run` 以特殊拒绝 `STOP_UNCONFIRMED` 结束，
Supervisor 上报 `ExecutionFact(STOP_UNCONFIRMED)`；Core 收到后经 `reportSystemFault` 停机。

**可用性探测**：Session 开始时以真实的 profile 运行一次 `/bin/true`（仓库根目录为工作目录）。结果 `SandboxProbe { available: boolean; backend; reason?: 'NO_BWRAP' | 'USERNS_DENIED' | 'PROFILE_FAILED'; hint?: string }` 写入 `SESSION_STARTED` 与审计。

## 7. cancelExecution

```ts
interface CancelExecutionRequest { executionId: ExecutionId; runEpoch: number; reason: 'PAUSED' | 'ABORTED' }
```

`SupervisorPort.cancelExecution`：对一个执行发出中止，停止升级同上；结果仍以 `ExecutionFact` 交付，被取消的执行为 `TERMINATED`，`reasonCode = EXECUTION_CANCELLED`；`reason` 随事实交回，Execution 据此形成 `INTERRUPTED(PAUSED | ABORTED)`（阶段 5 用 `PAUSED`）。`cancelRun` 保留，用于收敛。

## 8. 内存压力与中断

```ts
interface MemoryPressure { level: 'WARNING' | 'DANGER'; ratio: number; rss: number; heapRatio: number; availableBytes?: number }  // 控制消息，Monitor → Core
type InterruptReason = 'MEMORY_PRESSURE' /* 阶段 5 增加 USER_ABORT、TURN_TIMEOUT、PAUSE_TIMEOUT */;
RunInterrupted { workflowRunId; reason: InterruptReason }                      // Kernel → Workflow 事件
WrapUpReason += 'MEMORY_LIMIT';  QuotaKind += 'MEMORY';  RunReport / closeRun 原因 += 'INTERRUPTED'
```

Core 的处理见 [Core](../Kernel/Core.md) 第 5c 节。DANGER 时 Workflow 收到 `RunInterrupted` 后不再调用模型：它以确定性结果结束每个 ACTIVE 的 AgentRun（`INTERRUPTED` 报告），写 `closeRun(INTERRUPTED)`；
Core 在全部运行收敛后请求组合根按正常停机流程退出，退出码为 `75`（`EX_TEMPFAIL`，可恢复）。

## 9. 配置（`KernelConfig`）

| 配置 | 缺省 |
|---|---|
| `sandbox.unavailable` | `deny`（另一个值 `ask-unisolated`） |
| `sandbox.homeReadOnly` | `~/.nvm`、`~/.volta`、`~/.cargo`、`~/.rustup`、`~/.local/bin`、`~/.npm`（只挂回存在的） |
| `sandbox.mountPath` | `true`：`PATH` 中位于 `$HOME` 之下的目录也以只读挂回（规则见 M2Design 第 6.1 节）；纯函数 `pathToolchainMounts` |
| `sandbox.homeMaskedFiles` | `~/.cargo/credentials.toml`、`~/.npmrc`（可追加、不可删除） |
| `sandboxMaskedPatterns` | 空（可追加；与默认排除规则中的秘密类规则一起生效） |
| `command.deniedCommands` | 空 |
| `command.criticalCommands` | `git push`、`git remote`、`npm publish`、`pnpm publish`、`yarn publish`、`cargo publish`、`docker push`、`gh`（可追加，不可删除缺省项） |
| `killGraceMs` | 2000 |
| `memory.sampleIntervalMs` | 1000 |
| `memory.warningRatio`、`memory.dangerRatio` | 0.75、0.90 |
| `maxConcurrentExec` | 1 |
