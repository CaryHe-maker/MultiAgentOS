# MultiAgentOS M1 Unit 授权、准入与运行结束机制（UnitCheck）

## 1. 目的与范围

本文规定 M1 中所有 Unit 在 Workflow、Kernel、Executor 各环节所受的检查，以及运行的结束与关闭流程，包括：

- Workflow 与 UserInteraction 发起的 syscall，以及 Kernel 返回给 Workflow 的信息；
- 定义合法性、准入、Lease 与用户授权、额度、执行点检查与结果检查；
- Round 上限、final-call 收尾、FINISH 后的结束路径与系统关闭。

组件职责范围见 [M1KernelRange](kernel/M1KernelRange.md)；长期规划见 [Architecture](../Architecture/README.md)。

## 2. 术语

| 术语 | 定义 |
|---|---|
| Round | 以一次 model-call 为中心的一轮：组织上下文（首轮为 orient + assembly，其后为 assembly）→ model-call → 该次返回所要求的全部工具 Unit 处理完成 |
| 受保护 Unit | Unit 定义中声明了受保护能力（M1 为 `repo.read`）的 Unit，需要 Lease |
| 非受保护 Unit | 未声明受保护能力的 Unit，依据开发者授权执行，无需 Lease |
| Lease | Core 私有的运行时授权记录，只存在于 Core |
| 用户授权记录 | Core 保留的用户同意或拒绝结果 |
| 范围约束 | Core 依据 Lease 派生、经 Supervisor 注入 Executor 的参数（如仓库根目录），不是 Lease 本身 |
| 额度 | 一次 WorkflowRun 可消耗的 token 上限，账本归 Monitor |
| budgetState | 额度状态：NORMAL、WRAP_UP（应收尾）、EXHAUSTED（已达硬限制）；只能前进 |
| final-call | 标记 `final=true`、不提供工具的 model-call，用于收尾 |
| 准入封锁 | Core 对某个 WorkflowRun 设置的禁止准入状态，由 Gateway 检查，设置后不解除 |
| runEpoch | 运行控制状态的版本号，每次控制状态变化加 1，用于防止判定与交付之间的竞态 |
| 终止信号 | Core 结束 Kernel 内部等待中的调用时给出的信号，不携带任何结果 |

## 3. 通讯主体与 syscall

### 3.1 通讯主体

| 通讯主体 | 组成 | 与其他主体的通信 |
|---|---|---|
| Kernel 核心主体 | Core、Monitor、Scheduler、Execution（主体内部直接函数调用） | 进程内可序列化消息 |
| Gateway | Gateway | 进程内可序列化消息 |
| Supervisor | Supervisor 及其监管的 Executor 实例 | 进程内可序列化消息 |
| 外部 Module | Workflow、UserInteraction | 进程内可序列化消息，经 Gateway 进入 Kernel |

M1 全系统为单进程，进程内消息由 MessageRouter 承载。

### 3.2 syscall 定义

- **外部 syscall**：Workflow、UserInteraction 经 Gateway 向 Core 发起的请求。
- **内部 syscall**：Kernel 其他组件向 Core 发起的请求。
- **职责接口调用**：Core 调用 Monitor、Scheduler、Execution 的职责接口，不属于 syscall。

### 3.3 Workflow 的 syscall

| syscall | 何时调用 | 主要参数 | Kernel 的回应 | 准入封锁期间 |
|---|---|---|---|---|
| `registerAgentRun` | 创建 AgentRun 时（运行开始、HANDOFF 之后） | `workflowRunId, agentRunId, agentRef@digest, requestId` | SyscallAck | 拒绝 |
| `submitUnit` | 提交每个 unitIntent | `workflowRunId, agentRunId, unitRef, input, requestId` | 受理时 SyscallAck，最终 UnitReport | 拒绝 |
| `endAgentRun` | HANDOFF 或报告发布之后 | `agentRunId, requestId` | SyscallAck | 允许 |
| `closeRun` | 报告发布之后，或 Workflow 自身无法继续 | `workflowRunId, outcome: COMPLETED \| FAILED, reportRef?, requestId` | RunClosed | 允许 |

4 种 syscall 均以 `requestId` 幂等：重复提交返回同一结果；相同 `requestId` 但内容不同按冲突处理。

### 3.4 UserInteraction 的请求

| 请求 | 用途 | 准入封锁期间 |
|---|---|---|
| 创建运行 | 提交用户目标 | — |
| 授权回答 | 回答 Core 发起的 Y/N 询问 | 允许 |
| 取消 | 用户终止运行（Interruption） | 允许 |
| 关闭系统 | 结果展示完成后请求关闭 | 允许 |

### 3.5 Kernel 返回给 Workflow 的信息

| 信息 | 发出者 | 何时发出 | 内容 |
|---|---|---|---|
| RunStart | Core | 用户创建运行后 | 用户目标 |
| SyscallAck | Core | `registerAgentRun`、`endAgentRun` 处理完成；`submitUnit` 被受理 | 是否受理 |
| AdmissionException | Gateway | 任一 syscall 在准入被拒 | 拒绝原因 |
| UnitReport | Core（执行前被拒）或 Execution（已进入执行） | 每个被受理的 `submitUnit` 的最终结果 | 状态（OK / REJECTED / FAILED）、原因码、输出或 Artifact 引用、budgetState |
| RunClosed | Core | `closeRun` 收敛完成；或硬限制、超时、取消、违规导致停止 | 结束来源、控制终态、用量摘要、未知效果 |

规则：

1. 被 Gateway 受理的 `submitUnit`，要么恰好收到一个 UnitReport，要么随 RunClosed 结束。
2. 被 Gateway 拒绝的 syscall 只收到 AdmissionException。
3. 一个 WorkflowRun 恰好收到一个 RunClosed，收到后 Workflow 不再等待任何 UnitReport。
4. Workflow 按 `requestId` 对应结果，不依赖到达顺序；一轮的 UnitReport 全部收齐后才进入下一轮。
5. UnitReport 只携带 budgetState，不携带额度数值。Workflow 在 M1 中不读取 token 数。

## 4. Unit 与检查层次

### 4.1 M1 的 Unit

| Unit | executionKind | 受保护 | 暴露给模型 | 消耗 token | 计入 Round |
|---|---|---|---|---|---|
| repository-orient | `REPOSITORY_ORIENT` | 是（`repo.read`） | 否（CodeViewer 的 startUnit） | 否 | 否 |
| repository-search | `REPOSITORY_SEARCH` | 是（`repo.read`） | 是 | 否 | 否 |
| file-read | `FILE_READ` | 是（`repo.read`） | 是 | 否 | 否 |
| context-assemble | `CONTEXT_ASSEMBLE` | 否 | 否 | 否 | 否 |
| model-call | `MODEL` | 否 | 否 | 是 | 是 |
| report-publish | `REPORT_PUBLISH` | 否 | 否 | 否 | 否 |

- 是否需要 Lease 只看 Unit 定义中声明的受保护能力，与是否关联面向模型的 Tool 描述无关。
- Supervisor 以 `executionKind` 作为执行定义引用，找到对应的 Executor。
- model-call 的使用资格来自可信配置（Agent 定义声明的模型、配置的 provider），不需要 Lease。
  仓库内容只能经受保护 Unit 进入系统，因此外发给模型的仓库内容已由 `repo.read` 的用户同意覆盖。
- Planner 与 CodeViewer 的 Agent 定义都必须包含 `report-publish`、`context-assemble`、`model-call`；
  只有 CodeViewer 包含受保护 Unit。

### 4.2 检查层次

| 层 | 执行者 | 对象 | 内容 | 不通过时 |
|---|---|---|---|---|
| Validation | Workflow | modelReturn 中的每个工具调用 | step1：属于 Agent 定义、参数合法、不超过 maxToolCallsPerRound；step2：软限制 | 交还模型（不进入 Kernel） |
| 准入 | Gateway | 所有 syscall | 来源、契约、准入封锁 | AdmissionException |
| 定义核验 | Core | 所有 Unit | AgentRun 已登记且为 ACTIVE、属于该运行；Unit 属于该 Agent 定义闭包 | Core 交付 UnitReport |
| 权限 | Core | 受保护 Unit | Lease 与用户授权（第 5 节） | Core 交付 UnitReport |
| 额度预留 | Core 调用 Scheduler、Monitor | model-call | 调用机会、token 预留 | 硬限制（第 6 节） |
| 执行点检查 | Executor | 受保护 Unit、model-call | 开发者硬编码的防护检查（第 9 节） | 越界：UnitReport；违规：停止运行 |
| 结果检查 | Core | 进入执行的 Unit | 结果归属、运行状态、Lease 有效；model-call 结算 | 第 10 节 |

## 5. Lease 与用户授权

- `repo.read` 的范围：仓库根目录（realpath）、排除规则（默认 `.env*`、`*.pem`、`*.key`、`id_*`、`.git/` 等，只能由本地配置追加）、外发目标 provider。
- Lease = Agent 定义能力 ∩ 用户授权 ∩ 系统策略；绑定 WorkflowRun，运行结束时失效。
- Core 保留用户授权记录。属于已同意范围的安全子集直接签发 Lease，不再询问；危险行为每次询问（M1 不涉及）。
- 询问发生在第一个受保护 Unit 到达权限检查时（CodeViewer 的 `repository-orient`），内容须说明仓库路径、排除规则，以及"读取的内容会发送至 <provider>"。
- 询问期间到达的同类申请等待同一结果；拒绝或超时后，本运行内同类申请直接返回 `USER_DECLINED`。
- 明确越界的请求直接返回 `OUT_OF_SCOPE`，不升级为新的授权申请。

```text
受保护 Unit 到达 Core
  ├─ 定义不含该能力或策略禁止 → UnitReport REJECTED(FORBIDDEN)
  ├─ 本运行已拒绝 → UnitReport REJECTED(USER_DECLINED)
  ├─ 已授权且属于其子集 → 签发或复用 Lease → 放行，下发范围约束
  └─ 尚无授权 → 经 UserInteraction 询问
        ├─ 同意 → 保留授权记录，签发 Lease，放行
        └─ 拒绝或超时 → 保留拒绝记录 → UnitReport REJECTED(USER_DECLINED)
```

## 6. 额度机制

### 6.1 基本规则

- 单位为 token（输入 + 输出），以 provider 返回的用量为准；账本按 WorkflowRun 计，Planner 与 CodeViewer 共用。
- 账本由 Monitor 维护；预留与结算都由 Core 调用 Monitor 完成，Execution 不直接调用 Monitor。
- 只有 model-call 消耗 token。

### 6.2 预留（调用前）

```text
Execution 出队 model-call → 内部 syscall 向 Core 申请预留
  Core 调用 Scheduler：选择调用目标，分配调用机会（每个 provider 并发为 1）
  Core 调用 Monitor.reserve(估算上界 = 输入 token 上界 + max_tokens)
     ├─ 已用 + 已预留 + 未知 + 估算上界 ≤ tokenLimit → 预留成功，Core 返回 Grant
     └─ 否则 → 达到硬限制（6.4）
```

### 6.3 结算（调用后，在结果检查中进行）

```text
Core 调用 Monitor.settle(reservationId, 结算类型)
  ├─ 有实际用量 → 按实际结算，释放差额
  ├─ 请求未发出 → 全额释放预留
  └─ 无法得到用量 → 按预留额全额计入未知消耗
Monitor 结算后判断：
  ├─ 已用 + 未知 > tokenLimit → 达到硬限制（6.4），本次结果不交付
  ├─ 剩余 ≤ finalReserve → budgetState = WRAP_UP（只标记一次）
  └─ 否则 → NORMAL
```

- 软限制只在结算时触发；硬限制在预留与结算时都可触发。
- 额度阈值指"本次申请将超出上限"或"结算后已超出上限"，不是"恰好等于上限"。
- 结算以 `reservationId` 幂等；重复结算且数值冲突时，Monitor 报告 Core。

### 6.4 硬限制与运行超时

Monitor 保有达到硬限制时主动提交 Exception 的权力；M1 中体现为被 Core 调用时返回"达到硬限制"。
运行总时长由 Supervisor 计时，超时时向 Core 报告。两者处理相同：

```text
Core 设置准入封锁(USAGE_LIMIT 或 RUN_TIMEOUT)，runEpoch 加 1，通知 Gateway
  → 以终止信号结束 Kernel 内部等待中的调用（不携带结果，不交付 Workflow）
  → 收敛（10.5）→ RunClosed(USAGE_LIMIT 或 RUN_TIMEOUT) → Workflow 停止推进
  → UserInteraction 显示"已达到 usage limit，运行已停止"或"运行超时"
  → 关闭系统（10.6）
```

触发硬限制的 Unit 不再有 UnitReport；不执行 final-call。

## 7. Round 机制

- 上限按 Agent 写在 Agent 定义中：`limits.maxRounds`、`limits.maxToolCallsPerRound`，受定义 digest 覆盖。
- Workflow 在创建 AgentRun 时读取上限，`roundsUsed` 从 0 开始；每发起一次 model-call（含重新生成与 final-call）加 1。
- `maxRounds − roundsUsed ≤ 1` 时，下一次 model-call 设为 final-call。HANDOFF 后 CodeViewer 从 0 计数。
- Kernel 不记录 Round，也不设 Round 限制。token 硬限制限定了 model-call 的总次数，作为兜底。
- 技术重试由 Execution 执行，对 Workflow 不可见，不计 Round；每个 Unit 最多 3 次，model-call 每次重试重新预留。

## 8. final-call 统一规则

| 触发 | 判断者 | 报告中的收尾说明 | 本轮剩余工具 Unit |
|---|---|---|---|
| Round 达到上限 | Workflow | 已达到轮次上限 | 无 |
| budgetState = WRAP_UP | Monitor（结算时），经 UnitReport 通知 | 已接近额度上限 | 执行完后再发起 final-call |
| USER_DECLINED | Core | 未获得仓库访问授权 | 不再提交读仓库 Unit |

- `final=true`，不提供工具，要求依据已有材料输出最终报告；上下文不超过 `finalInputBudget`；计入 1 个 Round。
- 返回合法 FINISH：进入第 11 节；返回不合法：不再重新生成，以已有材料生成降级报告。
- 每个 AgentRun 最多一次；多个原因同时出现只发起一次。Planner 在 final-call 中不能 HANDOFF。
- 硬限制与超时不发起 final-call。

## 9. 执行点检查（Enforcement）

- Executor 开发者在实现时硬编码防护检查，并在开发阶段优先写好：拒绝危险文件（`.env`、密钥文件、`.git/` 内部对象）、只处理普通文件、限制输出大小、`max_tokens` 不超过预留值、关闭 SDK 自带的自动重试。
- 仓库根目录取决于每次运行的 Lease，由 Supervisor 注入；Executor 以硬编码的逻辑检查"真实路径位于注入的根目录内"，以挡住符号链接逃逸。
- M1 只运行可信的内置 Executor；引入不可信 Executor 时须改由访问器或操作系统沙箱强制。

| 情况 | 例子 | 处理 |
|---|---|---|
| 正常越界 | 读取 `.env`、仓库外路径、输出超限 | 返回拒绝 → Core 判定 → Execution 交付 UnitReport REJECTED → 交还模型 |
| 安全违规 | 校验后文件被替换、范围约束缺失、用量超出 max_tokens | Executor 主动停止并上报 → Supervisor → Execution（隔离输出）→ Core 停止运行（VIOLATION） |

## 10. 运行路径

### 10.1 AgentRun 登记

```text
UserInteraction → Gateway → Core：创建运行 → Core 启动运行总时长计时（经 Supervisor）→ RunStart → Workflow
Workflow 创建 AgentRun：读取 limits，校验 maxRounds ≥ 1
  → registerAgentRun → Core 读取定义并核对 digest，登记为 ACTIVE → SyscallAck
HANDOFF：endAgentRun(Planner) → registerAgentRun(CodeViewer)
```

### 10.2 Workflow 处理 modelReturn

```text
modelReturn
  ├─ FINISH → 第 11 节
  ├─ HANDOFF → endAgentRun(Planner) → registerAgentRun(CodeViewer) → CodeViewer 首轮
  ├─ INVALID → 错误反馈给模型 → 下一轮（计入 Round）；若为 final-call → 降级报告 → 第 11 节
  └─ TOOL_CALLS → 逐个 Validation step1 → step2 软限制判断 → 依次 submitUnit → 收齐 UnitReport → 下一轮
```

### 10.3 一次 submitUnit

```text
Workflow → submitUnit → Gateway 准入
  ├─ 被拒 → AdmissionException
  └─ 通过 → Core：SyscallAck → 定义核验 → 权限检查（受保护 Unit）
       ├─ 被拒 → Core 交付 UnitReport
       └─ 通过 → Execution：建立 UnitAttempt，进入 FIFO
            → model-call：预留（6.2）
            → 提交 executionKind、参数、范围约束、限制 → Supervisor 装配并执行 → 交回事实
            → 内部 syscall 提交结果检查（10.4）
            → Core 返回判定 → Execution 核对 runEpoch → 交付 UnitReport
```

### 10.4 Core 的结果检查

```text
① 结果归属于本运行、对应当前 UnitAttempt、Lease 未失效
② model-call：调用 Monitor 结算（6.3）；达到硬限制 → 6.4，以终止信号结束本次调用
③ Executor 违规 → 第 9 节，以终止信号结束本次调用
④ 判定 {status, reasonCode, budgetState, runEpoch} 返回 Execution
```

Execution 交付前核对 runEpoch；不一致则不交付，结果只作为证据保存。
Core 收敛时等待 Execution 正在进行的交付结束后才发出 RunClosed。

### 10.5 收敛过程（closeRun、硬限制、超时、取消、违规共用）

```text
Core 设置准入封锁，runEpoch 加 1
  → Execution 清空 FIFO；在途任务经 Supervisor 中止；等待正在进行的交付结束
  → Core 调用 Scheduler 释放调用机会
  → Core 调用 Monitor 完成最终结算，取得用量摘要
  → 全部 AgentRun 标记为 ENDED，Lease 与用户授权记录失效
  → 通知 Supervisor 停止运行总时长计时
  → Core 把运行记录的执行部分与审计记录写入 runs/<runId>/
  → Core 发出 RunClosed
```

### 10.6 关闭系统

```text
UserInteraction 展示完成 → Gateway → Core：请求关闭
Core → Supervisor：协调 ModuleHost 按启动的相反顺序关闭
  停止接收新工作 → 各模块 stop → Persistence 完成写入 → ArtifactStore 关闭 → 通信最后关闭
进程退出；下次启动只清空临时数据，runs/<runId>/ 保留
```

## 11. FINISH 后的结束路径

```text
1. Workflow 生成报告
   1.1 按 AnalysisReport 格式校验 FINISH；不合法时：非 final-call 且有剩余 Round → INVALID；
       final-call → 降级报告
   1.2 核验来源：结论引用的路径与行号范围，必须对应本运行中读取成功的结果；对不上的结论移入"未确认项"
   1.3 组装 AnalysisReport：结论、来源、未确认项，提前收尾时附收尾说明；各 Agent 的 Round 数随报告保存，默认不展示
   1.4 把运行记录的业务部分（步骤、Round 数、收尾原因）写入 runs/<runId>/
2. Workflow → submitUnit(report-publish, 报告内容)
   → 准入、定义核验 → Execution 经 Supervisor 执行发布 Executor：校验格式、写入 ArtifactStore
   → UnitReport(OK, reportRef)；失败或被拒 → 第 4 步改为 closeRun(FAILED)
3. Workflow → endAgentRun（报告发布必须在 AgentRun 仍为 ACTIVE 时进行）
4. Workflow → closeRun{outcome: COMPLETED, reportRef}
5. Core：若已有控制终态（硬限制、超时、取消先发生）→ 返回已有 RunClosed；否则设置准入封锁(CLOSING) → 收敛（10.5）
   → RunClosed(COMPLETED)
6. Workflow：无未知效果 → 标记 COMPLETED；有未知效果 → 标记 COMPLETED 并在运行记录中注明，不视为干净完成
7. Core → UserInteraction：运行已结束，附 reportRef → UserInteraction 读取并展示 AnalysisReport
8. 关闭系统（10.6）
```

Core 不检查报告内容，只记录 `reportRef`；报告是否合格由 Workflow 负责。

## 12. 结束方式与用户可见内容

| 方式 | 控制类别 | 控制终态 | Workflow 业务终态 | 用户看到 |
|---|---|---|---|---|
| 正常结束 | Syscall | CLOSED(COMPLETED) | COMPLETED | 结论、来源、未确认项 |
| final-call 收尾 | Syscall | CLOSED(COMPLETED) | COMPLETED | 同上，附收尾说明 |
| Workflow 失败 | Syscall | CLOSED(FAILED) | FAILED | 运行失败及原因 |
| 硬限制 | Exception | CLOSED(USAGE_LIMIT) | STOPPED(USAGE_LIMIT) | "已达到 usage limit，运行已停止" |
| 运行超时 | Exception | CLOSED(RUN_TIMEOUT) | STOPPED(RUN_TIMEOUT) | "运行超时，已停止" |
| 用户终止 | Interruption | CLOSED(CANCELLED) | CANCELLED | 已终止 |
| 安全停止 | Exception | CLOSED(VIOLATION) | STOPPED(VIOLATION) | 因安全原因停止 |

用户默认只看到结果；步骤、Round 数、token、provider 请求次数、耗时与失败分类写入运行记录，
供评测与排查使用，用户可通过查看命令调出。

## 13. 原因码

| 原因码 | 出现在 | 含义 | Workflow 处理 |
|---|---|---|---|
| INVALID_ACTION | Workflow 内部 | Validation step1 失败 | 交还模型 |
| TOO_MANY_TOOL_CALLS | Workflow 内部 | 超过 maxToolCallsPerRound | 超出部分交还模型 |
| INVALID_REQUEST | AdmissionException | 契约不合法 | closeRun(FAILED) |
| USAGE_LIMIT / RUN_TIMEOUT / CANCELLED / CLOSING / VIOLATION | AdmissionException | 处于准入封锁 | 停止推进，等待 RunClosed |
| RUN_NOT_ACTIVE | UnitReport（Core） | AgentRun 未登记或已结束 | 停止推进 |
| FORBIDDEN | UnitReport（Core） | 不在定义闭包内或能力不可申请 | closeRun(FAILED) |
| USER_DECLINED | UnitReport（Core） | 用户拒绝或超时 | 交还模型，进入 final-call |
| OUT_OF_SCOPE | UnitReport（Core 或 Execution） | 越界、命中排除规则 | 交还模型 |
| LIMIT_EXCEEDED | UnitReport（Execution） | 输出超限 | 交还模型 |
| UNAVAILABLE / INTERNAL | UnitReport（Execution，FAILED） | 技术重试后仍失败 | 交还模型或按业务处理 |

Round 上限与 WRAP_UP 不对应原因码。

## 14. Exception 规则

1. 正常业务结果不提交 Exception：Validation 失败、Round 达到上限、WRAP_UP、权限拒绝、执行点正常越界。
2. 以下由 Core 按 Exception 处理：硬限制（Monitor）、运行超时（Supervisor）、重复结算数值冲突（Monitor）、
   契约错误（Gateway）、定义核验失败（Core）、安全违规（经 Supervisor、Execution）。
3. 每个被受理的 `submitUnit` 要么收到 UnitReport，要么随 RunClosed 结束；Kernel 内部等待中的调用由 Core 以终止信号结束。
4. 仅凭 Executor 自报不升级为 panic。

## 15. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| `limits.maxRounds` | Agent 定义 | Workflow | CodeViewer 20；Planner 3（需评测校准） |
| `limits.maxToolCallsPerRound` | Agent 定义 | Workflow | CodeViewer 8；Planner 0 |
| 重新生成次数上限 | Workflow 配置 | Workflow | 3 |
| 技术重试次数上限 | Execution 配置 | Execution | 3 |
| `tokenLimit` | 系统配置 | Monitor | ≥ Σ(maxRounds) × (每轮输入上限 + maxOutputTokens)，数值待定 |
| `finalReserve` | 系统配置 | Monitor | ≥ finalInputBudget + final-call max_tokens |
| `finalInputBudget` | 系统配置 | Workflow | 待定 |
| 运行总时长上限 | 系统配置 | Supervisor | 30 分钟 |
| 询问超时 | Core 配置 | Core | 300 秒 |

启动时校验 `finalReserve ≥ finalInputBudget + final-call max_tokens`，不满足即视为配置错误。

## 16. 职责汇总

| 部分 | 职责 |
|---|---|
| Workflow | 接收 RunStart；持有 AgentRun 实例；读取 Agent 定义的 limits，维护并判断 Round；Validation；final-call；HANDOFF；来源核验与 AnalysisReport；提交 report-publish；发起 4 种 syscall；写入运行记录的业务部分；标记业务终态 |
| Gateway | 外部请求唯一入口；校验来源与契约；检查准入封锁；拒绝时返回 AdmissionException |
| Core | 处理内外部 syscall；AgentRun 登记、Lease、用户授权记录；定义核验与权限；代为调用 Scheduler、Monitor；结果检查与判定；执行前被拒时交付 UnitReport；处理 Exception；准入封锁与 runEpoch；收敛；发出 RunStart、SyscallAck、RunClosed；写入运行记录的执行部分与审计 |
| Scheduler | 被 Core 调用：分配与释放 API 调用机会 |
| Monitor | 被 Core 调用：预留、结算、未知消耗；软限制（仅结算时）与硬限制（预留与结算时）；用量摘要 |
| Execution | UnitAttempt 与 FIFO；经内部 syscall 申请预留、提交结果检查；向 Supervisor 提交执行；技术重试；写入 ArtifactStore（含最终报告）；隔离违规输出；核对 runEpoch 后交付 UnitReport |
| Supervisor | 按 executionKind 装配 Executor 并注入范围约束；监管超时、取消与停止；运行总时长计时；系统启动与按序关闭 |
| Executor | 硬编码的执行点检查；正常越界返回拒绝；违规时主动停止并上报 |
| UserInteraction | 创建运行、取消、回答授权；展示 AnalysisReport 与停止原因；展示完成后请求关闭 |
