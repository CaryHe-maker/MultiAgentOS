# MultiAgentOS M1 Kernel 阶段四实现报告

> 状态：工作文档，2026-10-21 完成阶段四实现验收。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.5 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范，不进入 `feature/M1/main`；与 `docs/M1/` 冲突时以规范为准。
> 本文件记录阶段四（4.1–4.6）的实际实现、验证证据、边界与遗留事项。

## 1. 验收结论

阶段四（Run actor、Kernel 内部联调与 `createKernelCore`）通过验收。

验收范围：

- 运行 actor 的双通道 Inbox、控制优先、串行不可重入与生命周期接口；
- Core 的 `startRun`、`settleConvergence`、收敛收尾与异常入口；
- Core、Execution、Monitor、Scheduler 的运行级接线；
- `RunEgress`、每接收方 `seq`/`eventId` 与四类 `OrderedSender`；
- Supervisor、Gateway、Workflow、UserInteraction 的待发送与排空；
- 运行超时、授权超时、收敛兜底定时器；
- 请求、队列消息、发送器与 `KERNEL_FAULT` 的失败边界；
- `RunRegistry` 的 actor 生命周期、shutdown、abortAllRuns 与墓碑；
- `createKernelCore`、Fabric 入口、execution fact 订阅、health 与关闭；
- 真实 Kernel core + Supervisor 与 fake 外部模块的组合链验证。

本阶段不包含：

- ModuleHost、Fabric、Persistence、ArtifactStore 的完整故障矩阵（阶段五）；
- 真实组合根启动、panic 五步与退出码完整联调（阶段六）；
- 真实 Workflow、UserInteraction、ExecutorSet 的产品实现；
- 真实模型 E2E、F1–F5 与 M1 整机验收。

阶段四代码工作已收敛。后续改动应属于阶段五、六、缺陷修复或单独的接口调整，
不再以阶段四子阶段名义扩展功能。

## 2. 交付范围与代码结构

阶段四实现集中在：

```text
packages/modules/kernel/src/run-actor/
  messages.ts             运行消息、通道与消息分类
  actor.ts                RunActor、双通道 Inbox、失败与关闭接口
  egress.ts               RunEgress、Outbox、四个 OrderedSender
  timers.ts               RunTimers、runTimerConfig
  kernel-run.ts           KernelRunProcessor、createKernelRun
  index.ts                run-actor 导出
  run-actor.test.ts       actor、定时器、失败边界
  egress.test.ts          Outbox、目标顺序、终态与失败观察
  kernel-run.test.ts      Core/Execution 运行级纵向链
packages/modules/kernel/src/core/
  request-handler.ts      startRun、settleConvergence、收敛收尾
  run-registry.ts         actor 生命周期、shutdown、abortAllRuns
  run-registry.test.ts    handler 与 actor 两条路径
  index.ts                导出 RunActorPort
packages/modules/kernel/src/
  kernel-core.ts          createKernelCore、Fabric 入口、生命周期
  kernel-core.test.ts     Factory、Fabric 入口与停止
  stage4-integration.test.ts
                          真实 Kernel core 的超时、取消、shutdown 与 abort
apps/control-plane/src/bootstrap/
  compose-system.test.ts  真实 Kernel + Supervisor + fake 外部模块
```

已提交：

- 4.1–4.2：`04d2f63`（运行 actor 与 Core 收敛接线）；
- 4.3–4.4：`ead9b15`（Outbox、定时器与失败边界）；
- 4.5–4.6 与本报告：当前工作树提交。

未修改：

- `packages/libraries/contracts`；
- `packages/testing`；
- 根构建、检查与锁文件。

## 3. 实现内容

### 3.1 运行 actor

`run-actor/messages.ts`：

- `RunMessage`：
  - 控制：`RUN_INIT`、`CANCEL_RUN`、`RUN_TIMEOUT`、`AUTHORIZATION_TIMEOUT`、
    `CONVERGENCE_DEADLINE`、`KERNEL_FAULT`，以及终止、违规、停止未确认的执行事实；
  - 工作：GatewayForward 请求，以及正常完成、拒绝、失败的执行事实。
- `runChannelOf` 按消息类型和执行结果分配通道。

`run-actor/actor.ts`：

- 使用 Fabric 通用 `Inbox`，配置 `control` / `work` 两个通道。
- 一条消息处理完才取下一条；控制通道只在两条消息之间优先。
- `RunActor` 提供：
  - `start`、`init`、`cancel`、`abort`；
  - `forward`、`reportFact`、`timer`；
  - `markClosed`、`whenClosed`、`drain`、`stop`。
- 每次 dispatch + settle 后调用 egress flush。
- 请求处理失败：投递一次 `KERNEL_FAULT` 后拒绝调用方。
- 队列消息失败：Inbox 失败观察者投递 `KERNEL_FAULT`。
- `KERNEL_FAULT` 自身失败：调用 `onFatal`，不递归投递。
- 已停止或已 CLOSED 的 actor 不再注入新故障。

### 3.2 Core 收敛收尾

`core/request-handler.ts`：

- 新增 `startRun(run)`：处理 `RUN_INIT`，每个运行只发出一次 `RunStart`。
- 新增 `settleConvergence(run)`：
  - 唯一完成收敛的入口；
  - 等待 `#convergenceStarts` 中尚未完成的收敛启动；
  - 完成 RunSummary 发布、终态事件生成与 `onRunClosed`；
  - 收尾失败通过 `#failConvergence` 上报。
- 收敛启动通过 `#convergenceStarts` 与 `#settleRequested` 登记，不再由
  `#onResultSettled` 或 `#beginConvergence` 直接异步完成。
- `handleForward`、`handleCoreException`、`runTimedOut`、`convergenceDeadline` 在自身处理末尾
  调用 `settleConvergence`；actor 仍在每次 dispatch 后调用同一入口，保持幂等。
- 新增 `beginShutdown` 与 `beginAbort`，供 actor 的 `CANCEL_RUN` 与 `KERNEL_FAULT` 使用。

### 3.3 RunEgress 与有序发送

`run-actor/egress.ts`：

- `RunEgress` 实现 `CoreEventSink`、`AttemptDispatcher` 与 `CoreSupervisorPort`。
- handler 内只登记待发送，`flush()` 后再交给发送器。
- 每个接收方独立维护 `seq`、`eventId` 与 `occurredAt`：
  - Workflow：`RunStart`、`UnitReport`、`RunClosed`；
  - UserInteraction：`AuthorizationRequest`、`AuthorizationResolved`、`RunFinished`。
- 四个 `OrderedSender`：
  - Supervisor；
  - Gateway admission；
  - Workflow Inbox；
  - UserInteraction Inbox。
- Supervisor 使用单队列，`execute` 先于后续 `cancelRun`。
- `RunClosed` / `RunFinished` 是各自接收方的最后一个事件。
- `drain()` 等待全部发送器排空。
- 发送失败通过 `RunSendFailure` 上报；终态失败带 `terminal = true`。

### 3.4 运行定时器

`run-actor/timers.ts`：

- `runTimerConfig(config)` 派生运行、授权、收敛兜底三个期限。
- `RunTimers` 通过 `RunEgress` 的事件与 admission 观察启动和清理：
  - `RunStart` → 运行超时；
  - `AuthorizationRequest` → 授权超时；
  - `AuthorizationResolved` → 清理授权计时；
  - `CONVERGING` → 清理运行/授权计时并启动收敛兜底；
  - `RunClosed` / `RunFinished` / `CLOSED` → 清理全部计时。
- 定时器回调只投递控制消息，不修改运行状态。
- actor 停止、运行关闭或 timer 已关闭后，迟到回调被忽略。

### 3.5 RunRegistry 与 createKernelCore

`core/run-registry.ts`：

- 新增 `RunActorPort`，保持 Core 对 run-actor 的结构依赖而非直接导入。
- `createRun`：校验仓库路径、建立 `RunState`、创建并启动 actor、投递 `RUN_INIT`。
- `handleForward`、`report` 优先路由到 actor；保留旧 handler 路径。
- `auditFactory` 按运行取得 `kernel-core` 审计入口。
- `shutdown`：`actor.cancel()` → CLOSED → drain → 墓碑 → `onDrained`。
- `abortAllRuns`：`actor.abort(faultId)` → CLOSED → drain，带期限兜底。
- `stop()`：停止并排空 actor。

`kernel-core.ts`：

- 注册 `GatewayForward` Fabric 处理器，校验 producer。
- 订阅 `kernel-core.execution-facts`。
- 每个运行构造 `RunEgress`、`createKernelRun`、`RunActor` 与 `RunTimers`。
- 使用 `PersistencePort.auditLog('kernel-core', workflowRunId)` 作为运行审计。
- 构造 Supervisor、Workflow Inbox、UserInteraction Inbox 与 Gateway admission 存根。
- 实现 `start`、`stop`、`health`、`abortAllRuns` 与 manifest。
- 正常关闭在 actor 与 Outbox 排空后调用 `SupervisorPort.shutdown`。
- `onFatal` 绑定 `reportSystemFault`，保留组合根 panic 的入口。

### 3.6 内部闭环验证

- `stage4-integration.test.ts` 使用真实 Kernel core：
  - `RUN_TIMEOUT` 收敛；
  - `cancelRun` 收敛为 `CANCELLED`；
  - `shutdown` 排空后请求 Supervisor 停止；
  - `abortAllRuns` 收敛为 `FAILED(KERNEL_INTERNAL)`。
- `kernel-core.test.ts` 验证 Fabric 入口、非法仓库拒绝、错误 producer、health 与幂等 stop。
- `compose-system.test.ts` 使用真实 Kernel core、Gateway 与 Supervisor，fake Workflow、
  UserInteraction、ExecutorSet，完成 createRun 到 RunFinished 的纵向链。

## 4. 关键设计决定

### 4.1 唯一收敛完成入口

`settleConvergence` 是唯一完成收敛的入口。所有直接调用路径在自身处理末尾调用它，
actor 在每次 dispatch 后调用它；重复调用幂等。这消除了 RunSummary 发布期间处理下一条消息的竞态。

### 4.2 Outbox 与待发送分离

handler 只登记事件和跨主体请求，`RunEgress.flush()` 后交给发送器。发送顺序由目标队列保证，
不会在状态处理完成前发送。

### 4.3 正常关闭由 Kernel core 发起

M1 保持：

```text
Kernel core 完成 actor 收敛与 Outbox 排空
  → SupervisorPort.shutdown
  → Supervisor 停止模块与进程
```

多进程演进时由单一系统关闭协调者请求所有 Kernel core 实例 drain，再调用一次
`SupervisorPort.shutdown`；Supervisor 只执行停止，不作为正常运行收敛的发起者。

### 4.4 KERNEL_FAULT 由 Kernel 触发

请求失败、队列消息失败和非终态发送失败由 actor 触发 `KERNEL_FAULT`。
Gateway、Fabric、OrderedSender 不直接创建故障消息。终态发送失败只记录，不触发故障。
当前 `SyscallRejected` 不新增 `KERNEL_INTERNAL`；调用方收到传输失败，运行通过 `KERNEL_FAULT` 收敛。

### 4.5 定时器只入队

运行、授权和收敛计时器只向控制通道投递消息，不在回调中修改运行状态；关闭后迟到回调被忽略。

### 4.6 Kernel 模块成品边界

阶段四只保证 Kernel 与其他 Module 对接时是成品。真实 Workflow、UserInteraction、
ExecutorSet、模型 E2E 与整机验收仍属于外部交付或后续阶段。

## 5. 验证与证据

### 5.1 质量门

环境：

```text
Ubuntu 24.04.5 LTS（WSL2）
Node.js v24.19.0
pnpm 11.25.0
```

```text
pnpm run check       通过
  55 个测试文件、561 项测试全部通过
pnpm run test:coverage
  全仓语句 93.15%、分支 83.98%、函数 88.77%、行 94.93%
pnpm run demo:fake   退出码 0
git diff --check     通过
```

### 5.2 覆盖率

```text
kernel/kernel-core        语句 92.42%  分支 70.45%  行 95.00%
kernel/core              语句 90.54%  分支 81.74%  行 93.17%
kernel/core run-registry 语句 93.61%  分支 87.50%  行 95.62%
kernel/execution         语句 87.32%  分支 80.79%  行 89.62%
kernel/gateway           语句 89.01%  分支 78.43%  行 93.84%
kernel/monitor           语句 95.04%  分支 93.75%  行 96.59%
kernel/run-actor         语句 92.11%  分支 82.50%  行 97.05%
kernel/supervisor        语句 93.13%  分支 82.67%  行 96.24%
```

### 5.3 测试覆盖矩阵

| 范围 | 覆盖 |
|---|---|
| actor | 控制优先、不可重入、事实通道、settle/flush、请求失败、停止与关闭 |
| Core 收敛 | RUN_INIT、RunStart、收敛启动、settleConvergence、旧 epoch、终态事件 |
| Outbox | eventId、seq、接收方、目标内顺序、终态最后、发送失败 |
| 定时器 | 运行超时、授权超时、收敛兜底、授权解决、CLOSED 清理 |
| 失败边界 | 队列失败、请求失败、KERNEL_FAULT 二次失败、终态发送失败 |
| RunRegistry | handler 与 actor 路径、createRun、shutdown、abortAllRuns、墓碑 |
| Kernel 工厂 | Fabric 入口、错误的 producer、非法仓库、health、幂等 stop |
| Kernel core 集成 | RUN_TIMEOUT、CANCEL、shutdown→Supervisor、abortAllRuns |
| 组合根 | 真实 Kernel core + Gateway + Supervisor + fake 外部模块纵向链 |
| 架构 | 组件导入边界、代码检查与全仓质量门 |

## 6. 阶段四退出条件核对

| 条件 | 结果 |
|---|---|
| 双通道 Inbox、控制优先、串行且不可重入 | 满足 |
| 每次处理执行 `settleConvergence` | 满足 |
| 待发送在状态处理与收尾后按目标有序发送 | 满足 |
| Core、Execution、Scheduler、Monitor、Gateway、Supervisor 事实通道接线 | 满足 |
| 消息级失败、非停机异常与 `KERNEL_FAULT` 可验证 | 满足 |
| `createKernelCore`、生命周期、health、abortAllRuns | 满足 |
| 全部运行 CLOSED 且 Outbox 排空后推进关闭 | 满足 |
| Supervisor shutdown 不在响应路径中形成等待环 | 满足，组合根集成验证通过 |
| Kernel 产品路径无占位实现 | 满足；剩余 `NOT_IMPLEMENTED` 仅存在于外部产品测试预期 |
| 阶段四质量门 | 满足 |

## 7. 边界与遗留

以下事项明确属于后续阶段，不阻断阶段四验收：

| 事项 | 归属 |
|---|---|
| ModuleHost/Fabric/Persistence/ArtifactStore 真实故障矩阵 | 阶段五 |
| 组合根真实启动、panic 五步、退出码与进程级测试 | 阶段六 |
| 真实 Workflow、UserInteraction、ExecutorSet 产品实现 | 外部分支 |
| 真实模型 E2E、F1–F5 与 M1 整机验收 | M1 整机验收 |

已知实现边界：

- Stage4 的组合根集成使用 fake 外部模块；真实产品 `composeSystem` 仍受外部模块占位阻塞。
- `onFatal` 已绑定 `reportSystemFault`，但完整 panic、停止期限和退出码验证属于阶段六。
- 终态发送失败当前由 `RunEgress` 记录；正式审计写入可在阶段五/六补齐。
- M1 仍是单运行、内存状态，不提供崩溃恢复、并行执行或跨进程 IPC。

## 8. 工作收敛结论

阶段四代码工作已收敛：

- 不再以阶段四子阶段名义扩展功能；
- 后续修复应关联阶段五、六或具体缺陷；
- Kernel 模块产品路径无占位实现；
- 共享接缝变更需单独评审并同步 contracts、testing 与 fake。

阶段四完成不表示 M1 整机完成；M1 验收仍以
[M1Plan](M1/M1Plan.md) 第 7 节和 [M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6 节为准。
