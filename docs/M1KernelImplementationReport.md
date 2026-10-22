# MultiAgentOS M1 Kernel 与 Infrastructure 总实现报告

> 状态：实现报告，2026-10-22 完成阶段六 6.1–6.6 的质量门与 PR 准备；实际分支推送与 PR 由负责人手动操作。
> 本文件不是规范；与 `docs/M1/` 冲突时以规范为准。
> 本文件随本分支进入 `feature/M1/main`，由项目主管人后续归档整理。

## 1. 背景、范围与交付结论

本报告汇总 M1 Kernel 与 Infrastructure 的实现、验收证据、外部依赖与交付边界。

交付范围：

- Kernel 六组件：Gateway、Core、Scheduler、Execution、Supervisor、Monitor；
- run actor、双通道 Inbox、Outbox、有序发送器与运行定时器；
- 四类基础设施：Fabric、ModuleHost、Persistence、ArtifactStore；
- 组合根、进程入口、启动期限、panic 五步与退出码；
- 与真实 Kernel/Infra 组合下的验收测试。

交付结论：

- 阶段一至阶段五已完成验收；
- 阶段六 6.1–6.5 已完成；
- 阶段六 6.6 质量门与 PR 准备完成，实际 PR 待负责人手动发起；
- Kernel 与 Infrastructure 在真实组件、fake 外部模块下完成内部闭环；
- M1 整机验收仍受真实 Workflow、UserInteraction、ExecutorSet 与真实模型 E2E 阻塞。

本报告不把 fake 外部模块通过解释为 M1 整机完成。

## 2. 阶段总览与提交索引

| 阶段 | 内容 | 状态 | 主要提交 |
| --- | --- | --- | --- |
| 一 | Core 控制逻辑与 Gateway 偏差修正 | 已完成 | `9f7c9f2`、`1fec492` |
| 二 | Execution、Scheduler 与 Monitor 接入 | 已完成 | `51fec05`、`9f5f09e` |
| 三 | Supervisor 执行控制 | 已完成 | `025eab5`、`959fdc4`、`2cf2456` |
| 四 | run actor、Outbox、定时器与 Kernel 工厂 | 已完成 | `04d2f63`、`ead9b15`、`2e0eab8` |
| 五 | 四类基础设施完善与故障联调 | 已完成 | `2e6eb15`、`7c32942`、`4caa373` |
| 六 | 启动保护、进程验收与基础设施矩阵 | 6.1–6.5 完成；6.6 质量门与 PR 准备完成，PR 待手动发起 | `2348ad7`、`6cddf8b`、`c86469e`、`0704fbb` |

补充提交：

- `586ea74`：补记阶段四交付提交哈希；
- `76d06a6`：补充阶段五交付提交与代码结构记录。

## 3. Kernel 六组件实现映射

| 组件 | 主要职责 | 代码位置 |
| --- | --- | --- |
| Gateway | 外部 syscall 唯一入口、身份与 Schema 检查、准入封锁、correlation 固定 | `packages/modules/kernel/src/gateway/` |
| Core | 运行管理、授权与 Lease、定义核验、结果检查、收敛、Outbox、审计 | `packages/modules/kernel/src/core/` |
| Scheduler | API 调用机会与容量 | `packages/modules/kernel/src/scheduler/` |
| Execution | UnitAttempt、FIFO、执行事实、产物归属、内建 report-publish、技术重试 | `packages/modules/kernel/src/execution/` |
| Supervisor | 生命周期、Executor 派发、notBefore/deadline、取消、宽限期、执行事实 | `packages/modules/kernel/src/supervisor/` |
| Monitor | token 账本、预留、结算、额度状态、final-call 保留额度 | `packages/modules/kernel/src/monitor/` |

关键不变量：

- Lease 只存在 Core；其他组件只取得裁决与派生范围。
- Execution 只经 `CoreSyscalls` 与 Core 交互。
- Monitor 只被 Core 调用；Scheduler 只分配 API 调用机会。
- 每个执行实例只产生一个终态执行事实。
- 尝试建立时的 `runEpoch` 决定交付资格；旧事实仍结算，但不能覆盖当前状态。

## 4. Infrastructure 实现映射

| 基础设施 | 主要实现 | 代码位置 |
| --- | --- | --- |
| Fabric | 同进程路由、Schema 校验、身份、`structuredClone`、Inbox、OrderedSender、停止排空 | `packages/infrastructure/fabric/` |
| ModuleHost | 依赖排序、启动/停止期限、回滚、生命周期账本、迟到完成隔离 | `packages/infrastructure/module-host/` |
| Persistence | 运行目录文件存储、原子 rename、审计追加排队、命名空间隔离、停止排空 | `packages/infrastructure/persistence/` |
| ArtifactStore | 本地内容寻址、SHA-256/size 复验、同内容复用、缺失/损坏检测 | `packages/infrastructure/artifacts/` |

职责边界：

- Fabric 由 Core 管辖，不决定业务、授权或结算。
- ModuleHost 由 Supervisor 驱动，不决定异常类别或退出码。
- `<dataDir>/tmp/` 只由 Supervisor 清空；Persistence 只确保目录可用。
- ArtifactStore 不判断业务访问权限；读取归属由 Execution 检查。

## 5. 运行 actor、Outbox、Supervisor 与 panic

### 5.1 运行 actor

- 每个 WorkflowRun 一个运行 Inbox，分控制与工作两个通道。
- 控制通道只在两条消息之间优先；一条消息处理完前不取下一条。
- 本地 I/O 可以等待；跨主体调用只登记待发送，处理结束后由 actor 之外的发送器按目标顺序发出。
- actor 每次 dispatch 后调用 `settleConvergence`，保证收敛收尾不在下一条消息处理期间完成。

### 5.2 Outbox 与事件

- 所有外部事件由 Core 的 Outbox 发出。
- Workflow 与 UserInteraction 各自维护接收方 `seq` 与唯一 `eventId`。
- RunClosed / RunFinished 是各自接收方的最后一个事件。
- 终态发送失败只记录；非终态发送失败进入 `KERNEL_FAULT`。

### 5.3 运行定时器

- 运行总时长 `RUN_TIMEOUT`；
- 授权 `AUTHORIZATION_TIMEOUT`；
- 收敛兜底 `CONVERGENCE_DEADLINE`。

定时器回调只向控制通道投递消息，不直接修改运行状态。

### 5.4 Supervisor

- `execute` 只登记并返回，启动在请求处理之外完成。
- 支持 `notBefore`、deadline、取消、启动前取消、宽限期与 `STOP_UNCONFIRMED`。
- 每个 executionId 恰好上报一个终态。
- 执行环境按 executionKind 最小化：只有 MODEL 取得凭据，只有 REPOSITORY_SEARCH 取得真实 subprocess。
- `rg` 是产品运行时唯一子进程，由 `SubprocessRunner` 管理。

### 5.5 panic 五步

1. 记录原始错误、唯一 faultId、stderr 诊断，封锁启动与命令入口；
2. 有期限调用 `abortAllRuns`；
3. 汇总并上报错误；
4. 有期限调用 `supervisor.stop`，失败后回退 `moduleHost.stop`；
5. 清理子进程并返回 `StopReport`，非零退出。

日志、kill、abort 或 stop 的失败只追加证据，不递归启动第二轮 panic。

## 6. 验收矩阵与质量门

### 6.1 质量门

环境：

```text
Ubuntu 24.04.5 LTS（WSL2）
Node.js v24.19.0
pnpm 11.25.0
```

```text
pnpm run check       通过
  78 个测试文件、912 项测试全部通过
pnpm run test:coverage
  全仓语句 94.27%、分支 85.64%、函数 92.22%、行 96.27%
pnpm run demo:fake   退出码 0
git diff --check     通过
```

### 6.2 Stage6 验收

`apps/control-plane/src/bootstrap/stage6-acceptance.test.ts` 使用真实 Fabric、
LocalArtifactStore、FilePersistence、ModuleHost、Kernel core、Gateway 与 Supervisor，
外部模块使用 fake，覆盖：

- 正常路径：createRun → 授权 → 六类 Unit → AnalysisReport → RunSummary →
  RunClosed/RunFinished；
- 产物、审计、报告与 RunSummary 的 Schema 和媒体类型；
- `RunSummary.units` 不变量、`model.requests`、未知效果为空；
- 授权拒绝与超时；
- 取消；
- 运行超时；
- 安全违规。

### 6.3 进程级验收

`apps/control-plane/test/process-entry.test.ts` 启动真实子进程，覆盖：

- 退出码 0、1、2、3、130、70；
- CLI 参数错误 64；
- 配置加载失败 70；
- 第一次 Ctrl+C 交给命令/UserInteraction；
- 第二次 Ctrl+C 由最后防线退出 130；
- `uncaughtException` 与 `unhandledRejection` 最小退出 70。

### 6.4 组件级矩阵

- Core、Execution、Monitor、Scheduler：Stage1–4 的单元与集成测试；
- Supervisor：deadline、取消、宽限期、迟到事实、唯一终态；
- Fabric、ModuleHost、Persistence、ArtifactStore：Stage5 的正常与故障矩阵；
- 预算、final-call、技术重试、STOP_UNCONFIRMED、重复/迟到事实：由组件测试覆盖。

## 7. 外部依赖与已知边界

外部阻塞：

- 真实 Workflow；
- 真实 UserInteraction/CLI；
- 真实 ExecutorSet；
- 真实模型 E2E、F1–F5 与 M1 整机验收。

已知边界：

- M1 为单进程、单活动运行、内存状态；
- Supervisor 与 Kernel 核心同进程，Executor 在进程内运行；
- `rg` 是唯一产品子进程；
- 无跨进程 IPC、数据库、持久化 Outbox/Inbox、崩溃恢复或生产级隔离；
- fake 外部模块通过不代表 M1 整机完成。

## 8. 七个工作文档与归档说明

| 文档 | 内容 |
| --- | --- |
| [M1-kernel-infra-plan](M1-kernel-infra-plan.md) | 分支计划、阶段状态与验收基线 |
| [M1KernelStage1](M1KernelStage1.md) | Core 与 Gateway 阶段报告 |
| [M1KernelStage2](M1KernelStage2.md) | Execution 与 Scheduler 阶段报告 |
| [M1KernelStage3](M1KernelStage3.md) | Supervisor 阶段报告 |
| [M1KernelStage4](M1KernelStage4.md) | run actor、Outbox 与 Kernel 工厂阶段报告 |
| [M1KernelStage5](M1KernelStage5.md) | 四类基础设施故障联调阶段报告 |
| [M1KernelStage6](M1KernelStage6.md) | 阶段六规划、实现与验收记录 |

本报告与以上七份工作文档随 PR 进入 `feature/M1/main`；项目主管人后续归档整理。
工作文档不是规范，规范以 `docs/M1/` 为准。

## 9. PR 范围、限制与后续工作

PR 范围：

- Kernel 与 Infrastructure 产品代码；
- 七个工作文档与本总实现报告；
- `docs/M1/` 下必要的规范更新；
- README 与文档入口更新。

PR 目标与方式：

- 从 `feature/M1/kernel-infrasturcture` 直接向 `feature/M1/main` 发起；
- 分支推送、PR 创建与合并由负责人手动操作；
- 使用 merge commit；
- 不使用 squash/rebase 改写受保护分支历史。

后续工作：

- 负责人手动推送分支并创建 PR；
- 真实 Workflow、UserInteraction、ExecutorSet 接入；
- 真实模型 E2E、F1–F5 与 M1 整机验收。

本报告不宣称 M1 整机完成。M1 完成标准仍以 [M1Plan](M1/M1Plan.md) 第 7、8 节为准。
