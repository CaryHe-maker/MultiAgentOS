# MultiAgentOS M1 ExecutorSet

## 1. 定位

ExecutorSet 是静态库 `@multiagentos/executor-set`（目标位置 `packages/executor-set`），提供 M1 Unit 的原子执行行为。
每个 Executor 实现 [M1Interface](../M1Interface.md) 第 8 节的 `Executor` 接口，由 Supervisor 按 `executionKind`
装配并运行（见 [Supervisor](../Kernel/Supervisor.md)）。长期规划见 [ExecutorSet 架构](../../Architecture/Library/ExecutorSet.md)，
技术选择见 [M1TechStack](../M1TechStack.md) §8、§9。

Executor 只接收 Execution 解析后的输入与 Core 派生的范围约束，不持有 ArtifactStore、Lease、额度或运行状态，
不调用 Kernel、Workflow 或 UserInteraction。

## 2. Executor 清单

| executionKind | 实现 | 迁移来源 | scope.kind | 产物 |
|---|---|---|---|---|
| `REPOSITORY_ORIENT` | `RepositoryOrientExecutor` | `packages/context-engine` | `REPOSITORY` | ORIENT ContextPack |
| `REPOSITORY_SEARCH` | `RepositorySearchExecutor` | `packages/context-engine` | `REPOSITORY` | SEARCH ContextPack |
| `FILE_READ` | `FileReadExecutor` | `apps/executor` | `REPOSITORY` | 读取的文本 |
| `CONTEXT_ASSEMBLE` | `ContextAssembleExecutor` | `packages/context-engine` | `NONE` | ASSEMBLE ContextPack |
| `MODEL` | `ModelCallExecutor` | `packages/kernel` 中的 Provider 调用 | `MODEL` | `ModelRawOutput` |

`REPORT_PUBLISH` 不属于 ExecutorSet，由 Kernel 的 Execution 直接完成（见 [Execution](../Kernel/Execution.md) 第 5 节）。

包导出：

| 导出 | 用途 |
|---|---|
| `createExecutorRegistry(): ReadonlyMap<ExecutorKind, Executor>` | 组合根调用后把注册表注入 Supervisor；Kernel 包不导入 ExecutorSet |
| `DEFAULT_EXCLUSIONS` | 硬编码的危险文件规则（第 3.2 节），与 Core 的默认排除规则相同 |

## 3. 仓库访问

`REPOSITORY_ORIENT`、`REPOSITORY_SEARCH`、`FILE_READ` 共用以下规则，实现为同一个 `RepositoryAccess` 模块。

### 3.1 文件集合与快照

- 文件集合：仓库根目录（`scope.repositoryRoot`）下的全部普通文件；不跟随符号链接；排除命中 `scope.exclusions`
  或 `DEFAULT_EXCLUSIONS` 的路径；排除二进制文件（前 8 KiB 含 NUL 字节）。M1 不读取 `.gitignore`，也不调用 git。
- 文件数超过 `limits.maxFiles` 时返回 `REJECTED(LIMIT_EXCEEDED)`。
- 快照摘要：对文件集合按路径排序，取每个文件的 `{ path, size, sha256 }`，计算规范 JSON 的 SHA-256；
  `snapshotId = 'snp_' + 摘要`。同一内容的仓库得到相同的 `snapshotId`。
- 路径一律相对仓库根目录，使用 `/` 分隔。

### 3.2 路径检查

| 顺序 | 检查 | 不通过时 |
|---|---|---|
| 1 | `scope.kind` 为 `REPOSITORY` 且 `repositoryRoot` 为绝对路径 | `VIOLATION(SCOPE_MISSING)` |
| 2 | 输入路径为相对路径，不含 NUL，规范化后不含 `..` 段 | `REJECTED(OUT_OF_SCOPE)` |
| 3 | 命中 `DEFAULT_EXCLUSIONS` 或 `scope.exclusions` | `REJECTED(OUT_OF_SCOPE)` |
| 4 | 路径存在 | `REJECTED(NOT_FOUND)` |
| 5 | `realpath` 位于 `repositoryRoot` 内，且其相对路径同样不命中排除规则 | `REJECTED(OUT_OF_SCOPE)` |
| 6 | 是普通文本文件 | `REJECTED(UNSUPPORTED_FILE)` |
| 7 | 打开后，按文件描述符（`/proc/self/fd/<fd>`）取得的真实路径与第 5 步一致 | `VIOLATION(PATH_ESCAPE)` |

`DEFAULT_EXCLUSIONS` 为 `.git/**`、`**/.env*`、`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/id_dsa*`、`**/id_ecdsa*`、`**/id_ed25519*`、
`**/node_modules/**`。
这些规则硬编码在 Executor 中，是 Core 权限裁决之后的最后一道防线；Core 只能追加排除规则，不能删除它们。
防护逻辑自身出现不一致（例如规范化前后结果矛盾）时返回 `VIOLATION(GUARD_FAILURE)`。

### 3.3 检索

| mode | 方法 |
|---|---|
| `TEXT` | 固定字符串匹配 |
| `PATH` | 在文件集合的路径中做子串匹配 |
| `SYMBOL` | 正则匹配声明：`\b(function\|class\|interface\|type\|const\|let\|var\|def\|fn\|struct\|enum)\s+<转义后的查询>\b` |
| `AUTO` | `PATH` 与 `TEXT` 的结果合并，按得分排序 |

- 检测到系统 `rg` 时，以参数数组调用：`--json --no-follow --no-ignore --hidden --max-filesize 1M`，
  每条排除规则加一个 `-g '!<规则>'`，`TEXT` 模式加 `--fixed-strings`，最后为 `-- <query> .`，工作目录为仓库根目录。
  `rg` 经 `ExecutorEnvironment.subprocess` 启动，取消时由 Supervisor 终止。
- 未检测到 `rg` 时，对第 3.1 节的文件集合做确定性扫描，分块执行并在块之间让出事件循环。
- 每个命中都再经过第 3.2 节第 2–5 步检查，不通过的命中直接丢弃。
- 得分只取决于匹配类型、匹配次数与路径，同一快照与查询得到相同结果。
- 查询去掉首尾空白后为空，或 `SYMBOL` 模式下无法构成合法正则时，返回 `REJECTED(INVALID_QUERY)`。

## 4. 各 Executor 的行为

### 4.1 RepositoryOrientExecutor

计算文件集合与快照；生成深度 2 的目录树，以及 README 和包清单文件的前 40 行，写成 ORIENT ContextPack 的 `ORIENT` 段条目
（`provenance.retrieval = 'TREE'`）；按 `tokenBudget` 裁剪。输出 `RepositoryOrientOutput`，产物为该 ContextPack。

### 4.2 RepositorySearchExecutor

按第 3.3 节检索，命中前后各取 2 行作为片段，写成 SEARCH ContextPack 的 `SEARCH_HIT` 条目（带 `score` 与 `provenance`），
按 `maxItems` 与 `tokenBudget` 截断。输出 `RepositorySearchOutput`，产物为该 ContextPack。

### 4.3 FileReadExecutor

按第 3.2 节检查路径。缺省读取第 1 行到第 400 行；一次最多返回 400 行且不超过 `limits.maxOutputBytes`，
超出时截到满足两者的最后一个完整行，并在 `endLine` 中给出实际结束行；第一行本身就超过 `maxOutputBytes` 时返回 `REJECTED(LIMIT_EXCEEDED)`。
`startLine > endLine` 或 `startLine` 超出文件行数时返回 `REJECTED(INVALID_RANGE)`；空文件（0 行）且未给出行范围时返回空内容，
`startLine = 1`、`endLine = 0`、`totalLines = 0`。换行统一为 LF。输出 `FileReadOutput`，产物为读取的文本。

### 4.4 ContextAssembleExecutor

按 M1Interface 6.3 的段顺序生成 ASSEMBLE ContextPack：

| 段 | 内容 | 角色 |
|---|---|---|
| INSTRUCTIONS | `instructions` | system |
| TOOLS | `toolSpecs`（final 时只有 finish 控制工具） | system |
| OBJECTIVE | `objective` | user |
| HANDOFF | `handoff`（存在时） | user |
| ORIENT | `orientPack` 的条目（存在时） | user |
| HISTORY | `history`：MODEL_TURN 为 assistant 条目（带 `toolCalls`）；TOOL_RESULT 与带 `toolCallId` 的 FEEDBACK 为 tool 条目；其他 FEEDBACK 为 user 条目 | 见左 |
| STATUS | `status` 的说明文字 | user |

- 用 contracts 的 `estimateItemTokens` 计算每个条目；总量超过 `tokenBudget` 时按 M1Interface 6.3 的顺序裁剪，
  并设置 `truncated`、`droppedCount` 与 `elidedRequestIds`。HISTORY 与 ORIENT 可以裁剪至空，启动时的额度校验保证不可裁剪段小于预算，
  因此裁剪必然成功。
- 某个 `toolCallId` 没有对应的 tool 条目时返回 `FAILED(INTERNAL, retryable = false)`，这表示 Workflow 有缺陷。
- `prefixSha256` 为 INSTRUCTIONS 与 TOOLS 段内容的 SHA-256。输出 `ContextAssembleOutput`，产物为该 ContextPack。

### 4.5 ModelCallExecutor

- 把 ContextPack 转为 provider 请求：INSTRUCTIONS 为 system 消息，TOOLS 为工具参数，其余条目按 `role` 转为消息。
  `final = true` 时强制调用唯一的控制工具；否则由模型自行选择。
- `max_tokens = limits.maxOutputTokens`；思考模式按 `scope.thinking` 设置；Provider SDK 的自动重试关闭（`maxRetries: 0`）；
  `environment.signal` 触发时中止请求。
- 凭据只经 `environment.credentials.apiKeyFor(scope.provider)` 取得，不写入输出、日志或产物。
- 成功时输出 `ModelCallOutput`（工具调用参数按 JSON 解析，解析失败时 `arguments = null`、`argumentsError = 'INVALID_JSON'`），
  产物为 `ModelRawOutput`，`requestState = 'SENT'`，并带 provider 返回的用量。

| 情况 | outcome | reasonCode | requestState | retryable |
|---|---|---|---|---|
| 连接、DNS 或 TLS 在请求发出前失败 | FAILED | `PROVIDER_UNREACHABLE` | `NOT_SENT` | true |
| HTTP 429 | FAILED | `PROVIDER_RATE_LIMITED` | `NOT_SENT` | true |
| HTTP 401、403 | FAILED | `PROVIDER_AUTH` | `NOT_SENT` | false |
| HTTP 400 | FAILED | `INTERNAL` | `NOT_SENT` | false |
| HTTP 5xx，或响应流中断 | FAILED | `PROVIDER_ERROR` | `UNKNOWN` | false |
| 收到中止信号 | 尽快返回，`requestState` 为请求是否已发出的判断 | — | `NOT_SENT` 或 `UNKNOWN` | false |
| 正常返回 | COMPLETED | — | `SENT` | — |

`NOT_SENT` 表示 provider 没有处理该请求，不产生消耗。provider 返回的用量超过 `max_tokens` 或输入估算时，
按结算异常处理（见 [Monitor](../Kernel/Monitor.md) 3.4），不属于安全违规。

## 5. 执行点检查的两类结果

| 情况 | 例子 | Executor 返回 | 后续 |
|---|---|---|---|
| 正常越界 | 读取 `.env`、仓库外路径、输出超限、行范围不合法 | `REJECTED(原因码)` | Core 交付 UnitReport REJECTED，Workflow 按 `failurePolicy` 处理 |
| 安全违规 | 范围约束缺失、检查后文件被替换、防护失效 | `VIOLATION(原因码)` | Supervisor 上报，Execution 隔离输出，Core 以 VIOLATION 停止运行 |

M1 只运行可信的内置 Executor；引入不可信 Executor 时须改由访问器或操作系统沙箱强制。

## 6. 测试

| 覆盖 | 内容 |
|---|---|
| 路径检查 | 第 3.2 节每一步的反例，包括 symlink 指向仓库外、`..`、绝对路径、排除规则、二进制文件、检查后替换文件 |
| 快照 | 同一内容得到相同 `snapshotId`；排除的文件不影响摘要 |
| 检索 | `rg` 与内置扫描对同一 fixture 结果一致；排除文件不出现在命中中；取消时子进程被终止 |
| 组装 | 段顺序、裁剪顺序（含整轮移除与裁剪至空）、`elidedRequestIds`、`prefixSha256` 稳定、裁剪前后工具调用与 tool 条目一一对应 |
| 模型 | 用假的 provider 覆盖第 4.5 节表中每一行；`final` 时强制控制工具；SDK 不自动重试 |
| 读取 | 按 400 行与 `maxOutputBytes` 截断到完整行；首行超限；空文件 |
| Contract | 每个 Executor 的输出通过对应 Schema 校验 |
