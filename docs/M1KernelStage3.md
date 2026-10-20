# MultiAgentOS M1 Kernel 阶段三工作规划

> 状态：工作文档，2026-10-19 完成阶段 3.1、3.2；2026-10-20 完成阶段 3.3；3.4–3.5 待实现。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.4 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范，不进入 `feature/M1/main`；与 `docs/M1/` 冲突时以规范为准。
> 本文件记录阶段三（3.1–3.5）的子阶段、工程决定、测试与验收计划，完成后改写为实现报告。

## 1. 目的与范围

阶段三只实现 Supervisor 的执行控制：

- 清除 `execute`、`cancelRun` 的 `NOT_IMPLEMENTED`；
- 建立 execution 表、Executor 查找与最小执行环境；
- 实现 `notBefore`、deadline、取消宽限期、cancelEpoch、`startedAt`、`requestState`；
- `execute` 受理即返回，执行结果作为独立 `ExecutionFact` 上报；
- 每个 `executionId` 恰好一个终态，丢弃重复与迟到结果；
- Executor 抛错规范化；宽限期内返回上报 `TERMINATED`，未返回上报 `STOP_UNCONFIRMED`；
- 按 executionKind 最小权限提供凭据与 subprocess 能力；
- 完成停止、清理与事实投递。

阶段三不做：

- run actor、双通道 Inbox、OrderedSender、真实 Outbox；
- `createKernelCore` 装配与真实启动；
- 基础设施真实故障矩阵；
- 真实模型 E2E、F1–F5 与 M1 整机验收；
- 并行执行、跨进程 IPC、分片或生产级隔离。

阶段三可以用真实 Fabric、受控 Executor 与 fake kernel-core 事实接收端完成验收，不依赖阶段四。

## 2. 当前基线

- 阶段一完成 Core 控制逻辑，阶段二完成 Execution、Scheduler 与 Monitor 接入。
- `packages/modules/kernel/src/supervisor/index.ts` 已完成引导、关闭、Fabric 注册与子进程清理；
  `execute`、`cancelRun` 与 `stop` 清理路径已实现（3.1–3.3），包括 deadline、宽限期、停止未确认与
  事实投递失败诊断。
- `SupervisorDeps` 已包含 `fabric`、`executors`、`credentials`、`moduleHost`、`config`、
  `dataDir`、`subprocess`、`now`。
- `SupervisorPort`、`ExecutionFactSink` 的 Fabric 存根与 `serveSupervisor`、`serveExecutionFacts`
  已存在。
- `attemptDispatcher` 是阶段二留给执行派发的接缝；阶段三不需要改它。
- 现有 Supervisor 测试覆盖引导、Fabric 注册、关闭、子进程清理、正常执行、事实投递、中断路径与
  停止清理。

## 3. 子阶段

### 3.1 执行表与正常终态

**状态：已完成（2026-10-19）。** 实现位于 `packages/modules/kernel/src/supervisor/`：
`execution-table.ts`、`execution-runner.ts`、`environment.ts`、`fact-mapper.ts`，由 `index.ts` 接线；
测试位于 `execution-runner.test.ts` 与 `execute.test.ts`。

**目标**

让 Supervisor 真正接受执行请求，并为正常结果产生唯一合法事实。

**工作**

- 新增内部 execution 表：`executionId → ExecutionEntry`。
- Entry 字段：请求、状态、`startedAt`、`endedAt`、中止原因、定时器、`correlationId`、terminal 标记。
- `execute`：
  - 受理后立即返回；
  - 按 `notBefore` 调度，缺省立即启动；
  - 启动不得在 handler 内同步执行。
- Executor 查找：
  - 按 `executionKind` 从 `deps.executors` 取；
  - 校验 `executor.executionKind` 与请求一致；
  - 缺失或不一致产生 `FAILED(INTERNAL, retryable = false)`。
- 最小执行环境：`scope`、`limits`、`signal`、`now`，以及按 kind 注入的凭据与 subprocess。
- 正常终态：`COMPLETED`、`REJECTED`、`FAILED`、`VIOLATION`。
- Executor 抛错：`FAILED(INTERNAL, retryable = false)`；MODEL `requestState = UNKNOWN`。
- 事实映射：统一 `toExecutionFact`，保证字段与 Schema 联合类型一致。
- 首次接入事实投递，保证每个 execution 只投递一次。

**测试**

- execute 返回早于 Executor 启动；
- notBefore 未来与过去；
- 五类 executionKind 都能进入受控 Executor；
- 四种正常结果的 fact 形状；
- Executor 抛错；
- registry 缺失或 kind 不一致；
- 重复 executionId 只保留第一次；
- 环境能力隔离。

**退出**

正常路径产生唯一合法 `ExecutionFact`，`execute` 不再抛 `NOT_IMPLEMENTED`。

### 3.2 截止时间与取消

**状态：已完成（2026-10-19）。** 实现位于 `execution-runner.ts` 的 deadline/cancel/grace 路径与
`fact-mapper.ts` 的 `toTerminationFact`；测试覆盖 deadline、启动前取消、运行中取消、停止未确认、
迟到结果、首个中止原因与 VIOLATION 例外。

**目标**

覆盖中断路径，保证唯一终态与可解释的未知效果。

**工作**

- deadline：按 `limits.deadline` 设置定时器，到点 abort，原因 `UNIT_TIMEOUT`。
- `cancelRun`：
  - 记录该运行的最大取消 runEpoch；
  - 对全部执行实例触发 abort；
  - 原因 `EXECUTION_CANCELLED`；
  - 尚未启动的实例直接 `TERMINATED`，无 `startedAt`。
- 启动前取消：清除 notBefore 定时器，不调用 Executor。
- 宽限期：从 abort 起算 `cancelGraceMs`。
- 宽限期内返回：`TERMINATED`；返回 `VIOLATION` 时例外上报 `VIOLATION`。
- 宽限期后：`STOP_UNCONFIRMED`；此后返回丢弃。
- 竞争：第一个触发者决定原因，后续触发不改变原因、不重置宽限期。
- 迟到 execute：`runEpoch < cancelEpoch` 时不启动，直接 `TERMINATED(EXECUTION_CANCELLED)`。
- 重复 cancel：不产生额外事实。

**测试**

- deadline 触发；
- 启动前取消；
- 运行中取消；
- Executor 响应 abort；
- Executor 忽略 abort；
- 宽限期后返回被丢弃；
- deadline 与 cancel 竞争；
- 重复 cancel；
- 迟到 execute；
- 同一 execution 只产生一个终态。

**退出**

正常、抛错、超时、取消、未确认停止、迟到结果全部可验证。

### 3.3 停止、清理与投递韧性

**状态：已完成（2026-10-20）。** `ExecutionRunner.stop()` 会封锁新执行、清理全部定时器、中止在途执行，
并对已启动但未确认的执行尽力上报 `STOP_UNCONFIRMED(EXECUTION_CANCELLED)`；事实投递失败记录到
`health().details`，不重试执行、不重复投递、不产生未处理拒绝。

**目标**

让停止路径和有缺陷的投递路径可控。

**工作**

- `stop()`：封锁新执行、中止在途执行、清理定时器，尽力上报 `STOP_UNCONFIRMED`，
  再停止 ModuleHost、回收子进程、清理临时资源。
- 不等待宽限期或事实投递完成；不伪造完成。
- 事实投递失败：记录诊断，不重试执行、不重复投递、不产生未处理拒绝。
- `health().details` 暴露最近投递错误与活动执行数。
- 终态后清理 execution 表项或写入 tombstone。
- 保持 `whenStopped()`、重复 `stop()` 与停止失败语义。

**测试**

- 有在途执行时 stop；
- Executor 忽略 abort 时 stop 有界返回；
- 事实投递失败；
- 无未处理拒绝；
- 定时器清理；
- 重复 stop；
- shutdown 与 stop 顺序。

**退出**

停止有界、幂等、不伪造完成、不重复投递。

### 3.4 Fabric 与跨组件集成

**目标**

验证 Supervisor 在真实通讯边界上的行为。

**工作**

- 内部 `serve` 辅助函数接收 `Envelope`，以取得 `correlationId`。
- 使用现有 Fabric 构造 `ExecutionFactSink`，不修改 `SupervisorDeps`。
- 真实 `InProcessFabric` + fake kernel-core 订阅端验证：
  - `execute`；
  - 受控 Executor 完成；
  - 事实进入 fake kernel-core；
  - `cancelRun`；
  - `shutdown`。
- 校验 producer、not-ready、Schema、`execute` 返回早于事实、correlation 延续。
- 不引入 run actor 或 `createKernelCore`。

**测试**

- 真实 Fabric 路由；
- 事实 Schema 校验；
- producer 错误；
- not-ready；
- 畸形 payload；
- shutdown 先返回再停止；
- 事实唯一性与顺序。

**退出**

Supervisor 通过真实 Fabric 接口完成一条执行闭环。

### 3.5 验收与报告

**工作**

- `pnpm run check`、`pnpm run test:coverage`、`pnpm run demo:fake`、`git diff --check`。
- 新增 `docs/M1KernelStage3.md` 实现报告内容。
- 更新 `docs/M1-kernel-infra-plan.md`：阶段三完成、实现状态、预留表、C07 进度。
- 确认未修改 `contracts`、`testing`、根构建配置或锁文件。
- 记录阶段四、阶段五与 M1 整机验收遗留。

**退出**

阶段三退出条件满足，报告与计划状态一致。

## 4. 工程决定

### 4.1 事实投递依赖

**决定：不修改 `SupervisorDeps`，在 Supervisor 内部用现有 Fabric 构造 `ExecutionFactSink`。**

- `@multiagentos/kernel` 已依赖 `@multiagentos/fabric`；
- `createExecutionFactSink` 已存在，fake supervisor 也使用同一方式；
- 修改 `SupervisorDeps` 属于共享接缝，需要同步 `M1Interface` 第 14.1 节、`packages/testing` 与组合根；
- 事实沿用 `execute` 请求的 `correlationId`，只用于追踪。

测试需要模拟投递失败时，通过 fake Fabric 或内部 sink 工厂实现，不扩大公共工厂签名。

### 4.2 Executor 抛错

**决定：`FAILED(INTERNAL, retryable = false)`。**

- 抛错通常是实现缺陷，不是可安全重试的技术错误；
- 避免 Execution 自动重试导致未知副作用重复发生；
- MODEL 的 `requestState` 为 `UNKNOWN`，因为请求可能已经发出；
- 非 MODEL 不携带 `usage` 与 `requestState`；
- `startedAt` 保留。

### 4.3 启动前取消

**决定：`TERMINATED(EXECUTION_CANCELLED)`，无 `startedAt`。**

- 不调用 Executor；
- MODEL `requestState = NOT_SENT`；
- 清除 notBefore 定时器；
- 记录取消 runEpoch。

### 4.4 deadline 与 cancel 竞争

**决定：第一个触发者决定原因。**

- 先到 deadline：`UNIT_TIMEOUT`；
- 先到 cancel：`EXECUTION_CANCELLED`；
- 后续触发不改变原因、不重置宽限期；
- 所有终态经单一 `finalize` 守卫；
- 宽限期内返回 `TERMINATED`，宽限期后 `STOP_UNCONFIRMED`。

### 4.5 VIOLATION 例外

**决定：宽限期内 Executor 返回 `VIOLATION` 时上报 `VIOLATION`，而不是 `TERMINATED`。**

- 安全违规证据不得被取消或超时路径吞掉；
- Core 仍可在收敛中升级为 `VIOLATION`；
- 其他结果仍按 `TERMINATED` 处理。

### 4.6 usage 与 requestState

**决定：按 ExecutionFact Schema 归一化。**

MODEL 的 `requestState`：

| 情况 | 值 |
| --- | --- |
| COMPLETED | `SENT` |
| 启动前取消 | `NOT_SENT` |
| Executor 提供 | 原值 |
| REJECTED 未提供 | `NOT_SENT` |
| FAILED / TERMINATED / VIOLATION / STOP_UNCONFIRMED 未提供 | `UNKNOWN` |

`usage`：

- MODEL 的 `TERMINATED`、`FAILED` 在 Executor 提供时保留；
- `STOP_UNCONFIRMED` 不带 `usage`；
- 非 MODEL 一律丢弃 `usage` 与 `requestState`。

### 4.7 事实投递失败

**决定：记录诊断，不重试执行，不重复投递，不产生未处理拒绝。**

- `finalize` 先设置 terminal；
- `facts.report` 失败写入 health 诊断；
- 不把投递失败伪装成执行成功或执行失败；
- 可靠投递与基础设施故障留至阶段五。

### 4.8 stop 与清理

**决定：先中止、清定时器，再停止模块；事实投递尽力而为。**

```text
stop()
  → ready = false
  → abort 全部 execution
  → 清理全部定时器
  → 尽力上报已启动但未确认的 STOP_UNCONFIRMED
  → moduleHost.stop()
  → killAll()
  → 清理 tmp
```

正常关闭没有在途执行，不应产生额外事实；panic 路径不等待宽限期或投递完成。

决定：`stop()` 触发的中止在 `ExecutionFact` 中使用 `EXECUTION_CANCELLED`。原因是
`TERMINATED` 与 `STOP_UNCONFIRMED` 只允许 `UNIT_TIMEOUT` 与 `EXECUTION_CANCELLED`，
而正常关闭没有在途执行，该路径主要用于故障清理。

### 4.9 确定性测试

**决定：使用 Vitest fake timers、注入 `now` 与受控 Executor，不新增定时器依赖。**

- fake timers 控制 notBefore、deadline、宽限期；
- 受控 Executor 使用 deferred Promise 与 `AbortSignal`；
- 忽略取消的 Executor 保持 pending，再推进宽限期；
- 测试配置覆盖 `cancelGraceMs` 与 `executionLimits`；
- 不调用真实模型、网络或真实 `rg`。

### 4.10 执行环境最小权限

| executionKind | credentials | subprocess |
| --- | --- | --- |
| MODEL | 真实 `deps.credentials` | 拒绝式 runner |
| REPOSITORY_SEARCH | 拒绝式 credentials | 真实 `deps.subprocess` |
| 其他 | 拒绝式 credentials | 拒绝式 runner |

拒绝式 credentials：`apiKeyFor: () => undefined`。

拒绝式 subprocess：返回 `{ exitCode: null, signal: null, stdout: '', truncated: false }`，不启动进程。

## 5. 执行实例与事实映射

```text
ACCEPTED（等待 notBefore）→ RUNNING ─┬→ COMPLETED / REJECTED / FAILED / VIOLATION
         │                           ├→ TERMINATED（宽限期内结束）
         │                           └→ STOP_UNCONFIRMED（宽限期内未结束）
         └→ TERMINATED（启动前被取消，无 startedAt）
```

规则：

- 每个 `executionId` 只产生一个终态；
- 重复 executionId 只保留第一次受理；
- 迟到 execute 与迟到结果都按已取消或已终态处理；
- `stop()` 不影响已经产生的终态；
- `STOP_UNCONFIRMED` 之后任何 Executor 返回都丢弃。

## 6. Fabric 集成

- `execute` 与 `cancelRun` 处理器仍由 Supervisor 在 Fabric 就绪后注册。
- `serve` 辅助函数需要把 `Envelope` 传给 handler，以取得 `correlationId`。
- 事实通过 `ExecutionFactSink` 发送到 `kernel-core.execution-facts`。
- producer 必须为 `kernel-core`；未 ready 时拒绝；Schema 由 Fabric 校验。
- 不新增公共 Schema，不修改 `SupervisorDeps`。

## 7. 测试矩阵

| 维度 | 用例 |
| --- | --- |
| 正常 | COMPLETED、REJECTED、FAILED(true/false)、VIOLATION、Executor 抛错 |
| 调度 | notBefore 未来/过去、execute 返回早于启动、重复 execute |
| 截止 | deadline 到点、deadline 已过、Executor 忽略 abort |
| 取消 | 启动前取消、运行中取消、重复取消、cancelEpoch、迟到 execute |
| 宽限 | 宽限期内返回、宽限期后返回、STOP_UNCONFIRMED、迟到结果丢弃 |
| 竞争 | deadline vs cancel、完成 vs cancel、违规 vs cancel |
| 事实 | 唯一性、MODEL requestState/usage、非 MODEL 无 usage/requestState、Schema 校验 |
| 环境 | MODEL 凭据、SEARCH subprocess、其他拒绝 |
| 生命周期 | stop、shutdown、重复 stop、定时器清理、投递失败、health 诊断 |
| Fabric | producer、not-ready、畸形 payload、correlation、真实路由 |

## 8. 文件布局

保持 `supervisor/index.ts` 公开导出不变，内部拆分：

```text
packages/modules/kernel/src/supervisor/
  index.ts                 createSupervisor、Fabric handler、生命周期
  execution-table.ts       entry、状态、cancelEpoch、finalize 守卫
  execution-runner.ts      调度、定时器、Executor 调用、abort
  environment.ts           按 kind 构造 ExecutorEnvironment
  fact-mapper.ts           ExecutorOutcome → ExecutionFact
  *.test.ts
```

`index.ts` 只负责装配与通讯，避免继续膨胀。

## 9. 风险与规避

| 风险 | 规避 |
| --- | --- |
| ExecutionFact 联合类型复杂，构造易错 | 单独 `fact-mapper.ts`，按 kind/outcome 穷举并测试 |
| 定时器与迟到结果竞争 | 单一 `finalize` 守卫、terminal 标记、清理全部 timer |
| stop 与投递互相等待 | 先 abort、清 timer，再停模块；投递尽力而为 |
| Executor 忽略 abort | 宽限期 + STOP_UNCONFIRMED，不假设可强制终止 |
| 投递失败产生未处理拒绝 | 所有 detached 任务带 catch，诊断写 health |
| 测试不稳定 | fake timers、deferred Executor、固定 now、无真实网络 |
| 范围蔓延到阶段四 | 不实现 run actor、createKernelCore、Outbox/Inbox |
| 共享接缝变更 | 不改 contracts/testing/SupervisorDeps；必须改时单独评审 |

## 10. 完成定义

阶段三完成必须同时满足：

- `supervisor/` 不再有 `NOT_IMPLEMENTED`；
- 正常、抛错、超时、取消、未确认停止、迟到结果全部有测试；
- 每个 execution 恰好一个合法 `ExecutionFact`；
- stop/shutdown 有界、幂等、不伪造完成；
- 未修改共享接缝；
- `pnpm run check`、coverage、demo、diff check 通过；
- `docs/M1KernelStage3.md` 与计划状态一致。

建议覆盖率目标：

- Supervisor 语句 ≥ 90%，分支 ≥ 80%；
- 全仓不低于阶段二的 92.45% / 83.06% / 89.43% / 94.55%。

建议提交拆分：

1. `feat: 实现 Supervisor 阶段 3.1-3.3 执行控制`
2. `feat: 完成 Supervisor 阶段 3.4-3.5 与阶段三实现报告`

## 11. 边界与遗留

| 事项 | 归属 |
| --- | --- |
| run actor、双通道 Inbox、OrderedSender、真实 Outbox | 阶段四 |
| `createKernelCore` 装配、真实启动与组合根联调 | 阶段四、六 |
| ModuleHost/Fabric/Persistence/ArtifactStore 真实故障联调 | 阶段五 |
| 真实模型 E2E 与 F1–F5 | M1 整机验收 |
| 可靠事实投递与投递失败重试 | 阶段五及后续 |
| 并行执行、跨进程 IPC、分片、生产级隔离 | 后续演进 |

## 12. 进度记录

| 日期 | 内容 | 验证 |
| --- | --- | --- |
| 2026-10-19 | 完成阶段三规划：确定 3.1–3.5 子阶段、工程决定、测试矩阵、文件布局与完成定义 | 仅文档修订；Prettier 与 `git diff --check` 检查 |
| 2026-10-19 | 3.1 完成：执行表、execute 受理与 notBefore、五类 Executor、最小环境、正常终态与抛错规范化、事实映射与 Fabric 投递；`cancelRun` 仍待 3.2 | `pnpm run check`（50 个文件、509 项）；supervisor 语句 91.01%、分支 76.19%；全仓语句 92.56%、分支 82.92%、行 94.63%；`demo:fake` 退出码 0；无共享接缝变更 |
| 2026-10-19 | 3.2 完成：deadline、cancelRun、cancelEpoch、启动前取消、宽限期、TERMINATED / STOP_UNCONFIRMED、迟到结果丢弃、首个中止原因与 VIOLATION 例外；Fabric cancel 路由已接入 | `pnpm run check`（50 个文件、524 项）；supervisor 语句 91.87%、分支 80.32%；全仓语句 92.59%、分支 83.06%、行 94.65%；`demo:fake` 退出码 0；无共享接缝变更 |
| 2026-10-20 | 3.3 完成：stop 封锁新执行、清理全部定时器、在途执行尽力上报 STOP_UNCONFIRMED(EXECUTION_CANCELLED)、投递失败写 health、重复 stop 幂等；Fabric stop 前事实投递已验证 | `pnpm run check`（50 个文件、528 项）；supervisor 语句 92.30%、分支 80.70%；全仓语句 92.62%、分支 83.08%、行 94.65%；`demo:fake` 退出码 0；无未处理拒绝 |
