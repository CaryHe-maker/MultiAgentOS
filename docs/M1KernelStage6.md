# MultiAgentOS M1 Kernel 阶段六实施计划

> 状态：临时工作文档，2026-10-22 完成规划；6.1–6.5 已完成，待继续 6.6。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.7、6.8 节，[SystemFaultHandling](M1/SystemFaultHandling.md)，
> [M1Interface](M1/M1Interface.md) 第 14 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范；随本分支进入 `feature/M1/main`，由项目主管人后续归档整理。与 `docs/M1/` 冲突时以规范为准。

## 1. 目的与范围

阶段六的目标是收尾 Kernel 与 Infrastructure，使 `feature/M1/kernel-infrasturcture` 达到：

1. 真实组合根可以启动、引导、运行与关闭；
2. `bootMs`、panic 五步、退出码、信号与最后防线完整；
3. Kernel 与四类基础设施在真实组件下完成最终验收；
4. 文档、README、阶段报告与总实现报告齐备；
5. 可以向 `feature/M1/main` 发起 PR。

阶段六不实现真实 Workflow、UserInteraction、ExecutorSet、真实模型 E2E 或 F1–F5。
这些能力仍是外部阻塞，阶段六只记录并明确区分，不以 fake 通过宣称 M1 整机完成。

## 2. 当前基线

| 项目 | 状态 |
| --- | --- |
| 分支 | `feature/M1/kernel-infrasturcture` |
| 代码基线 | `76d06a6` |
| Stage1–5 | 已完成并验收 |
| Stage6 | 未开始 |
| 质量门 | 55 个测试文件、575 项测试通过 |
| 覆盖率 | 语句 93.43%、分支 84.38%、函数 89.20%、行 95.13% |
| fake demo | 退出码 0 |
| 工作树 | 干净 |

阶段五已关闭四类基础设施的正常路径与故障矩阵。阶段六仍缺少组合根真实启动、panic、
退出码、进程级测试与 PR 文档收尾。

## 3. 当前缺口

### 3.1 启动与组合根

- `ShutdownTimeouts` 缺少 `bootMs`；`SystemControl.start()` 无系统引导总期限。
- 进程保护在 `loadSystemConfig()` 与 `composeSystem()` 之后才安装。
- 配置、Catalog、工厂构造期间的异常没有进入组合前保护。
- `composeSystem()` 构造失败时缺少统一清理；runner 或部分资源可能残留。
- 组合根的空 `reportSystemFault` 绑定窗口仍需消除。

### 3.2 panic 与清理

- `SystemControl.record()` 的 `log` 失败会阻断后续停机。
- `SystemControl.shutdown()` 的 `killSubprocesses` 失败可能使 `StopReport` 无法返回。
- `SystemControl.run()` 未捕获 `command()` 的同步抛错。
- 需要按 `SystemFaultHandling` 第 5 节逐项核对 panic 五步与期限。
- 需要验证重复故障共用 `faultId`、清理失败继续、已收敛运行不被改写。

### 3.3 进程入口与退出码

- `index.test.ts` 只覆盖 `main()` 的 CLI 参数错误。
- 缺少真实子进程测试：64、70、130、0/1/2/3、`uncaughtException`、`unhandledRejection`。
- 第一次/第二次 Ctrl+C、无运行首次中断、SIGTERM 默认行为尚未做进程级验收。
- 真实产品入口受外部模块 `NOT_IMPLEMENTED` 阻塞，需要独立测试入口或 fake parts。

### 3.4 文档与 PR

- README 已更新 Kernel/Infra 实现状态与外部模块阻塞（6.5）。
- 阶段六报告与总实现报告已创建（6.5）。
- 七个工作文档头部已改为随 PR 进入 `feature/M1/main`（6.5）。
- `M1-kernel-infra-plan.md` 第 10 节已改为正常导出全部工作文档与总报告（6.5）。
- 导出分支与 PR 说明仍待 6.6。

## 4. 已确认决策

| 编号 | 决策 |
| --- | --- |
| D1 | `ShutdownTimeouts.bootMs` 默认 60000 毫秒，必须为正安全整数。 |
| D2 | 进程保护在配置、Catalog、模块构造之前安装；组合成功后交给 `SystemControl`。 |
| D3 | 进程级测试使用独立测试入口或 fake parts，不修改产品 `main()` 的公开签名。 |
| D4 | `composeSystem` 的测试注入只改 `apps/control-plane` 内部类型，不进入 contracts。 |
| D5 | PR 目标为 `feature/M1/main`，使用 merge commit，不使用 squash/rebase 改写历史。 |
| D6 | PR 包含本分支七个工作文档和一份总实现报告；由项目主管人后续归档整理。 |
| D7 | 不新增公共 Schema，不修改其他团队负责的模块目录。 |
| D8 | 真实 Workflow、UserInteraction、ExecutorSet 与真实模型 E2E 仍为外部阻塞。 |

## 5. 子阶段规划

### 6.1 启动总期限、组合前保护与构造清理

**目标**：让配置失败、装配失败和启动失败都进入有界、可诊断、可清理的路径。

**工作项**

- 在 `ShutdownTimeouts` 增加 `bootMs`：
  - 默认 60000；
  - 正安全整数校验；
  - `composeSystem` 接受覆盖；
  - `SystemControl.start()` 以 `bootMs` 包裹 `supervisor.start()`。
- `bootMs` 到期：
  - 记录唯一 `faultId`；
  - 进入有界 shutdown；
  - 拒绝 `system.start()`；
  - 迟到完成不得重新开放业务。
- 进程保护前移：
  - 在配置、Catalog 与模块构造前安装最后防线；
  - 建立组合前最小诊断与 panic 入口；
  - 组合成功后交给 `SystemControl`，消除空上报窗口。
- 子进程 runner：
  - 组合前创建或通过可变持有器登记；
  - 装配失败时同步 `killAll()`；
  - `composeSystem` 支持可选 runner 注入，不修改 contracts。
- `composeSystem` 构造失败清理：
  - 工厂、Catalog、ModuleHost 注册失败时清理已取得资源；
  - 不启动未完成构造的模块；
  - 不留下未处理拒绝。

**测试重点**

- `supervisor.start()` 永不完成；
- `bootMs` 超时后迟到成功与迟到失败；
- 配置、Catalog、工厂构造失败；
- 部分模块构造后失败，runner 被终止；
- 配置加载前的进程保护；
- 非法 `bootMs`、`startTimeoutMs`、`stopTimeoutMs`。

**退出条件**

- 所有启动路径都有期限；
- 配置、装配、引导失败均诊断并返回 70；
- 无子进程泄漏、无未处理拒绝；
- `start()` 失败后不会重新进入 READY。

**完成记录（2026-10-22）**

- `ShutdownTimeouts.bootMs` 已加入，默认 60000 毫秒；`createSystemControl` 校验
  `bootMs`、`abortRunsMs`、`stopMs`、`settleMs` 为正安全整数。
- `SystemControl.start()` 使用 `bootMs` 包裹 `supervisor.start()`；超时记录 Supervisor
  boot fault，进入有界 shutdown 并抛出，迟到完成不会重新 READY。
- `apps/control-plane` 组合根增加 `BOOT_TIMEOUT_MS = 60000` 并传入 control。
- `main()` 在加载配置与组合前创建 runner、安装进程保护，并创建 deferred fault reporter；
  配置、Catalog、工厂或装配失败记录为 composition-root boot fault 并返回 70。
- `composeSystem` 接受可选 `subprocess` 与 `reportSystemFault`；构造失败时调用
  `subprocess.killAll()` 后重新抛出。
- 新增 `deferred-fault-reporter.ts`：组合前缓冲故障，绑定 `SystemControl` 后转发；
  logger 或 target 抛错不阻断上报。
- 测试新增：`bootMs` 超时与迟到启动、非法 `bootMs`、工厂失败时 runner 清理、
  配置加载失败返回 70、deferred reporter 缓冲/转发/失败韧性。
- 验证：`pnpm run check` 通过（56 个测试文件、582 项测试）；
  `pnpm run test:coverage` 全仓语句 93.47%、分支 84.47%、函数 89.26%、行 95.18%；
  `pnpm run demo:fake` 退出码 0。

### 6.2 panic 五步、StopReport 与故障韧性

**目标**：按 `SystemFaultHandling` 第 5 节完成组合根唯一 panic 流程。

**工作项**

- 核对并补齐五步：
  1. 登记原始错误、唯一 `faultId`、写 stderr、封锁启动与命令入口；
  2. 有期限调用 `kernelCore.abortAllRuns`；
  3. 汇总并上报用户；
  4. 有期限调用 `supervisor.stop`，失败或超时走 `moduleHost.stop`；
  5. 同步清理子进程，汇总 `StopReport`，非零退出。
- 重复故障共用 `faultId`，保留不同步骤证据，不递归启动第二轮 panic。
- 韧性：
  - `log` 抛错不阻断清理和退出；
  - `killSubprocesses` 抛错不阻断 `StopReport`；
  - stderr 不可用时仍尝试清理；
  - 已收敛运行不被 panic 改写。
- `SystemControl.run()` 捕获 `command()` 同步抛错、拒绝与 settle 超时。
- `abortAllRuns` 只由组合根调用，不经 Gateway/Fabric，不停止模块。
- 终态事件失败只记录；非终态发送失败进入 `KERNEL_FAULT`。

**测试重点**

- 五步顺序与期限；
- `abortAllRuns` 超时后继续 stop；
- `supervisor.stop` 失败后走 `moduleHost.stop`；
- 模块 stop 失败后继续清理；
- Fabric、Persistence、ArtifactStore 不可用；
- stderr/log 失败仍退出；
- kill 失败仍返回 `StopReport`；
- 重复故障共用一个 `faultId`；
- 已 CLOSED 运行不被改写。

**退出条件**

- `SystemFaultHandling` §5、§8 的 panic 与 StopReport 场景均有证据；
- 任何 panic 不以 0 退出；
- 清理失败不会掩盖原始错误。

**完成记录（2026-10-22）**

- `SystemControl.record()` 的日志写入改为受控诊断：logger 抛错不影响故障记录、清理或退出。
- `shutdown()`：
  - 使用 `invoke()` 包装 `abortAllRuns`、`supervisor.stop` 与 `moduleHost.stop`，
    同步抛错与异步拒绝都按有界失败处理；
  - `killSubprocesses()` 抛错记录为 composition-root fault，但仍返回 `StopReport`；
  - `moduleHost.ledger()` 抛错记录为 module-host fault，报告仍可返回。
- `reportFault()` 的后台 shutdown 增加拒绝观察，不产生未处理拒绝。
- `supervisor.whenStopped()` 的同步抛错也被转为 supervisor shutdown fault。
- `SystemControl.run()` 捕获 `command()` 同步抛错，记录 entry fault、执行有界 shutdown 并返回 70。
- 测试新增：
  - logger 抛错仍完成故障收敛；
  - 同步命令抛错；
  - `abortAllRuns` 同步抛错后继续 stop；
  - `killSubprocesses` 抛错仍返回 `StopReport`；
  - `supervisor.stop` 同步抛错后回退 `moduleHost.stop`。
- 验证：`pnpm run check` 通过（56 个测试文件、586 项测试）；
  `pnpm run test:coverage` 全仓语句 93.45%、分支 84.56%、函数 89.24%、行 95.15%；
  `pnpm run demo:fake` 退出码 0。

### 6.3 进程入口、信号与退出码

**目标**：完成真实进程级入口和退出码矩阵。

**工作项**

- `apps/control-plane/src/index.ts`：
  - 解析 CLI → 安装进程保护 → 加载配置/Catalog → 组装 → 启动 → 运行；
  - CLI 参数错误 64，不启动系统；
  - 配置/装配失败 70，并清理已登记资源。
- `apps/control-plane/src/bin.ts`：
  - 保持 `process.exitCode`，不调用 `process.exit`；
  - 最后防线失败时写诊断并 70；
  - 终端适配器不得自行退出进程。
- `process-guards.ts`：
  - `fatal` 与第二次 Ctrl+C 中 log 失败仍 kill + exit；
  - kill 失败仍 exit；
  - `uncaughtException` / `unhandledRejection` 走最小退出 70；
  - 第一次 Ctrl+C 交给 UserInteraction，第二次由组合根退出 130；
  - SIGTERM 保持 Node 默认行为。
- 真实子进程测试：
  - 使用独立 Node 子进程和测试入口脚本；
  - 使用真实 Kernel/Infra + fake 外部模块；
  - 不在测试主进程触发 `exit`。
- 覆盖：
  - CLI 参数错误 64；
  - 正常退出 0；
  - FAILED 1；
  - RUN_TIMEOUT 2；
  - VIOLATION 3；
  - CANCELLED / 第二次 Ctrl+C 130；
  - panic 70；
  - 无运行第一次 Ctrl+C 不退出；
  - `uncaughtException` / `unhandledRejection` 70。

**退出条件**

- 真实子进程退出码矩阵全部通过；
- 所有退出路径完成必要清理；
- 普通任务失败不误判为 panic；
- 停机异常不以 0 退出。

**完成记录（2026-10-22）**

- `process-guards.ts` 加固：
  - `uncaughtException` / `unhandledRejection` 的日志或 `killSubprocesses` 抛错不再阻止非零退出；
  - 第二次 Ctrl+C 的日志或清理失败仍退出 130；
  - `exit` 钩子的清理失败被隔离。
- 新增测试入口 `apps/control-plane/test/process-entry.ts`：
  - 使用真实组合、`SystemControl` 与进程保护；
  - 外部模块使用 fake；
  - 覆盖正常、失败、超时、违规、取消、panic、同步抛错、未捕获异常与未处理拒绝。
- 新增真实子进程测试 `apps/control-plane/test/process-entry.test.ts`：
  - 退出码 0、1、2、3、130、70；
  - 64 参数错误；
  - 配置加载失败 70；
  - 第一次 Ctrl+C 留给命令/UserInteraction，第二次由最后防线退出 130；
  - 子进程测试不污染测试主进程。
- 调整 ESLint 架构规则：仅测试入口允许导入 `node:child_process`，产品代码仍只允许 Supervisor 创建子进程。
- 验证：`pnpm run check` 通过（57 个测试文件、600 项测试）；
  `pnpm run test:coverage` 全仓语句 93.46%、分支 84.62%、函数 89.24%、行 95.15%；
  `pnpm run demo:fake` 退出码 0。

### 6.4 Kernel 与 Infra 验收矩阵

**目标**：用真实 Kernel、四类基础设施和组合根完成最终验收。

**组合方式**

```text
真实 Fabric
真实 LocalArtifactStore
真实 FilePersistence
真实 ModuleHost
真实 Kernel core
真实 Gateway
真实 Supervisor
fake Workflow / UserInteraction / ExecutorSet
```

**验收场景**

- 正常路径：
  - createRun → 授权 → Unit → 报告 → RunSummary → RunClosed/RunFinished；
  - 运行目录、审计、产物、报告与 RunSummary 保留。
- 外部行为：
  - 授权 YES / NO / 超时；
  - 预算不足、WRAP_UP、EXHAUSTED、final-call；
  - 技术重试、退避、旧 execution；
  - 取消、运行超时、STOP_UNCONFIRMED、迟到结果；
  - 重复 requestId、重复执行事实、迟到事实；
  - VIOLATION 与收敛升级；
  - 产物缺失/损坏、报告发布失败、RunSummary 失败；
  - 审计写入失败；
  - 模块启动失败、停止失败、Fabric 停止、`NOT_RUNNING`。
- 一致性：
  - `RunSummary.units` 不变量；
  - `model.requests` 含重试；
  - 两个终态事件内容一致且各唯一；
  - 结束事件是接收方最后一个事件；
  - 未知效果、预算、审计与终态一致。
- 边界：
  - 仓库与 `dataDir` 不互相包含；
  - 不产生未授权文件写入；
  - Kernel/Infra 产品路径无占位实现；
  - 外部模块仍是显式 `NOT_IMPLEMENTED`。

**退出条件**

- Kernel/Infra 自身验收通过；
- 外部模块与真实模型 E2E 明确列为外部阻塞；
- 不以 fake 通过宣称 M1 整机完成；
- 前五个 Stage 的跨基础设施预留全部关闭。

**完成记录（2026-10-22）**

- 新增 `apps/control-plane/src/bootstrap/stage6-acceptance.test.ts`，使用真实 Fabric、
  LocalArtifactStore、FilePersistence、ModuleHost、Kernel core、Gateway、Supervisor，
  外部模块使用 fake：
  - 正常路径：createRun → 授权 → 六类 Unit → AnalysisReport → RunSummary →
    RunClosed/RunFinished；校验 7 个产物、审计类型、报告与 RunSummary Schema、
    `units` 不变量与 `model.requests`。
  - 授权拒绝：`USER_DECLINED`，运行 FAILED。
  - 授权超时：真实 Kernel 授权计时器，按拒绝处理。
  - 取消：真实 Kernel 收敛为 CANCELLED。
  - 运行超时：真实 Kernel 以 RUN_TIMEOUT 收敛，Executor 忽略 abort 时仍完成有界收敛。
  - 违规：真实执行事实触发 VIOLATION，运行以安全原因停止。
- 预算、final-call、技术重试、旧 execution、重复/迟到结果、STOP_UNCONFIRMED 等
  组件级矩阵由 Stage1–4 的 Core/Execution/Monitor/Scheduler 测试覆盖；
  四类基础设施故障矩阵由 Stage5 的组件测试和组合根故障场景覆盖。
- 进程级退出码矩阵由 6.3 的真实子进程测试覆盖。
- 外部 Workflow、UserInteraction、ExecutorSet 与真实模型 E2E 仍为显式阻塞，
  未将 fake 通过记为整机验收。
- 验证：`pnpm run check` 通过（58 个测试文件、606 项测试）；
  `pnpm run test:coverage` 全仓语句 93.54%、分支 84.77%、函数 90.35%、行 95.25%；
  `pnpm run demo:fake` 退出码 0。

### 6.5 文档、README、工作文档与总报告

**目标**：让代码、规范、README、阶段报告与总实现报告一致。

**工作项**

- 更新 `README.md`：
  - Kernel 与 Infra 已实现；
  - Workflow、UserInteraction、ExecutorSet 仍是占位；
  - CLI 完整 Agent 循环仍受外部模块阻塞；
  - 不引用工作计划的 Stage 编号。
- 完成 `docs/M1KernelStage6.md` 的阶段六报告，包括：
  - 交付范围与代码结构；
  - 提交列表；
  - 6.1–6.6 实现与验证；
  - 验收矩阵、覆盖率与限制；
  - 工作收敛结论。
- 新增 `docs/M1KernelImplementationReport.md`：
  1. 背景、范围与交付结论；
  2. 阶段一至阶段六总览与提交索引；
  3. Kernel 六组件实现映射；
  4. Fabric、ModuleHost、Persistence、ArtifactStore 实现映射；
  5. 运行 actor、Outbox、定时器、Supervisor、Core 收敛与 panic 路径；
  6. 验收矩阵与质量门证据；
  7. 外部依赖与仍未完成项；
  8. 七个工作文档索引与归档说明；
  9. PR 范围、限制与后续工作。
- 更新七个工作文档头部：
  - 删除或改写“本文件不进入 `feature/M1/main`”；
  - 明确“随本分支进入 `feature/M1/main`，由项目主管人归档整理”；
  - 保留“不是规范，与 `docs/M1/` 冲突时以规范为准”。
- 更新 `M1-kernel-infra-plan.md` 第 10 节：
  - 不再要求导出分支去掉本文；
  - 改为正常导出全部工作文档和总报告；
  - 保留不得改写已合入历史的约束。
- 更新文档入口：
  - `README.md` 增加总实现报告入口；
  - 必要时在 `docs/README.md` 或 `docs/M1/README.md` 增加实现报告链接；
  - 确保工作文档与总报告之间的链接有效。
- 复核规范与代码一致：
  - `M1Interface` 的 `bootMs` 与代码一致；
  - `SystemFaultHandling` 的 panic/退出码与测试一致；
  - `ModuleHost`、`Fabric`、`Persistence`、`ArtifactStore` 与实现一致。

**退出条件**

- README 不再声称 Kernel 未实现；
- 七份工作文档与总报告存在且链接有效；
- 阶段六报告与计划状态一致；
- 规范、代码、测试、README 无已知矛盾；
- 外部阻塞清单完整。

**完成记录（2026-10-22）**

- `README.md` 已更新：
  - Kernel 与 Infrastructure 已实现；
  - Workflow、UserInteraction、ExecutorSet 仍为占位；
  - CLI 完整 Agent 循环仍受外部模块阻塞；
  - 增加总实现报告入口。
- 新增 [M1KernelImplementationReport](M1KernelImplementationReport.md)，记录阶段总览、
  组件与基础设施映射、运行 actor/Outbox/panic、验收矩阵、外部依赖、七个工作文档索引与 PR 范围。
- 七个工作文档头部已改为：
  - 不是规范；
  - 随本分支进入 `feature/M1/main`；
  - 由项目主管人后续归档整理。
- `M1-kernel-infra-plan.md` 第 10 节已改为正常导出全部工作文档与总报告，
  不再要求删除本文或工作文档。
- `docs/README.md` 已增加总实现报告入口。
- 规范复核：
  - `M1Interface` 的 `bootMs` 与实现一致；
  - `SystemFaultHandling` 的 panic/退出码与测试一致；
  - `ModuleHost`、`Fabric`、`Persistence`、`ArtifactStore` 与实现一致。
- 验证：Prettier 与 `git diff --check` 通过；代码质量门沿用 6.4 的 58 个测试文件、606 项测试结果。

### 6.6 Ubuntu 质量门、导出分支与 PR

**目标**：完成可复现验收并准备向 `feature/M1/main` 发起 PR。

**工作项**

- 在 Ubuntu 24.04 / WSL2 上执行：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm run test:coverage
pnpm run demo:fake
git diff --check
```

- 同步 `feature/M1/main`：
  - 使用 merge，不 rebase；
  - 在最新基础上重新运行质量门。
- 创建导出分支：
  - 从 `feature/M1/main` 最新提交开始；
  - 逐个重放本分支自上次导出以来的非合并提交；
  - 包含七个工作文档与总实现报告；
  - 包含必要的 `docs/M1/` 规范更新与 `README.md` 更新。
- 导出分支检查：
  - 所有文档链接有效；
  - 总报告正确索引 Stage1–6 与计划文档；
  - 工作文档头部不再声称“不进入主分支”；
  - 不包含密钥、生成物、无关格式化或未声明依赖。
- 在导出分支重新运行质量门。
- 发起 PR 到 `feature/M1/main`：
  - 目标不是 `main`；
  - 使用 merge commit；
  - 说明 Kernel/Infra 范围、验证证据、外部阻塞、风险与回滚；
  - 说明七个工作文档、总报告与项目主管人归档安排；
  - 不宣称 M1 整机完成。

**退出条件**

- 导出分支通过全部质量门；
- PR 可评审、可合并；
- PR 明确列出外部阻塞：
  - 真实 Workflow；
  - 真实 UserInteraction/CLI；
  - 真实 ExecutorSet；
  - 真实模型 E2E 与 F1–F5。

## 6. 依赖关系与关键路径

```text
6.1 启动总期限与组合前保护
    ↓
6.2 panic 五步与 StopReport
    ↓
6.3 进程入口、信号与退出码
    ↓
6.4 Kernel/Infra 验收矩阵
    ↓
6.5 文档、README、工作文档与总报告
    ↓
6.6 Ubuntu 质量门、导出分支与 PR
```

- 6.1 必须最先完成，后续启动、panic 与进程测试都依赖它。
- 6.2 与 6.3 可在 6.1 之后部分并行，但进程级退出测试依赖 6.2 的 panic 路径。
- 6.4 必须在 6.1–6.3 完成后执行。
- 6.5 可与 6.4 的证据整理并行。
- 6.6 必须最后执行。

## 7. Stage6 完成定义

Stage6 完成必须同时满足：

- `bootMs`、`startTimeoutMs`、`stopTimeoutMs` 都有界且验证通过；
- 进程保护在配置、Catalog、模块构造前生效；
- panic 五步、StopReport、重复 faultId、清理韧性通过；
- 真实子进程退出码矩阵通过；
- 真实 Kernel + 四类基础设施 + 组合根验收通过；
- Kernel/Infra 产品路径无占位实现；
- README、规范、阶段六报告与总报告一致；
- 七个工作文档与总报告均存在且链接有效；
- Ubuntu 上全部质量门通过；
- 可以向 `feature/M1/main` 发起 PR；
- 外部 Workflow、UserInteraction、ExecutorSet 与真实模型 E2E 仍明确标记为阻塞，
  不宣称 M1 整机完成。

## 8. PR 文档范围

进入 `feature/M1/main` 的文档共 8 份：

### 七个工作文档

1. `docs/M1-kernel-infra-plan.md`
2. `docs/M1KernelStage1.md`
3. `docs/M1KernelStage2.md`
4. `docs/M1KernelStage3.md`
5. `docs/M1KernelStage4.md`
6. `docs/M1KernelStage5.md`
7. `docs/M1KernelStage6.md`

### 总实现报告

8. `docs/M1KernelImplementationReport.md`

> 总报告不是规范；由项目主管人后续归档整理。

## 9. 边界与非目标

阶段六不包含：

- 真实 Workflow、UserInteraction、ExecutorSet；
- 真实模型 E2E、F1–F5 与 M1 整机验收；
- 多进程、跨进程 IPC、分片、生产级隔离；
- 数据库、NATS、DBOS、持久化 Outbox/Inbox、崩溃恢复；
- 新增公共 Schema 或修改 `contracts`；
- 修改其他团队负责的模块目录；
- 通过降低规范或伪造成功结论来“完成”验收。

## 10. 风险与关注点

| 风险 | 关注点 |
| --- | --- |
| `bootMs` 超时 | 迟到启动不得重新 READY，必须清理已取得资源 |
| 进程保护前移 | 组合前不能出现空 panic 入口或未处理拒绝 |
| panic 清理失败 | log、kill、模块 stop 失败都只能追加证据，不得阻断退出 |
| 进程级测试 | 不得在测试主进程触发 exit；使用独立子进程 |
| 真实产品入口 | 外部模块占位时不能伪造正常启动 |
| 文档归档 | 七份工作文档与总报告必须一致，链接有效 |
| 导出分支 | 不得改写已合入历史；使用 merge commit |

## 11. 进度记录

| 日期 | 内容 | 状态 |
| --- | --- | --- |
| 2026-10-22 | 完成 Stage6 规划：确定 6.1–6.6 子阶段、启动/panic/退出码/验收/文档/PR 任务，确认七个工作文档与总报告进入 `feature/M1/main` | 规划完成 |
| 2026-10-22 | 6.1 完成：`bootMs`、组合前进程保护、deferred fault reporter、`composeSystem` 构造失败清理与相关测试 | `pnpm run check`（56 个文件、582 项）；coverage 93.47%/84.47%/89.26%/95.18%；`demo:fake` 退出码 0 |
| 2026-10-22 | 6.2 完成：panic 五步韧性、日志/终止清理失败隔离、同步异常与 StopReport、同步命令抛错、supervisor stop 回退 | `pnpm run check`（56 个文件、586 项）；coverage 93.45%/84.56%/89.24%/95.15%；`demo:fake` 退出码 0 |
| 2026-10-22 | 6.3 完成：真实子进程退出码矩阵、进程保护韧性、CLI 64、配置失败 70、第一次/第二次 Ctrl+C | `pnpm run check`（57 个文件、600 项）；coverage 93.46%/84.62%/89.24%/95.15%；`demo:fake` 退出码 0 |
| 2026-10-22 | 6.4 完成：真实 Kernel/Infra 正常、授权拒绝/超时、取消、运行超时、违规验收；组件级矩阵与外部阻塞登记 | `pnpm run check`（58 个文件、606 项）；coverage 93.54%/84.77%/90.35%/95.25%；`demo:fake` 退出码 0 |
| 2026-10-22 | 6.5 完成：README、总实现报告、七个工作文档头部、计划第 10 节与文档入口同步 | Prettier 与 `git diff --check` 通过；代码质量门沿用 6.4（58 个文件、606 项） |
