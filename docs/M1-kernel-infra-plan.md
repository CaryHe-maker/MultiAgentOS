# M1 Kernel 与 Infrastructure 实现计划

## 1. 本文与本分支

- 本文是 `feature/M1/kernel-infrasturcture` 分支的工作文档：本分支的任务、进度与注意事项。它不是规范，
  规范在 `docs/M1/` 下，两者不一致时以规范为准并修正本文。
- **本分支的任务**：实现 Kernel（Gateway、Core、Scheduler、Execution、Supervisor、Monitor 与运行 actor）、
  四类基础设施（Fabric、ModuleHost、Persistence、ArtifactStore）与组合根（`apps/control-plane`），
  使真实 Kernel 能在整条链上运行。
- **负责人**：2026-10-14 起，本分支剩下的全部任务由 field 完成，包括基础设施与组合根中未完成的部分。
  此前的工作（P01–P05、错误与系统故障处理、C01–C08）由 Cary 完成。M1Plan 第 4 节的分工表没有随之修改，
  本分支的范围以本节为准。
- **决定权**：第 7 节中由 Cary 作出的决定继续有效，需要推翻时按第 3.2 节协调。只影响本分支目录的新决定由 field 作出；
  涉及共享接缝或其他分支的，在 GitHub Issue 中与 Cary 和 meti 协调。
- **工作方式**：每次开始先运行 `git status` 与 `git log --oneline -10`，与第 2.1 节核对，不一致时以仓库为准；
  只做当前阶段；完成后按第 9 节验证、按第 11 节记录。不自动 commit、push 或创建 PR，也不自动向其他人发消息，
  都等负责人明确要求。
- **本文不进入 `feature/M1/main`**。规范、源码注释、错误信息与测试都不得链接本文或使用本文的编号
  （P01–P11、C01–C08）；只有本文可以引用规范。下面的命令除本文外应当没有结果：

  ```bash
  git grep -nE "kernel-infra-plan|\bP(0[1-9]|1[01])a?\b|\bC0[1-8]\b" -- . ':!docs/M1-kernel-infra-plan.md' ':!pnpm-lock.yaml'
  ```

- 文件名是 PascalCase 命名惯例的例外；分支名中的拼写 `infrasturcture` 保持不变，不要改名。

## 2. 现状

### 2.1 基线

`f9e6dc1`：已同步 `feature/M1/main` 的 `b44380a`。WSL Ubuntu 24.04 上 `build`、`lint`、`format:check` 通过，
测试 36 个文件、296 项全部通过。

### 2.2 已完成

| 部分 | 状态 |
| --- | --- |
| Fabric：Schema 校验、身份、拷贝、Inbox（两通道、去重、失败观察者）、有序发送器、Gateway 畸形请求的结构化拒绝接缝 | 完成 |
| Persistence、ArtifactStore：路径与符号链接检查、写入排队与关闭排空、内容寻址与复验、命名空间限定的 Port | 完成 |
| ModuleHost：逐模块生命周期账本、启动失败回滚、启动中停止、停止期限、`afterStart` 钩子 | 完成 |
| Supervisor：清理 `tmp`、引导与逆序关闭、Fabric 就绪后注册处理器、子进程存活集合与 `killAll()` | 引导与关闭完成；`execute`、`cancelRun` 为 `NOT_IMPLEMENTED` |
| Gateway（`createGateway`）：调用方身份、Schema、准入投影 | 已实现，未与真实 Core 联调 |
| Monitor、Scheduler、`InProcessProviderCapacity` | 已实现并测试，未接入 Core |
| 组合根：配置加载与校验、`composeSystem`、系统控制（有界故障关闭、退出码 70）、最后防线（含第二次 Ctrl+C）、进程入口 `bin.ts` | 完成；配置关系校验待 P05a |
| Kernel 私有接口（`kernel/src/interfaces/`）、`KernelCoreModule.abortAllRuns`、`reportSystemFault` 的注入 | 接口已定；`createKernelCore` 为 `NOT_IMPLEMENTED` |

下列部件已实现并有单元测试，但还没有产品调用方。它们是为后续阶段预先写好的，**不是死代码，不要删除或另写一份**：

| 部件 | 位置 | 接入阶段 |
| --- | --- | --- |
| `AttemptIdentityRegistry`（C02） | `kernel/src/core/index.ts` | P06、P09 |
| `finalizeRunEvents`（C06） | `kernel/src/core/finalize-run.ts` | P10 |
| `Monitor.settle` 返回的 `SettlementResult`（C01） | `kernel/src/monitor/index.ts` | P09 |
| `InProcessProviderCapacity` | `kernel/src/scheduler/index.ts` | P06 |

## 3. 修改边界

### 3.1 本分支可以直接修改

`packages/modules/kernel/**`、`packages/infrastructure/**`、`apps/control-plane/**`、
`docs/M1/Kernel/**`、`docs/M1/Infrastructure/**`、`docs/M1/Module/Kernel.md`、本文。

### 3.2 共享接缝

`packages/libraries/contracts/**`、`packages/testing/**`、各模块的工厂签名与依赖清单（M1Interface 第 14 节）、
`docs/M1/M1Interface.md`、`docs/M1/Library/SharedContracts.md`、`docs/M1/M1Plan.md`、`docs/M1/SystemFaultHandling.md`、
根目录的构建与检查配置、`pnpm-lock.yaml`、`.github/workflows/`。

按 M1Plan 4.1 修改：单独提交，只含接缝本身及其规范、fake 与测试的同步修改，说明对其他分支的影响；
先合入 `feature/M1/main`，再由各分支同步。不得夹在功能提交里，不得只为本分支实现方便而改接口，
不得借修改 fake 重新定义被替代方的行为。

### 3.3 其他负责人的范围（只读）

| 范围 | 负责人 |
| --- | --- |
| `packages/modules/workflow/**`、`packages/modules/user-interaction/**`、`apps/cli/**`，Workflow 与 UserInteraction 的规范 | Cary |
| `packages/libraries/executor-set/**`、`packages/libraries/agent-tool-pool/**`（含定义、digest、封存数据）、Prompt 正文与模型可见的工具描述 | meti |

可以阅读、调用公开 Port、运行现有测试；不得以重构、格式化、依赖升级、测试修复或顺手修正为由改动。
确需改动时，先在 Issue 中说明文件与证据、能否在本分支内用 Adapter 或测试替身解决、最小修改建议及影响；
说明不等于授权，不依赖该变更的工作可以继续。

## 4. 规范与范围

阅读顺序：[M1Plan](M1/M1Plan.md)、[M1Interface](M1/M1Interface.md)、[Kernel 内部交互](M1/Kernel/Interaction.md)、
[Kernel（外部视角）](M1/Module/Kernel.md)、[错误与系统故障处理](M1/SystemFaultHandling.md)、
`docs/M1/Kernel/` 与 `docs/M1/Infrastructure/` 下各组件文档、[M1TechStack](M1/M1TechStack.md)、[Style](Style.md)。

- `contracts` 中的 Schema 是已实现协议的可执行事实源；M1Interface 1.4 列出 Schema 强制的全部约束。
- 会议记录与 Issue 中的历史提案不覆盖现行规范。规范之间冲突时记录证据并先协调，不自行选择有利于实现的一份。
- M1 是本地、单用户、单项目、单进程、单活动 Task 的只读仓库分析：一个进程一个运行，Unit 按 FIFO 串行执行，
  Executor 在进程内运行，只有 `rg` 是子进程；运行状态、Lease、账本、Outbox、Inbox 在内存中，磁盘只存运行记录、审计与产物。
  不实现崩溃续跑、暂停与恢复、并行 Agent、跨进程 IPC、分片或生产级隔离（M1Plan 第 3 节），不要提前实现。

## 5. 架构不变量

- UserInteraction 管输入和展示，Workflow 管业务推进与验收，Kernel 管受控执行。
- Gateway 只检查身份、契约和准入投影，不保存 Lease 或 token 账本。
- Lease 与用户授权记录只由 Core 持有；其他组件只拿到裁决和派生范围。
- Core、Execution、Monitor、Scheduler 各有私有状态，只经 `interfaces/` 中的接口交互；组件之间的导入由 lint 与架构测试禁止。
- Execution 只经 CoreSyscalls 申请资源和提交结果检查，不直连 Monitor 或 Scheduler。
- Monitor 只在被 Core 调用时运行；Scheduler 管 API 调用机会，不维护执行 FIFO。
- 运行 actor 不是第七个组件，只组织消息顺序与接线，不取得领域写入权。
- actor 不可重入，控制通道只在消息之间优先；定时器只入队，不直接改领域状态。
- 跨主体调用在处理函数中只登记，处理结束后由 actor 外的发送器按目标顺序发送。
- 内部 syscall 同步执行，不等待 I/O、不回调 Execution；收尾在处理末尾完成。
- `Supervisor.execute` 受理即返回，执行事实作为新消息进入 actor。
- 核对 runEpoch 与把结果放入 Outbox 必须在同一同步处理段完成。
- 对外事件只有 Core Outbox 一个出口；Execution 与 Executor 不直接推进 Workflow。
- 只有 Execution 写正式 Artifact，包括内建 report-publish 和 RunSummary。
- ArtifactRef 不是读取权限：Execution 先核对本运行归属，再交存储复验完整性。
- 运行状态只能 RUNNING → CONVERGING → CLOSED；结束事件是各接收方的最后一个事件。
- token 不足只拒绝新的消耗型预留，不停止运行；已发生的消耗照常结算，结果照常交付。
- 未知消耗不按零处理；MODEL 请求可能已发出时不做技术重试。
- 启动只清理 `dataDir/tmp`，保留 `runs`；仓库与 dataDir 的真实路径不得互相包含。
- 模型动作是提案；写文件、项目命令、项目测试等未支持能力不得产生副作用。

## 6. 剩余阶段

每个阶段附带确定性测试，退出条件成立并按第 9 节验证后才标记完成。按顺序进行；P07–P09 在 P06 的链路上逐段替换，
不另起并行实现。

| ID | 范围 | 退出条件 | 状态 |
| --- | --- | --- | --- |
| P05a | 启动期配置关系校验 | 不满足的配置使 `composeSystem` 以 `ConfigError` 失败、不启动任何模块；`tokenLimit = 1` 与缺少 API key 都被拒绝 | 未开始 |
| P06 | actor、Core 运行管理、Gateway 接线 | 真实 Core 与 Gateway 配合外围 fake，用内建 REPORT_PUBLISH 走通 createRun → RunStart → submitUnit → UnitReport → closeRun → RunClosed/RunFinished → shutdown；actor 无等待环；处理函数抛错按 L1 收敛 | 未开始 |
| P07 | Core 定义核验与授权 | 无权限不派发，同范围只问一次，拒绝被记住 | 未开始 |
| P08 | Supervisor 执行 | 受理、`notBefore`、deadline、取消、宽限期与唯一终态正确；Executor 抛错转为事实而非系统故障 | 未开始 |
| P09 | Execution 与 Core 结果路径 | Attempt 与 FIFO、引用解析、产物、技术重试、预留与结果检查；内建报告发布与五类 Executor 路径通过，无资源泄漏 | 未开始 |
| P10 | Core 完整收敛与关闭 | 每个运行的结束事件唯一，未知效果明确，设施关闭顺序正确；用真实 Core 重做 SystemFaultHandling 第 8 节的故障注入 | 未开始 |
| P11 | 组合与 Ubuntu 验收 | 真实 Kernel 配合外围 fake 通过质量门与故障集成；再按其他分支的交付接入真实系统 | 未开始 |

各阶段要点：

- **P05a**（P06 的前置）：放在组合根，加载 Catalog 之后、调用产品工厂之前；不放进 Kernel 工厂（`KernelCoreDeps` 不含
  `entryAgentRef`）。用 `pinAgent` 从入口 Agent 沿 `handoffTargetRef` 遍历可达 Agent（维护 visited），核对目标 digest、provider、
  模型限制、普通与 final 的工具 Schema、不可裁剪输入的上界；核对 `tokenLimit`、`finalReserve`、`wrapUpMargin`、模型输入输出
  限制与各预算的关系（Monitor 第 4 节）；检查这些 provider 的 API key 存在（#26）。使用 contracts 的 `estimateItemTokens`、
  `estimatePackTokens` 与 `registry.jsonSchemaOf`；只读取 Prompt 与 `modelDescription`。排除规则的写法已由 Schema 校验，不必另做。
  顺带修正 `apps/control-plane/src/config/system-config.ts` 中 “The checks that need the catalog ... belong to the Kernel.” 这句注释。
- **P06**：两通道 actor，不做 Inbox 去重；请求按规范 JSON 的 SHA-256 幂等，`createRun` 的幂等摘要不含 Gateway 每次转发时
  生成的 `workflowRunId`。处理与 `settleConvergence` 完成后才把待发送项交给 `OrderedSender`（`enqueue` 会立即发送）。
  Kernel 核心边界直接核验 `envelope.producer`，不只相信 `GatewayForward.caller`；`RunRegistry.handleForward` 接收不可变的
  `BoundaryContext`，运行上下文在创建时固定（C03）。按 SystemFaultHandling 2.2 设置 actor 的捕获边界，实现产品的
  `abortAllRuns`。把同一个 `InProcessProviderCapacity` 注入各运行的 Scheduler。最小尝试路径也必须经过 `registerAttempt`
  与 `submitResultCheck`。从 P06 起就测试取消与运行状态边界，不留到 P10。
- **P07**：Lease = Agent 定义的能力 ∩ 用户授权 ∩ 系统策略（Core 第 4 节）。排除规则使用 contracts 的
  `DEFAULT_REPOSITORY_EXCLUSIONS`，展示给用户与写入 Lease 的是默认列表加 `KernelConfig.repositoryExclusions`（M1Interface 3.5，#24）。
- **P08**：Executor 在宽限期内返回的执行一律报 `TERMINATED`，沿用其 `requestState`（Supervisor 第 4 节，#26）；
  MODEL 缺少 `requestState` 时取 `UNKNOWN`，非 MODEL 丢弃 `usage` 与 `requestState`。处理器抛错只用于契约缺陷
  （producer 不符、未就绪），执行层面的拒绝一律走 ExecutionFact。
- **P09**：Core 处理 `SettlementResult` 中的异常并写审计（C01）。先登记尝试，再申请预留或提交结果检查；先登记执行实例，
  再登记 `Supervisor.execute` 的待发送项（C02）。在 Monitor 拒绝、重试与正常结果时都核对调用机会已归还；
  `STOP_UNCONFIRMED` 的机会留到收敛末尾释放。
- **P10**：RunSummary 写入失败时用 `finalizeRunEvents` 仍投递两个终结事件并关闭（C06）；收敛过程抛错升级为
  `reportSystemFault`；增加审计类型 `SYSTEM_FAULT_ABORT`。全部运行 CLOSED 后排空各目标发送器；Supervisor 的 shutdown
  受理后再异步停止模块，避免 Fabric 请求的响应与销毁 Fabric 互相等待。
- **P11**：完整产品 E2E 与 F1–F5 依赖其他分支，不因外围 fake 通过而标记 M1 完成。

## 7. 已定的设计决定

全部由 Cary 决定（2026-10-10 至 10-13），规范已同步，不要另行设计。

| ID | 决定 | 已实现 | 剩余 |
| --- | --- | --- | --- |
| C01 | 结算异常（超估算、重复结算冲突）以 `SettlementResult` 返回给 Core 审计，不用 throw | Monitor | Core 消费（P09） |
| C02 | Execution → Core 同步登记：先登记尝试，再申请资源或提交结果；派发前登记执行实例；旧实例不得覆盖新实例结果 | 接口、`AttemptIdentityRegistry` | Core、Execution 接入（P06、P09） |
| C03 | `RunRegistry.handleForward` 接收不可变 `BoundaryContext`；不改公共 Schema | 接口 | 产品 RunRegistry（P06） |
| C04 | Fabric 启动后经 `afterStart` 注册 Supervisor 处理器；钩子失败回滚 | 完成 | — |
| C05 | `requestId` 合法的畸形 syscall 由 Gateway 结构化拒绝；缺失或非法 `requestId` 是传输契约错误 | Fabric、Gateway | 与产品链联调（P06） |
| C06 | RunSummary 写入失败时，终结事件带 `finalizationError`，不伪造引用，保留原结束原因 | contracts、`finalizeRunEvents` | Core 接入（P10） |
| C07 | 错误分级 L0–L3、角色权限、`abortAllRuns`、故障结束原因复用 `FAILED(KERNEL_INTERNAL)`（SystemFaultHandling） | 组合根、ModuleHost、Supervisor 引导、接口 | Core 的捕获边界与升级（P06、P10）；每个执行实例的捕获边界（P08） |
| C08 | `SystemFault` 类型在 contracts；Workflow 与 UserInteraction 注入 `reportSystemFault` | 接口与注入 | 两个模块一侧由 Cary 完成 |

## 8. 注意事项

1. **fake 不是验收。** fake 纵向链通过不代表真实 Kernel 的权限、额度、取消与业务验收通过；不要把 `fake-kernel` 搬成产品实现。
2. **UnitReport 可能先于 SyscallAck 到达**，实现与集成测试都不得假设相反的顺序。
3. **发送失败不一定是契约缺陷。** Fabric 停止后发送得到 `NOT_RUNNING`；故障关闭期间由此产生的 `KERNEL_FAULT` 多半发生在运行
   已 CONVERGING 或 CLOSED 时，按规范只写审计，但审计条目应区分这两种原因。
4. **SupervisorPort 没有结构化拒绝的返回形态**，处理器只能抛错，调用方按发送失败处理。
5. **进程内 Executor 不响应中止信号时无法强制终止**，必须如实报告 `STOP_UNCONFIRMED`，不得伪造已停止。
6. **存储的竞态边界**：路径与符号链接检查只覆盖静态重定向，不承诺抵御同机恶意进程的并发改写。
7. **待决定**：`packages/infrastructure/persistence` 导出的 `clearTemporaryFiles` 没有产品调用方（Supervisor 因依赖边界自己清理
   `tmp`），建议删除以免两处实现分叉。
8. **排除规则的旧副本**：`executor-set` 中的 `DEFAULT_EXCLUSIONS` 由 meti 删除并改用 contracts（#28），本分支不要改它，也不要再用它。

## 9. 环境与验证

- 验收平台是 Ubuntu LTS（Windows 上用 WSL2）；Node 24.19.0、pnpm 11.25.0；需要安装 ripgrep。CI（`ubuntu-24.04`，已装 ripgrep）
  对每次推送运行质量门。
- 提交前：`pnpm install --frozen-lockfile`、`pnpm run build`、`pnpm run check`、`git diff --check`。
- 原生 Windows 上 `agent-tool-pool` 的符号链接测试因 `EPERM` 失败，与本分支无关，不要为此修改该包。
- 存储路径、权限、rename、符号链接、`rg` 子进程、Ctrl+C 必须在 Linux 上验证；普通测试不得依赖真实模型或网络。
- 验证记录写明命令、环境、结果与限制；没有测试证据不标记完成。只改文档时只做格式与差异检查。
- 不记录密钥、完整 Prompt、源码正文或未经脱敏的模型输出。

## 10. 提交、同步与合入

- 按阶段或逻辑变更提交，每个提交可构建、可测试；Conventional Commits，说明用中文，不使用本文的编号。
- 只从 `feature/M1/main` 同步，用 merge，不 rebase；不直接合并其他工作分支。本分支已被合入过 `feature/M1/main`，不得改写历史。
  每次同步后在 Ubuntu 上运行完整质量门。
- 向 `feature/M1/main` 合入时使用不含本文的导出分支：
  1. 确认本分支已同步 `feature/M1/main` 的最新提交；
  2. 在 `feature/M1/main` 的最新提交之上，逐个重放本分支自上次导出以来的非合并提交，每个提交去掉本文，
     提交说明中提到本文或其编号的行一并去掉；
  3. 推送导出分支，提 PR，使用 merge commit 合并；
  4. 合并后本分支同步一次 `feature/M1/main`（其余文件两边相同，会干净合并），删除导出分支。

  2026-10-13 的首次合入（PR 23）就是这样做的。

## 11. 进度记录

| 日期 | 内容 | 验证 |
| --- | --- | --- |
| 2026-10-10 | P01 接缝核对；C01–C06 决定与接口落地；P02 Fabric | Windows：30 个文件、237 项 |
| 2026-10-11 | P03 存储、P04 Supervisor 引导、P05 Monitor 与 Scheduler；CLI 启动前校验；C07 错误与系统故障处理 | WSL：35 个文件、282 项 |
| 2026-10-13 | C08；fake Kernel 的全部结束方式；进程入口与第二次 Ctrl+C；M1Plan 4.1；首次经导出分支合入（PR 23） | WSL：35 个文件、288 项 |
| 2026-10-14 | 同步 `feature/M1/main`（#27：排除规则移入 contracts、CI 安装 ripgrep）；本分支交由 field | WSL：36 个文件、296 项 |
