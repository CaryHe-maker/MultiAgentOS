# MultiAgentOS M1 Kernel 阶段三实现报告

> 状态：工作文档，2026-10-20 完成阶段三实现验收。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.4 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范；随本分支进入 `feature/M1/main`，由项目主管人后续归档整理。与 `docs/M1/` 冲突时以规范为准。
> 本文件记录阶段三（3.1–3.5）的实际实现、验证证据、边界与遗留事项。

## 1. 验收结论

阶段三（Supervisor 执行控制）通过验收。

验收范围：

- execution 表、execute 受理与 notBefore 调度；
- 五类 Executor 的查找、最小执行环境与调用；
- 正常终态 COMPLETED、REJECTED、FAILED、VIOLATION；
- Executor 抛错规范化与 ExecutionFact 映射；
- deadline、cancelRun、cancelEpoch、启动前取消与宽限期；
- TERMINATED、STOP_UNCONFIRMED、迟到结果丢弃；
- stop 清理、定时器清理与事实投递韧性；
- 真实 Fabric 路由、correlation、producer、not-ready 与 Schema 校验；
- Supervisor 的 health 诊断。

本阶段不包含：

- run actor、双通道 Inbox、OrderedSender、真实 Outbox；
- `createKernelCore` 装配与真实启动；
- ModuleHost、Fabric、Persistence、ArtifactStore 的真实故障矩阵；
- 真实模型 E2E、F1–F5 与 M1 整机验收；
- 并行执行、跨进程 IPC、分片或生产级隔离。

阶段三代码工作已收敛。后续改动应属于阶段四至六、缺陷修复或单独的接口调整，
不再以阶段三子阶段名义扩展功能。

## 2. 交付范围与代码结构

阶段三实现集中在：

```text
packages/modules/kernel/src/supervisor/
  index.ts                createSupervisor、Fabric 注册、生命周期与 health
  execution-table.ts      execution 表、状态、取消原因与定时器字段
  execution-runner.ts     execute、notBefore、deadline、取消、宽限期、stop
  environment.ts          按 executionKind 构造最小 ExecutorEnvironment
  fact-mapper.ts          ExecutorOutcome / TerminationVerdict → ExecutionFact
  subprocess-runner.ts    既有 rg 子进程适配（阶段三前已有）
  execute.test.ts         Fabric、typed SupervisorPort 与执行闭环
  execution-runner.test.ts
                          执行表、正常终态、中断、stop 与事实归一化
  supervisor.test.ts      引导、not-ready、关闭顺序与生命周期
```

未修改：

- `packages/libraries/contracts`；
- `packages/testing`；
- 根构建、检查与锁文件；
- 其他 Module、静态库或基础设施目录。

阶段 3.1–3.3 已由提交 `959fdc4` 提交；3.4–3.5 与本报告随后续提交进入工作分支。

## 3. 实现内容

### 3.1 执行表与 execute

`ExecutionRunner` 实现 Supervisor 的单运行执行控制：

- execution 表以 `executionId` 为键；
- 记录请求、状态、`startedAt`、`endedAt`、中止原因与定时器；
- 重复 `executionId` 只保留第一次受理；
- `execute` 只登记并立即返回，启动由请求处理之外的调度完成；
- `notBefore` 缺省立即启动，未来时间使用定时器；
- 已取消的运行收到更低 `runEpoch` 的迟到 execute 时，不启动 Executor，直接上报
  `TERMINATED(EXECUTION_CANCELLED)`，无 `startedAt`。

执行状态：

```text
ACCEPTED（等待 notBefore）→ RUNNING ─┬→ COMPLETED / REJECTED / FAILED / VIOLATION
         │                           ├→ TERMINATED（宽限期内结束）
         │                           └→ STOP_UNCONFIRMED（宽限期内未结束）
         └→ TERMINATED（启动前被取消，无 startedAt）
```

### 3.2 Executor 查找与最小执行环境

- 按请求的 `executionKind` 从 `ExecutorRegistry` 取得唯一 Executor。
- 运行时核对 `executor.executionKind` 与请求一致。
- 注册表缺失或 kind 不一致时产生 `FAILED(INTERNAL, retryable = false)`。
- 环境始终提供 `scope`、`limits`、`signal` 与 `now`。
- 能力最小化：
  - 只有 MODEL 取得真实 `ProviderCredentials`；
  - 只有 REPOSITORY_SEARCH 取得真实 `SubprocessRunner`；
  - 其他执行使用拒绝式 credentials 与 subprocess。

### 3.3 正常终态与事实映射

支持四种正常结果：

| ExecutorOutcome | ExecutionFact | 说明 |
|---|---|---|
| COMPLETED | COMPLETED | 保留 output 与 artifact；MODEL 的 `requestState = SENT` |
| REJECTED | REJECTED | 原因码原样保留；MODEL 的 `requestState = NOT_SENT` |
| FAILED | FAILED | 保留 `retryable`；MODEL 保留 `usage` 与 `requestState`，缺失时 `UNKNOWN` |
| VIOLATION | VIOLATION | 原因码原样保留；MODEL 的 `requestState = UNKNOWN` |

Executor 抛错：

- 统一形成 `FAILED(INTERNAL, retryable = false)`；
- MODEL `requestState = UNKNOWN`；
- 非 MODEL 不携带 `requestState` 与 `usage`；
- 原始异常不跨通讯主体传播。

事实只由 Supervisor 产生一次。重复结果、迟到结果或已终态的执行不产生第二条事实。

### 3.4 截止时间、取消与宽限期

deadline：

- 执行启动时按 `limits.deadline` 设置定时器；
- 到点触发 abort，原因 `UNIT_TIMEOUT`；
- 已过或无法解析的 deadline 视为立即超时，不启动 Executor；
- 进入中止后启动 `cancelGraceMs` 宽限期。

cancelRun：

- 记录该运行的最大取消 runEpoch；
- 对运行中的执行触发 `EXECUTION_CANCELLED`；
- 尚未启动的执行直接 `TERMINATED`，不调用 Executor；
- 重复取消幂等，不产生额外事实。

竞争与终态：

- deadline 与 cancel 谁先触发，谁决定中止原因；
- 后续触发不改变原因、不重置宽限期；
- 宽限期内 Executor 返回：`TERMINATED`；
- 宽限期后未返回：`STOP_UNCONFIRMED`，此后的返回全部丢弃；
- 宽限期内返回 `VIOLATION` 时上报 `VIOLATION`，避免安全证据被取消或超时路径吞掉。

### 3.5 stop、清理与投递韧性

`ExecutionRunner.stop()`：

- 封锁新执行；
- 清理 notBefore、deadline 与 grace 三类定时器；
- 对运行中的执行触发 abort；
- 对已启动但未确认停止的执行，以 `EXECUTION_CANCELLED` 为原因尽力上报
  `STOP_UNCONFIRMED`；
- 尚未启动的执行只标记终态，不产生执行事实；
- 重复调用幂等，不产生重复事实。

`createSupervisor.stop()`：

- 在停止 ModuleHost 前调用 `runner.stop()`，使事实投递在 Fabric 关闭前发起；
- 不等待宽限期或事实投递完成；
- 随后停止模块、回收子进程并清理临时数据；
- 不把未确认停止伪装成执行完成。

事实投递失败：

- 只记录诊断，不重试执行；
- 不产生第二条事实；
- 不产生未处理 Promise 拒绝；
- 错误进入 `health().details`，同时暴露活动执行数。

### 3.6 Fabric 与跨组件集成

- Supervisor 在 Fabric 就绪后注册 `execute`、`cancelRun`、`shutdown` 处理器。
- `serve` 辅助函数接收 `Envelope`，从 execute 请求捕获 `correlationId`。
- 执行事实沿用该 `correlationId`，只用于追踪，不参与裁决。
- 事实经 `createExecutionFactSink` 投递到 `kernel-core.execution-facts`。
- 校验：
  - producer 必须为 `kernel-core`；
  - 未 ready 时拒绝请求；
  - Fabric 在进入 handler 前完成 Schema 校验；
  - `execute` 在 Executor 产生事实之前返回；
  - `shutdown` 响应先于模块停止完成。
- typed `createSupervisorPort` 存根已纳入执行闭环测试。

## 4. 关键设计决定

### 4.1 事实投递在 Supervisor 内部构造

`SupervisorDeps` 不增加 `ExecutionFactSink` 或 `ContextOf` 字段。Supervisor 使用现有 Fabric 客户端
构造 sink，保持阶段一、阶段二的工厂签名不变，避免共享接缝同步成本。

### 4.2 Executor 抛错不可重试

Executor 抛错视为实现缺陷，统一使用 `FAILED(INTERNAL, retryable = false)`，避免 Execution
自动重试导致未知副作用重复发生。MODEL 使用 `UNKNOWN`，因为请求可能已经发出。

### 4.3 启动前取消不产生 startedAt

启动前取消没有调用 Executor，因此上报 `TERMINATED(EXECUTION_CANCELLED)` 时不带 `startedAt`；
MODEL 的 `requestState = NOT_SENT`，非 MODEL 不携带 `requestState`。

### 4.4 第一个中止原因不可变

deadline 与 cancel 竞争时，第一个触发者决定 `UNIT_TIMEOUT` 或 `EXECUTION_CANCELLED`。
后续触发只记录取消 runEpoch，不改变原因、不重置宽限期。所有终态经单一 `finalize` 守卫，
保证每个 `executionId` 只有一条事实。

### 4.5 VIOLATION 例外

宽限期内 Executor 返回 `VIOLATION` 时，Supervisor 上报 `VIOLATION` 而不是 `TERMINATED`。
安全违规证据不能被取消或超时路径吞掉，Core 仍可在收敛中按 VIOLATION 处理。

### 4.6 usage 与 requestState 归一化

MODEL 的 `requestState`：

| 情况 | 值 |
|---|---|
| COMPLETED | `SENT` |
| 启动前取消 | `NOT_SENT` |
| Executor 提供 | 原值 |
| REJECTED 未提供 | `NOT_SENT` |
| FAILED / TERMINATED / VIOLATION / STOP_UNCONFIRMED 未提供 | `UNKNOWN` |

`usage`：

- MODEL 的 `TERMINATED`、`FAILED` 在 Executor 提供时保留；
- `STOP_UNCONFIRMED` 不带 `usage`；
- 非 MODEL 一律丢弃 `usage` 与 `requestState`。

### 4.7 stop 使用 EXECUTION_CANCELLED

`stop()` 触发的中止使用 `EXECUTION_CANCELLED`。原因是 `TERMINATED` 与 `STOP_UNCONFIRMED`
只允许 `UNIT_TIMEOUT` 与 `EXECUTION_CANCELLED`，而正常关闭没有在途执行，该路径主要用于故障清理。

### 4.8 测试使用真实时间与受控 Executor

执行控制测试使用受控 Executor、deferred Promise、`AbortSignal` 与固定 `now`；notBefore、
deadline 与宽限期使用短延时和 `vi.waitFor`。Supervisor 测试重复运行未出现抖动。

## 5. 验证与证据

### 5.1 质量门

```text
pnpm install --frozen-lockfile   通过（已是最新）
pnpm run build                   通过
pnpm run check                   通过
  format:check                   通过
  lint                           通过
  typecheck                      通过
  test                           50 个测试文件、535 项测试全部通过
pnpm run demo:fake               退出码 0
git diff --check                 通过
```

环境：

```text
Ubuntu 24.04.5 LTS（WSL2）
Node.js v24.19.0
pnpm 11.25.0
```

`demo:fake` 使用 fake Module 与 fake Executor，只证明装配链路，不作为阶段三验收依据。

### 5.2 覆盖率

```text
全仓                语句 92.66%  分支 83.16%  函数 88.13%  行 94.71%
kernel/supervisor   语句 92.85%  分支 81.49%  函数 74.63%  行 96.24%
execution-runner    语句 94.18%  分支 83.56%  函数 60.65%  行 96.92%
execution-table     语句 100.00% 分支 100.00% 函数 50.00%  行 100.00%
fact-mapper         语句 95.00%  分支 88.63%  函数 50.00%  行 94.44%
```

### 5.3 测试覆盖矩阵

| 范围 | 覆盖 |
|---|---|
| 执行表 | 受理、重复 executionId、状态转换、终态唯一 |
| 调度 | notBefore 未来/过去、execute 返回早于启动 |
| 五类 Executor | ORIENT、SEARCH、FILE_READ、CONTEXT_ASSEMBLE、MODEL |
| 正常终态 | COMPLETED、REJECTED、FAILED、VIOLATION、抛错 |
| 环境 | MODEL 凭据、SEARCH subprocess、其他拒绝 |
| deadline | 到点、已过、无法解析、Executor 忽略 abort |
| 取消 | 启动前、运行中、重复、cancelEpoch、迟到 execute |
| 宽限 | 宽限期内返回、宽限期后 STOP_UNCONFIRMED、迟到结果丢弃 |
| 竞争 | deadline vs cancel、完成 vs cancel、VIOLATION vs cancel |
| 事实 | 唯一性、顺序、MODEL requestState/usage、非 MODEL 归一化 |
| stop | 定时器清理、STOP_UNCONFIRMED、重复 stop、投递失败 |
| Fabric | typed SupervisorPort、producer、not-ready、畸形 payload、correlation |
| shutdown | 响应先于模块停止 |

## 6. 阶段三退出条件核对

| 条件 | 结果 |
|---|---|
| execute、cancel 无占位实现 | 满足 |
| execution 表、Executor 查找与最小环境 | 满足 |
| notBefore、deadline、宽限期、cancelEpoch、startedAt、requestState | 满足 |
| 每个 execution 恰好一个终态 | 满足 |
| 正常、抛错、超时、取消、忽略取消、重复取消、迟到结果可验证 | 满足 |
| M1 的 Executor 能力最小权限 | 满足 |
| 真实 Fabric 路由、correlation、producer、not-ready、Schema | 满足 |
| 阶段三质量门与覆盖率 | 满足 |
| 未修改共享接缝 | 满足 |

## 7. 边界与遗留

以下事项明确属于后续阶段，不阻断阶段三验收：

| 事项 | 归属 |
|---|---|
| run actor、双通道 Inbox、OrderedSender、真实 Outbox | 阶段四 |
| `createKernelCore` 装配、真实启动与组合根联调 | 阶段四、六 |
| ModuleHost/Fabric/Persistence/ArtifactStore 真实故障联调 | 阶段五 |
| 真实模型 E2E 与 F1–F5 | M1 整机验收 |
| 可靠事实投递与投递失败重试 | 阶段五及后续 |
| 并行执行、跨进程 IPC、分片、生产级隔离 | 后续演进 |

已知实现边界：

- 进程内 Executor 无法被强制终止；无法确认停止时如实报告 `STOP_UNCONFIRMED`；
- `stop()` 不等待宽限期或事实投递完成，正常路径不应有在途执行；
- 事实投递失败只记录诊断，不重试执行，不伪造第二条事实；
- M1 仍是单运行、内存状态，不提供崩溃恢复或持久化执行表。

## 8. 工作收敛结论

阶段三代码工作已收敛：

- 不再以阶段三子阶段名义扩展功能；
- 后续修复应关联具体缺陷或阶段四至六任务；
- 阶段三以外的能力不得以占位成功响应进入产品路径；
- 共享接缝变更需单独评审并同步 contracts、testing 与相关 fake。

阶段三完成不表示 Kernel 或 M1 整机完成；阶段四仍需 run actor 与 `createKernelCore` 装配，
M1 验收仍以 [M1Plan](M1/M1Plan.md) 第 7 节和第 8 节为准。
