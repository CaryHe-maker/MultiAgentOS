# M1 Kernel 与 Infrastructure 实现计划

## 1. 本文与本分支

**修订状态：2026-10-17 完成六阶段覆盖核对；2026-10-18 按 SystemFaultHandling 逐项补齐异常、panic 与退出验收落点；2026-10-19 同步阶段一、阶段二验收结果与阶段三规划。**
本计划作为剩余开发执行基线；阶段一、阶段二已完成验收，阶段三规划中，阶段四至六未开始，后续由负责人指定阶段推进。
本次完成阶段二实现记录压缩、阶段三规划与文档状态同步，不启动阶段三实现；旧 P06–P11 安排由第 6 节替代，历史记录与已定设计决定保留。

- 本文是 `feature/M1/kernel-infrasturcture` 分支的工作文档：本分支的任务、进度与注意事项。它不是规范，
  规范在 `docs/M1/` 下，两者不一致时以规范为准并修正本文。
- **本分支的任务**：实现 Kernel（Gateway、Core、Scheduler、Execution、Supervisor、Monitor 与运行 actor）、
  四类基础设施（Fabric、ModuleHost、Persistence、ArtifactStore）与组合根（`apps/control-plane`），
  使真实 Kernel 能在整条链上运行。
- **负责人**：2026-10-14 起，本分支剩下的全部任务由 field 完成，包括基础设施与组合根中未完成的部分。
  此前的工作（P01–P05、错误与系统故障处理、C01–C08）由 Cary 完成。M1Plan 第 4 节的分工表没有随之修改，
  本分支的范围以本节为准。
- **决定权**：第 7 节保留已有决定及负责人明确批准的替代项；两类异常与 panic 以 2026-10-17 修订为准。只影响本分支目录的新决定由 field 作出；
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

## 2. 现状（代码基线 2026-10-19，文档核对 2026-10-19）

### 2.1 基线

阶段二（2.1–2.6）已完成并验收，报告见 [M1KernelStage2](M1KernelStage2.md)。2.1–2.3 已提交于
`51fec05`；2.4–2.6 与本轮文档收尾随当前提交进入工作分支。
阶段二报告记录：48 个测试文件、485 项测试通过，全仓语句覆盖率 92.45%，`pnpm run demo:fake`
退出码 0，`git diff --check` 通过。该证据使用 fake Supervisor、fake Catalog 与 ArtifactStorePort
测试替身，不包含真实 Supervisor、真实模型调用或基础设施故障矩阵。

此前阶段一记录：`1fec492`（1.1–1.6）已完成并验收，包含提交 `9f7c9f2`（1.1–1.3）与
`1fec492`（1.4–1.6 及阶段报告）。P05a 的启动配置校验继续有效。本次状态同步不将历史测试
记为重新执行。

### 2.2 实现状态

下表的“已实现”指已有局部代码与测试，不代表真实 Kernel 主链已经联调或验收。

| 部分 | 状态 |
| --- | --- |
| Core：运行管理、九种外部 syscall、AgentRun、授权与 Lease、CoreSyscalls、预留与结算、结果检查、收敛、异常语义、审计 | 阶段一已实现并验收；阶段二纵向集成验证通过 |
| Fabric：Schema 校验、身份、拷贝、Inbox（两通道、去重、失败观察者）、有序发送器、Gateway 畸形请求的结构化拒绝接缝 | 已实现，真实主链联调待阶段五 |
| Persistence、ArtifactStore：路径与符号链接检查、写入排队与关闭排空、内容寻址与复验、命名空间限定的 Port | 已实现，真实主链联调待阶段五 |
| ModuleHost：逐模块生命周期账本、启动失败回滚、启动中停止、停止期限、`afterStart` 钩子 | 已实现，真实主链联调待阶段五 |
| Execution：UnitAttempt、FIFO、执行事实处理、产物与内建 `report-publish` | 阶段二已完成（2.1–2.6）；真实 Supervisor 与 run actor 接线待阶段三、四 |
| Supervisor：清理 `tmp`、引导与逆序关闭、Fabric 就绪后注册处理器、子进程存活集合与 `killAll()` | 引导与关闭完成；`execute`、`cancelRun` 为 `NOT_IMPLEMENTED`，待阶段三 |
| Gateway（`createGateway`）：调用方身份、Schema、准入投影 | 阶段一完成身份、准入与拒绝日志修正；与真实 Core 的产品链联调待阶段四 |
| Monitor、Scheduler、`InProcessProviderCapacity` | 阶段二已接入 Core/Execution 并通过真实组件集成测试；故障验证待阶段五 |
| run actor、双通道 Inbox、OrderedSender、真实 Outbox | 空导出占位，待阶段四 |
| 组合根：配置加载与校验、`composeSystem`、系统控制（有界故障关闭、退出码 70）、最后防线（含第二次 Ctrl+C）、进程入口 `bin.ts` | 启动配置校验与控制基础已实现；真实 Kernel 启动待阶段六 |
| Kernel 私有接口（`kernel/src/interfaces/`）、`KernelCoreModule.abortAllRuns`、`reportSystemFault` 的注入 | 接口已定；Core 与 Execution 已实现；`createKernelCore` 仍为 `NOT_IMPLEMENTED`，装配待阶段四 |

Core 阶段一已实现；Execution 阶段二已完成；run actor 仍为空导出占位。
下列部件已有单元测试，阶段二后的接入状态如下；不能将局部测试通过视为完整组件实现：

| 部件 | 位置 | 接入阶段 |
| --- | --- | --- |
| `AttemptIdentityRegistry`（C02） | `kernel/src/core/index.ts` | 阶段一接入 Core；阶段二集成验证通过；阶段四 actor 联调 |
| `finalizeRunEvents`（C06） | `kernel/src/core/finalize-run.ts` | 阶段一接入 Core；阶段四联调 |
| `Monitor.settle` 返回的 `SettlementResult`（C01） | `kernel/src/monitor/index.ts` | 阶段一消费异常并审计；阶段二真实结算集成通过 |
| `InProcessProviderCapacity` | `kernel/src/scheduler/index.ts` | 阶段二集成通过；阶段四继续联调 |

### 2.3 已发现偏差与接入风险

| 单元 | 当前判断 | 处理阶段 |
| --- | --- | --- |
| Gateway | 已关闭（阶段一）：普通拒绝路径的结构化日志已补齐 | 一 |
| Core 身份核验 | 已关闭（阶段一）：结算资格与交付资格分离，旧 epoch 事实仍结算 | 一、四 |
| Inbox / actor | 接入风险：request 异常不能仅靠 onError 捕获 | 四 |
| OrderedSender / actor | 接入风险：enqueue 即发送，须在状态处理完成后提交 | 四 |
| Fabric 注释 | 已确认：发送失败不一律是契约缺陷，停止时可能为 NOT_RUNNING | 五 |
| Persistence / Supervisor | 已确认：tmp 清理重复，clearTemporaryFiles 的产品调用说明过时 | 五 |
| Scheduler、Monitor | 阶段二已通过正常路径集成；真实故障与收尾联调待阶段五 | 二、五 |
| ModuleHost、ArtifactStore | 真实主链接入与故障验证未完成 | 五 |

### 2.4 已完成的启动配置校验

**P05a 已完成（历史记录）：** 放在组合根，加载 Catalog 之后、调用产品工厂之前；不放进 Kernel 工厂（`KernelCoreDeps` 不含
  `entryAgentRef`）。用 `pinAgent` 从入口 Agent 沿 `handoffTargetRef` 遍历可达 Agent（维护 visited），核对目标 digest、provider、
  模型限制、普通与 final 的工具 Schema、不可裁剪输入的上界；核对 `tokenLimit`、`finalReserve`、`wrapUpMargin`、模型输入输出
  限制与各预算的关系（Monitor 第 4 节）；检查这些 provider 的 API key 存在（#26）。使用 contracts 的 `estimateItemTokens`、
  `estimatePackTokens` 与 `registry.jsonSchemaOf`；只读取 Prompt 与 `modelDescription`。排除规则的写法已由 Schema 校验，不必另做。
  已同步修正 `apps/control-plane/src/config/system-config.ts` 中 “The checks that need the catalog ... belong to the Kernel.” 这句注释。
  2026-10-16 已完成规则核对和实现接线（P05a 内部阶段一、二）；经负责人确认，Monitor 第 4 节改用
  JSON 转义后的固定输入上界，补充 final-call 模型窗口校验，普通/收尾输入默认预算改为 80000/64000。
  P05a 内部阶段三已新增 59 项规则与边界测试，并给本分支的 fake 测试及 demo 提供离线假凭据；control-plane 的 7 个测试文件、96 项测试全部通过。
  P05a 内部阶段四已完成：全仓 38 个测试文件、355 项测试通过，格式、lint、类型检查与 build 通过；fake demo 正常完成授权与运行关闭，退出码 0。
  同步修正 Monitor 测试中依赖旧默认预算的固定预留量，改为从当前预算推导普通调用可用额度。验收不包含真实模型调用或真实 Core 执行。

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

## 6. 剩余开发阶段（执行基线）

本节按负责人指定的六阶段顺序重新组织，替代原 P06–P11 的执行安排；旧编号仅用于历史记录。
本轮规划修订已闭合；本节不是新增规范，也不表示已授权连续执行全部阶段。
每次只执行负责人明确指定的阶段；阶段内兼顾实现偏差修正、未完成职责和验证。

### 6.1 阶段边界与预留规则

- 第一至第三阶段完成各组件职责，通过既有接口和测试替身验证跨组件行为；不能把核心业务逻辑本身留空。
- 第四阶段完成 Kernel 内部接线与联调，关闭前三阶段的全部 Kernel 内部预留。
- 第五阶段完成四类真实基础设施的实现核对、缺口修复与联调；第四阶段可以使用现有基础设施，
  但不因此宣称基础设施故障场景已经验收。
- 第六阶段完成真实启动入口与 Kernel 验收；全系统验收受其他分支交付约束，单独记录。
- 每项预留必须记录：接口与责任方、输入输出、错误语义、临时测试替身、最终接入阶段、验收用例和状态。
  测试替身只能用于验证，不得装进产品入口冒充实现。
- 现有实现的“未发现明确偏差”不是全面正确性结论；联调发现的偏差归属到负责阶段并补充验证。
- 每阶段按第 9 节验证并记录证据，退出条件满足后才标记完成。阶段完成不自动触发提交或下一阶段。

| 阶段 | 主要范围 | 退出条件 | 状态 |
| --- | --- | --- | --- |
| 一 | Core 控制逻辑，Gateway 偏差修正 | Core 职责内无占位业务分支；通过替身验证 syscall、授权、结果检查、收尾和异常处理 | 已完成（2026-10-19） |
| 二 | Execution、Scheduler，Monitor 接入 | 测试驱动下完成排队、许可、预留、执行结果处理与结算，覆盖重试和收尾 | 已完成（2026-10-19） |
| 三 | Supervisor 执行控制 | execute、cancel 和执行事实完整；正常、抛错、超时、取消、未确认停止及迟到结果可验证 | 未开始 |
| 四 | Run actor、Kernel 工厂与内部联调 | 真实 Kernel 内部闭环；前三阶段内部预留全部关闭，产品路径无占位实现 | 未开始 |
| 五 | ModuleHost、Fabric、Persistence、ArtifactStore | 真实基础设施正常与故障联调通过，跨基础设施预留关闭 | 未开始 |
| 六 | 组合根、真实启动与验收 | 启动可用，Kernel 验收可复现，未完成的外部依赖明确记录 | 未开始 |

### 6.2 阶段一：完善 Core

**状态：已完成（2026-10-19）。** 实现内容、验证证据、边界与遗留见
[M1KernelStage1](M1KernelStage1.md)；本阶段不包含真实 Execution、Supervisor、run actor 或 `createKernelCore`。

**实现工作**

- RunRegistry、创建校验、仓库 realpath 与 dataDir 边界、固定 BoundaryContext、单进程单 run、
  状态转换及关闭记录保留。核心边界直接核验 envelope.producer，不只相信 GatewayForward.caller。
- 实现九个外部 syscall 的 Core 语义：Workflow 的 registerAgentRun、submitUnit、endAgentRun、closeRun，
  UI 的 createRun、answerAuthorization、cancelRun、readArtifact、shutdown。
- 请求按规范 JSON 的 SHA-256 幂等；createRun 的摘要排除 Gateway 每次生成的 workflowRunId。
  覆盖相同 requestId 的参数冲突、收尾期间请求及关闭后的允许行为。
- AgentRun 注册、定义与 digest 核验、配置固定、单活跃约束、结束和关闭检查。
- 授权、待授权队列、回答、超时、取消和 Lease 生命周期。Lease 为 Agent 能力、用户授权、系统策略的交集；
  展示与派生范围使用 contracts 默认排除列表加 KernelConfig.repositoryExclusions。
- 实现内部 CoreSyscalls：登记尝试与 execution、资源许可、预算协调、重试授权、结果检查。
  先登记尝试再申请资源或检查结果，派发前先登记 execution。
- 结果身份核验、费用结算、资源释放、违规处理、交付资格与 Outbox 待发送项生成。
- 完整收尾状态机：停止新工作、取消在途工作、等待截止、未确认停止、最终结算、摘要与终态事件。
  实现正常 shutdown 与 abortAllRuns 的控制语义，明确二者的设施关闭边界。
- 生成审计事实与统计，消费 SettlementResult 异常；纳入 SYSTEM_FAULT_ABORT 与收尾失败升级。
  RunSummary 发布失败时接入 finalizeRunEvents，保留结束原因、未知效果与 finalizationError。

**偏差修正**

- 区分旧 epoch 结果的结算资格与交付资格，不能直接用当前 epoch 不匹配丢弃所有在途事实。
- 将 AttemptIdentityRegistry、finalizeRunEvents 纳入完整流程；允许按规范修正辅助实现，不重复造轮子。
- 补齐 Gateway 身份不符、未知 run、准入拒绝等路径的结构化日志，并核对投影与重放行为。

**预留与验证**

Execution 的执行管理、产物和摘要能力留接口，阶段二实现；Supervisor 执行取消留至阶段三；
actor 调度、定时消息和发送提交留至阶段四；真实存储故障联调留至阶段五。
通过替身验证控制规则，异步触发方式可以预留，触发后的业务处理不得留空。
从本阶段即覆盖取消、重复请求、状态边界和收尾，不拖到最终验收。

### 6.3 阶段二：完善 Execution 与 Scheduler

**状态：已完成（2026-10-19）。** 实现内容、验证证据、边界与遗留见
[M1KernelStage2](M1KernelStage2.md)；本阶段不包含真实 Supervisor、run actor 或 `createKernelCore`。
以下保留阶段二的实现要求与偏差记录，作为已完成阶段的依据。

**实现工作**

- UnitAttempt 创建与幂等、唯一 FIFO、完整状态转换、execution 历史、重试计数与未知副作用。
- 构造 ORIENT、SEARCH、FILE_READ、CONTEXT_ASSEMBLE、MODEL 请求，传递固定 scope、限制、
  deadline 与 notBefore；正确解析规范允许位置的 ArtifactRef。
- 模型上下文构造、历史正文读取、固定输入与工具 Schema；区分普通调用和 final-call。
  完成运行期估算、模型窗口检查和向 Core 申请预算，与已完成的启动期检查一致。
- REPORT_PUBLISH 的规范化 JSON、大小限制、写入与登记；Artifact 所有权与多生产者登记、
  读取检查、RunSummary 发布。
- 按规范识别可重试失败，经 Core 授权后创建新 execution 并退避；MODEL 可能已发送时禁止技术重试。
- 中止排队工作、合成 STOP_UNCONFIRMED、收集未知副作用；收尾期间不重试、不发布新执行输出。
- Scheduler 使用同一进程级 InProcessProviderCapacity；接通申请、预算预留失败回滚、释放与最终清理。
- Monitor 接入真实请求状态的结算与最终结算，由 Core 消费异常并审计；取消不能直接当作零费用。

**偏差修正**

核对容量实例共享、拒绝与重试路径的令牌归还、STOP_UNCONFIRMED 保留到收尾末尾、
旧 execution 不覆盖新结果，以及启动预算校验与运行期上下文构造的一致性。
模型 FINISH/HANDOFF 的业务解释属于 Workflow，不能在 Execution 中代办。

**预留与验证**

Supervisor 反馈暂用替身，阶段三接入；FIFO 唤醒、定时消息和实际发送由阶段四接入。
存储通过现有 Port 调用，真实故障矩阵留至阶段五。
退出时 Core、Execution、Scheduler、Monitor 可在测试驱动下完成请求从排队到结果结算，
覆盖普通与收尾模型请求、产物、重试、拒绝和取消边界。

### 6.4 阶段三：完善 Supervisor

**状态：规划中（2026-10-19）。** 子阶段、工程决定、测试与验收计划见
[M1KernelStage3](M1KernelStage3.md)；本轮只完成规划，不标记阶段三完成。

| 子阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| 3.1 | 执行表、execute 受理、notBefore、Executor 查找、最小环境、正常终态与抛错规范化 | 正常结果产生唯一合法 ExecutionFact |
| 3.2 | deadline、cancelRun、cancelEpoch、启动前取消、宽限期、STOP_UNCONFIRMED、迟到结果 | 中断矩阵完整，每个 execution 唯一终态 |
| 3.3 | stop/panic 清理、定时器清理、事实投递失败处理、health 诊断 | 停止有界、幂等、无未处理拒绝 |
| 3.4 | 真实 Fabric 路由、correlation、producer/not-ready、端到端集成 | Supervisor 经真实 Fabric 完成执行闭环 |
| 3.5 | 质量门、覆盖率、Stage3 报告、计划状态同步 | 验收证据完整，无共享接缝变更 |

**已确认的工程决定**

- 事实投递在 Supervisor 内部用现有 Fabric 构造，不修改 `SupervisorDeps`；事实沿用 execute 的 `correlationId`。
- Executor 抛错统一为 `FAILED(INTERNAL, retryable = false)`；MODEL `requestState = UNKNOWN`。
- 启动前取消为 `TERMINATED(EXECUTION_CANCELLED)`，无 `startedAt`，MODEL `requestState = NOT_SENT`。
- deadline 与 cancel 先触发者决定原因，后续不改变终态、不重置宽限期。
- 宽限期内返回 `VIOLATION` 时上报 `VIOLATION`；其他结果上报 `TERMINATED`。
- MODEL 的 `TERMINATED`/`FAILED` 保留 Executor 提供的 `usage`；其他结果按 ExecutionFact 约束归一化。
- `stop()` 先中止、清定时器，事实投递尽力而为，不阻塞关闭。
- 执行环境最小权限：MODEL 仅 credentials，REPOSITORY_SEARCH 仅 subprocess。
- 测试使用 fake timers、注入 `now` 与受控 Executor，不新增定时器依赖。

**实现工作**

- 清除 execute、cancel 的占位实现，建立 execution 表、Executor 查找与最小执行环境。
- 实现 notBefore、deadline、取消宽限期、cancelEpoch、startedAt 和 requestState 跟踪。
- execute 受理即返回，执行结果作为独立事实发送；每个 execution 只产生一个有效终结事实，
  丢弃重复或迟到结果。
- Executor 抛错转为规范化失败事实；执行层面的拒绝通过 ExecutionFact 表达，
  处理器抛错用于 producer 不符、未就绪等契约缺陷。
- 宽限期内返回按规范报告 TERMINATED 并沿用 requestState；若返回 VIOLATION 则上报 VIOLATION。
  MODEL 缺失时按 UNKNOWN，非 MODEL 丢弃 usage 与 requestState。无法确认停止时如实报告 STOP_UNCONFIRMED。
- 按 executionKind 最小权限注入模型凭据与受限 subprocess 能力，完成执行期间停止、清理和事实投递。

**偏差修正与预留**

将生命周期成功与执行成功分开验证，不假设进程内 Executor 必然响应中止。
向 run actor 的最终接线留阶段四；真实 ModuleHost、Fabric 停止故障联调留阶段五。
Executor 本身属于其他分支，通过公开契约接入，缺失能力登记为外部依赖。

**退出验证**

使用可控 Executor 覆盖正常、抛错、超时、取消、忽略取消、重复取消和迟到结果，
并与前两阶段组件验证执行链。保留既有子进程与生命周期测试。

### 6.5 阶段四：完善 Run actor 并联调 M1 Kernel

**实现工作**

- 双通道 Inbox、消息间控制优先级、串行且不可重入的 dispatch；不以 Inbox 去重替代 syscall 幂等。
- 每次处理后执行 settleConvergence；定时器只入队，不直接更改组件状态。
- 管理待发送项，处理与收尾推进完成后才交给各目标 OrderedSender。
- 接线 Core、Execution、Scheduler、Monitor、Gateway 和 Supervisor 事实通道，
  保持各组件私有状态与同步内部 syscall 边界。
- 实现消息级捕获和非停机异常收敛；收尾自身失败升级 reportSystemFault，避免故障消息无限循环。
- 实现 createKernelCore、生命周期、健康状态、abortAllRuns，以及关闭时 actor 与发送器的排空。
- 全部运行 CLOSED 且目标发送器排空后再推进设施关闭；Supervisor shutdown 受理后异步停止，
  避免响应与销毁 Fabric 相互等待。

**偏差修正**

Inbox.request 异常需显式捕获，不能仅依赖 onError；OrderedSender.enqueue 会立即发送，
不能在状态处理结束前调用；不能在 actor 内形成等待跨主体响应的环。
验证 epoch 检查与交付登记的原子性、旧结果结算、重复事实和终态事件顺序。

**退出验证**

关闭前三阶段所有 Kernel 内部预留。真实内部组件完成创建、授权、执行、结果交付、
重试、取消、收尾与关闭；产品路径无占位实现。
本阶段建立内部闭环，基础设施实现缺口与系统性故障联调仍由阶段五完成。

### 6.6 阶段五：完善并联调四类基础设施

| 单元 | 实现核对与偏差修正 | 真实联调 |
| --- | --- | --- |
| ModuleHost | 启动回滚、停止顺序、期限、并发停止、生命周期账本 | Kernel 启停、启动中止、停止失败后继续清理 |
| Fabric | 契约校验、消息顺序、异常传播、注销与停止；修正“发送失败均为契约缺陷”的说明 | syscall、事实、状态投影、Outbox、关闭排空与 NOT_RUNNING 分类 |
| Persistence | 写入排队、追加、命名空间、停止排空；统一 tmp 清理职责，处理重复 clearTemporaryFiles 与过时注释 | 真实审计与运行记录、写入失败、并发追加和关闭 |
| ArtifactStore | 发布、读取、完整性、路径与停止行为 | 上下文、报告、摘要、所有权配合、缺失与损坏及发布失败 |

检查仓库与系统数据目录边界；验证设施错误进入正确的运行级或系统级处理路径。
关闭前序跨基础设施预留。保留已实现能力，仅补规范要求，不扩展数据库、恢复机制或 IPC。
退出时正常和故障联调均有证据；未完成的外部模块依赖单独列出。

### 6.7 阶段六：Kernel 启动与验收

- 完成真实组合根装配，核对依赖实例、容量共享、凭据与配置注入；复核 P05a 在工厂执行前拒绝错误配置。
- 验证真实入口启动、ready、正常关闭、启动失败回滚、系统故障退出与最后防线。
- 验收授权允许/拒绝/超时，正常报告与关闭后读取，重试、预算不足与 final-call，
  取消、超时、未确认停止、迟到结果、重复请求/事实、违规结果。
- 验收产物失败、审计失败、模块故障与退出清理；用真实 Core 重做 SystemFaultHandling 第 8 节故障注入。
- 核对 RunSummary、两个终态事件、审计、预算和未知副作用一致，结束事件唯一且为对应接收方最后事件。
- 按第 9 节在 Ubuntu 执行质量门与集成验证，更新实现状态、启动说明、预留清单和验收记录。
- Kernel 范围不得留下未关闭预留；其他团队未交付的能力明确区分为外部阻塞。
  完整产品 E2E 与 F1–F5 依赖其他分支，外围 fake 通过不等于全系统 M1 完成。

### 6.8 中断、异常与启动保护专项

2026-10-17 按负责人确认采用两类异常：Core 维护非停机异常语义；
组合根持有唯一 panic，Supervisor 执行中止及模块停止。
SystemFaultReporter/reportSystemFault/reportFault 名称保留，均指向同一停机流程。
2026-10-18 按 [SystemFaultHandling](M1/SystemFaultHandling.md) 补齐捕获边界、panic 五步、退出码与验收落点；
本节只登记实现与验证位置，语义以规范为准，不在此重新定义协议；源码、fake 与测试尚未迁移。

| 阶段 | 必做工作与验证 |
| --- | --- |
| 一 | Core 私有异常处理入口、状态语义表、收尾失败转 panic；拒绝不误停机、旧事实结算；`KERNEL_FAULT` 只收敛一次 |
| 二 | 取消后收费、重试许可、停止未确认、容量保留与未知效果；不能自行决定 panic 退出码 |
| 三 | 唯一执行事实、取消竞争；panic 的 stop 不假设 Core 已收敛，封锁执行并清理残余 |
| 四 | 消息捕获与失败观察者、取消/完成交错、异常处理再失败进入唯一 panic；`Inbox.request` 拒绝显式观察 |
| 五 | 每模块 start/afterStart 期限、迟到资源释放、停止中迟到启动不重新 ready；设施失败传播 |
| 六 | panic/进程保护前移、取消空上报窗口、bootMs、部分装配清理、重复故障、UI 不可用、首次/二次中断、CLI 参数错误 64、`uncaughtException`/`unhandledRejection` 最小退出、`StopReport`、退出码 |

#### 6.8.1 捕获与规范化边界

各边界只按规范转换一次，不把原始 `Error` 当作跨主体协议，也不吞掉异常。

| 边界或事件 | 实现落点 | 验收要点 |
| --- | --- | --- |
| CLI 参数错误 | CLI/组合根入口 | 返回 64；不加载配置、不构造或启动系统；不触发 panic |
| 配置、Catalog、工厂构造失败 | 组合根 | 登记原始错误并进入 panic；未构造组件不参与清理；已取得资源按登记释放 |
| 非法传输请求、Gateway 准入拒绝 | Fabric/Gateway | 保持传输契约错误或结构化拒绝；无运行的请求不创建 Core 异常 |
| Executor 抛错、超时、`rg` 失败 | Supervisor/Execution | Supervisor 形成唯一执行事实；由 Core 判断运行语义 |
| actor 普通消息处理抛错 | 运行 actor/Core | 可归属运行且收尾机制可用时投递 `KERNEL_FAULT`；已知状态不可信时请求 panic |
| Inbox、OrderedSender、定时器失败 | Fabric/运行 actor | 按是否存在有效运行处理通道路由；通道失效时请求 panic；定时器只入队 |
| 收尾处理自身抛错 | Core | 请求 panic，不再次投递 `KERNEL_FAULT` |
| 模块 start/stop 失败或超时 | ModuleHost/Supervisor | 记账、回滚或继续清理；组合根进入或继续 panic |
| `uncaughtException`、`unhandledRejection` | 组合根 | 停机异常；记录诊断、同步清理已登记子进程、70 退出；不调用 Core，不等待异步停机 |
| Workflow 内部失败 | Workflow（外部） | 先 `closeRun(FAILED, WORKFLOW_INTERNAL)`；无法完成时 `reportSystemFault` |
| UserInteraction 自身失效 | UserInteraction（外部） | 经同一 `reportSystemFault` 入口上报；展示层不自行退出进程 |

#### 6.8.2 panic 五步与职责边界

panic 的业务顺序固定为“中止任务 → 收集错误 → 上报用户 → 安全停机”：

1. 组合根登记原始错误、唯一 `faultId`，写 stderr，封锁启动和命令入口；最小诊断、进程保护与 panic 控制必须在配置、Catalog 和模块构造之前建立。
2. 有期限调用 `kernelCore.abortAllRuns({ faultId, deadlineMs })`。它只交给组合根，不经 Gateway/Fabric；不停止模块，也不调用 `Supervisor.shutdown`。
   Core 封锁新运行，向未 CLOSED 的 actor 投递 `KERNEL_FAULT`；RUNNING 按 `FAILED(KERNEL_INTERNAL)` 收敛，
   `failure.detail` 与审计关联 `faultId`；等运行 CLOSED 且 Outbox 排空，无法完成或到期只记录，不阻止后续步骤。
3. 汇总当前错误并上报用户。stderr 是不依赖 UI、Fabric、存储的基本通道；UI 可用时可正常展示收尾事件，但不能以其应答作为继续清理的条件。
4. 有期限调用 `supervisor.stop`；失败或超时后直接调用 `moduleHost.stop` 兜底。Supervisor 停止接收执行、中止在途执行、
   驱动模块停止并清理子进程与临时资源；不得把未确认停止伪造为完成，也不得在 Core 已关闭后修改已发布结果。
5. 组合根直接清理残留子进程，汇总 `StopReport`，补报清理错误并以非零码退出；必要时由入口结束进程。
   不能仅因异步清理返回就假定失控执行已经消失。

每步有期限；失败只追加到同一次 panic 并继续，不递归启动另一轮 panic；重复故障共用 `faultId`。
panic 由组合根与 Supervisor 协作，但只有一份停机状态、一个 `faultId` 和一次关闭操作。
已收敛运行不因 panic 改写结束原因；收敛中确认 VIOLATION 的优先规则仍有效。引导未完成时没有运行，跳过任务中止，
只清理已登记且取得资源的对象。stderr 诊断自身失败时仍继续清理并非零退出。
RunSummary 发布失败是受控分支：使用 `finalizationError`，不伪造引用，不改原结束原因。
任务收敛与 panic 不承诺在基础设施失效时一定交付 `RunFinished`，未确认的效果按未知记录。

| 主体 | 职责 | 边界 |
| --- | --- | --- |
| Core | syscall、非停机语义、任务状态、授权、结算、收敛 | 不决定进程退出码，不持有全系统停机权 |
| Supervisor | 执行监管、取消、子进程管理；正常引导及 panic 中的模块停止 | 不改写任务结果，不接管未捕获进程异常 |
| ModuleHost | 依赖顺序、启停期限、生命周期账本与回滚 | 不决定异常类别或是否停机 |
| 组合根 | 唯一 panic 入口、错误汇总、用户诊断、停机期限、退出码与最后防线 | 不是模块；不注册 ModuleHost/Fabric/Inbox；不改写 Lease、预算或任务结果 |

`SystemFaultReporter` 是进程内、立即返回且不抛错的适配入口；停机任务的拒绝必须被内部观察。
Executor 不持有 panic 或 `SystemFaultReporter`，其结局由 Supervisor 转换为执行事实。
启动期限涉及组合根 `ShutdownTimeouts` 与 ModuleHost 构造配置，不新增 Fabric Schema；
属于共享接缝的源码迁移按第 3.2 节同步测试，其余在所属阶段完成。

#### 6.8.3 退出码与中断

| 情况 | 处理 | 退出码 |
| --- | --- | --- |
| CLI 参数错误 | CLI 返回参数错误，不启动系统 | 64 |
| 正常关闭 | UserInteraction 记录的退出码 | COMPLETED 0；FAILED 1；RUN_TIMEOUT 2；VIOLATION 3；CANCELLED 130 |
| panic，命令已返回非零码 | 保留该非零码 | 原非零码 |
| panic，命令返回 0、抛错或未返回 | 组合根决定 | 70 |
| 配置、装配或引导失败 | 组合根 | 70 |
| `uncaughtException`、`unhandledRejection` | 最小退出：诊断、同步清理子进程 | 70 |
| 第一次 Ctrl+C（运行中） | `TerminalPort.onInterrupt` → `cancelRun` → CANCELLED | 130 |
| 第一次 Ctrl+C（无运行） | 无可取消对象；不退出 | — |
| 第二次 Ctrl+C | 组合根最小退出 | 130 |

正常关闭保持固定顺序：UserInteraction → `shutdown` → Gateway → Core 收敛及 Outbox 排空 →
`SupervisorPort.shutdown` → Supervisor 驱动 ModuleHost 逆序停止 → 清理残留资源。
70 只由组合根产生；正常任务失败不自动等于 panic；停机异常不得以 0 退出。
进程入口与信号归组合根；CLI 只负责参数与终端适配，终端适配器不得自行退出进程。
子进程创建时登记在 `SubprocessRunner`；组合根持有并注入 Supervisor，`supervisor.stop`、panic 末尾、exit 钩子与最小退出均可幂等调用 `killAll`。
进程内 Executor 无法被强制单独终止；宽限期后记 `STOP_UNCONFIRMED`，由进程退出最终结束。

#### 6.8.4 验收补充

- `SystemFaultHandling` 第 8 节的故障注入必须使用真实 Kernel、Fabric、ModuleHost、存储与组合根；fake 只证明局部顺序与期限，不证明任务收敛。
- 真实子进程退出测试覆盖 CLI 参数错误、第一次/第二次 Ctrl+C、无运行中断、`uncaughtException`、`unhandledRejection`、panic 与正常关闭退出码；不得在测试主进程触发 exit。
- 覆盖 UI/Fabric/存储不可用仍能输出诊断并退出、stderr 诊断失败仍清理并非零退出、重复故障共用 `faultId`、
  Core 超时后继续、Supervisor 失败走 ModuleHost、模块停止失败后继续清理。
- 覆盖首次 Ctrl+C 的 `cancelRun`、无运行首次中断无操作、第二次 Ctrl+C 立即最小退出，以及终端适配器不自退。
- 覆盖 panic 不承诺 `RunFinished`、未知效果如实记录、已收敛运行不被改写。
- 阶段映射保持规范第 7 节：授权超时与预算拒绝归阶段一、二；执行失败、Unit/运行超时、违规与停止未确认归阶段一至四；
  actor 缺陷与收尾/通道失败归阶段四至六；模块启停归阶段三、五、六；Ctrl+C 与未捕获异常归阶段六，UI 接入为外部依赖。
- `health` 只是调用时刻的快照；静默失败通过执行、授权、运行、收尾和系统启停期限发现，不能把 `health` 通过当作故障不存在。
- M1 不实现崩溃恢复、暂停恢复、独立进程外监督、失败停止的无限重试或公开的系统级状态机协议；
  SIGTERM 等信号按 Node 默认行为结束，事件循环卡死或崩溃由用户或启动它的 shell 处理。

长期架构及其他 Module 文档本次未修改；跨模块术语同步留给负责人协调，既有报告接口不改名。

### 6.9 预留登记入口

以下为规划级接入分组；各阶段开发时拆成可验证的具体条目，不以本表代替接口与用例说明。

| 来源 | 依赖或预留 | 完成阶段 | 当前状态 |
| --- | --- | --- | --- |
| 阶段一 | Execution 执行管理、产物与摘要能力 | 二；四完成 actor 接线 | 已完成（阶段二）；阶段四 actor 接线待实现 |
| 阶段一、二 | Supervisor 执行、取消与事实反馈 | 三；四完成事实接线 | 待实现（阶段三） |
| 阶段一至三 | actor 串行调度、定时消息、Outbox 与关闭协调 | 四 | 待实现（阶段四） |
| 阶段一至四 | 真实存储、消息、生命周期及其故障传播 | 五 | 待联调（阶段五） |
| 阶段一至六 | 异常捕获边界、panic 五步、退出码与真实故障注入 | 一、四、六 | 阶段一 Core 非停机语义已完成；panic 与真实故障注入待四、六 |
| 阶段四、五 | 真实组合根启动与完整 Kernel 验收 | 六 | 待验收（阶段六） |
| 全部阶段 | Workflow、UI、Executor 等其他分支交付 | 六记录真实接入结果 | 按实际交付核对，不修改他人范围 |


### 6.10 M1 要求覆盖与阶段交付清单

本表是第 6.2–6.8 节的强制补充，用于阶段退出核对；“已覆盖”表示已安排实现和验证，
不表示代码已完成。接口字段与算法仍以链接规范为准，不在本计划另定义协议。
每行到负责阶段结束时填写实际文件、测试用例、命令及结果；没有证据不得勾选完成。
阶段一的实际实现、测试矩阵与验证证据见 [M1KernelStage1](M1KernelStage1.md) 第 5、6 节；
阶段二的实现、测试矩阵与验证证据见 [M1KernelStage2](M1KernelStage2.md) 第 5、6 节。

| 要求单元 | 规范来源 | 负责阶段 | 必须交付或核对的证据 |
| --- | --- | --- | --- |
| 九个外部 syscall 与状态矩阵 | [Kernel](M1/Module/Kernel.md) §4；[Interaction](M1/Kernel/Interaction.md) §4–5 | 一、四 | 每个请求的合法/拒绝/重放/冲突，RUNNING/CONVERGING/CLOSED 行为；CLOSED 可读产物但不能新建第二个 run |
| Gateway 与身份因果链 | [Gateway](M1/Kernel/Gateway.md) §2–4；[M1Interface](M1/M1Interface.md) §2、13 | 一、四、五 | producer 固定与核验、correlation 固定、causation 衔接；重放不覆盖旧封锁状态；拒绝日志；合法 requestId 的畸形请求结构化拒绝 |
| 定义固定与 AgentRun | [Core](M1/Kernel/Core.md) §6；[AgentToolPool](M1/Library/AgentToolPool.md) §6 | 一、四 | pin/digest/provider 核验、单 ACTIVE、结束后行为；Planner/CodeViewer 共用运行账本且不能重新取得 final-call |
| 授权与 Lease | [Core](M1/Kernel/Core.md) §4；[Interaction](M1/Kernel/Interaction.md) §5.2 | 一、四 | 默认加配置排除规则、只问一次、挂起请求顺序、YES/NO/超时/取消/迟答；拒绝时无执行副作用 |
| Core 非停机语义 | [Core](M1/Kernel/Core.md) §9；[SystemFaultHandling](M1/SystemFaultHandling.md) §2 | 一、四 | 与 syscall 并列的语义处理、受控失败不误 panic、异常处理自身失败不循环、预期结果仍结构化；捕获边界逐项覆盖、`KERNEL_FAULT` 只收敛一次 |
| 异常捕获边界与退出码 | [SystemFaultHandling](M1/SystemFaultHandling.md) §2.2、§5–6 | 一、四、六 | CLI 参数错误 64、正常关闭码、panic 70、首次/二次 Ctrl+C 130、`uncaughtException`/`unhandledRejection` 70；无运行请求不创建 Core 异常；终端适配器不自退；真实子进程退出测试 |
| 收敛与终态 | [Interaction](M1/Kernel/Interaction.md) §6–8 | 一、二、四 | 三步收敛、原因先到优先及 VIOLATION 例外、取消授权、清队列、旧事实结算、兜底、Lease 失效、摘要失败变体；终态发送失败不递归 |
| 审计字段与脱敏 | [Core](M1/Kernel/Core.md) §7；[Persistence](M1/Infrastructure/Persistence.md) §4 | 一、五、六 | 在阶段一落实各审计 type 的字段与触发用例，包含拒绝、结算异常、迟到事实、faultId；核对日志不含密钥、Prompt、源码、工具正文或 Lease |
| RunSummary 统计 | [M1Interface](M1/M1Interface.md) §11；[Execution](M1/Kernel/Execution.md) §8–9 | 一、二、四 | submitted = ok + rejected + failed + notDelivered；授权拒绝和挂起取消计数；rounds 仅已交付 OK/FAILED MODEL；requests 含重试；时间、token、finalCallUsed 与未知效果一致 |
| 六种 Unit 与 FIFO | [Execution](M1/Kernel/Execution.md) §3、5、7 | 二、三、四 | 五类 Executor 请求加内建 REPORT_PUBLISH；状态转换、唯一 FIFO、epoch 改变不推进队首；不得将 report-publish 派发给 Executor |
| 产物所有权与媒体类型 | [Execution](M1/Kernel/Execution.md) §4–5、9；[M1Interface](M1/M1Interface.md) §6.1 | 二、四、五 | 引用位置逐项解析、所有权和完整性双检查、多生产者登记、错误不泄漏其他运行存在性、五种 mediaType；违规输出隔离；收尾仅发布 RunSummary |
| 上下文构建与来源传递 | [Execution](M1/Kernel/Execution.md) §7–8；[M1Interface](M1/M1Interface.md) §6.3 | 二、四、六 | 固定 Prompt/toolSpecs，final 仅 finish；HANDOFF/STATUS 上界；历史正文与工具调用关联；ContextPack 台账全部字段、snapshotId/provenance/prefixSha256 不丢失 |
| 预算与容量 | [Monitor](M1/Kernel/Monitor.md) §3–4；[Scheduler](M1/Kernel/Scheduler.md) §2–3 | 一、二、四 | token 安全整数与单调状态、普通/收尾隔离、ACTUAL/UNKNOWN/NOT_SENT、冲突保守记账；容量与预留原子回滚，STOP_UNCONFIRMED 保留容量；重算估算而非采信 tokenCount |
| 技术重试 | [Execution](M1/Kernel/Execution.md) §6；[Core](M1/Kernel/Core.md) §5.1 | 一、二、三、四 | FAILED/retryable/次数/NOT_SENT 条件、指数退避、全新 executionId、旧实例不覆盖、先释放再预留；不计 Workflow Round、不重复 final-call |
| Supervisor 执行监管 | [Supervisor](M1/Kernel/Supervisor.md) §3–8 | 三、四 | 按 kind 最小环境、凭据仅给 MODEL、subprocess 仅给获准检索；deadline 从 notBefore 或派发时间计算；取消 epoch、无 startedAt 的启动前取消、唯一事实及 requestState 归一化 |
| actor 与事件顺序 | [Interaction](M1/Kernel/Interaction.md) §3–4；[Fabric](M1/Infrastructure/Fabric.md) §4 | 四、五 | 控制仅在消息间优先、内部 syscall 同步、local I/O 可 await、跨主体仅登记；四目标发送器；事件可早于 Ack；seq 缺口不等待；关闭前排空，无等待环 |
| 架构隔离与可替换性 | [Interaction](M1/Kernel/Interaction.md) §3、11；[M1TechStack](M1/M1TechStack.md) §3、11 | 一至五，六汇总 | 私有数据/冻结返回、禁止跨组件私有导入、Executor 不持有存储与 panic；真实 Port 与 fake 运行相同 contract tests，唯一组合位置与允许依赖 |
| Fabric 与协议兼容 | [M1Interface](M1/M1Interface.md) §1.2–1.4、12–13；[SharedContracts](M1/Library/SharedContracts.md) §6 | 五、六 | 登记清单一致、未知 major/重复注册/多余字段/条件字段反例；BoundaryContext 校验、structuredClone 与不可变输出；Unsupported 无副作用、同地址有序、失败后继续排空 |
| 文件存储与保留 | [Persistence](M1/Infrastructure/Persistence.md) §2–4；[ArtifactStore](M1/Infrastructure/ArtifactStore.md) §2–4 | 五 | namespace 限定、路径与符号链接、tmp/rename、跨 Port 审计排队、失败后继续、stop 排空；已有损坏 CAS 不覆盖，get 复验；重启保留 runs 但不恢复运行权限 |
| 启动生命周期 | [ModuleHost](M1/Infrastructure/ModuleHost.md) §2–4；[M1Interface](M1/M1Interface.md) §14.5 | 三、五、六 | 顺序与账本、失败模块清理、start/afterStart/boot 期限、停止中迟到完成与拒绝、资源补清理、ready 前无业务、不重试失败 stop；配置/Catalog/工厂构造失败诊断、启动前建立 panic 控制、无 run 跳过任务收敛、迟到资源释放 |
| panic 与进程保护 | [SystemFaultHandling](M1/SystemFaultHandling.md) §3–8 | 四验证上报，六完成真实控制 | 原始错误不丢、唯一 faultId、组合根不是模块、Core 不决定退出码、`abortAllRuns` 只由组合根调用、panic 五步与 `StopReport`、`supervisor.stop` 失败走 `moduleHost.stop`、UI/Fabric/存储不可用仍诊断退出、stderr 失败仍退出、部分装配清理、不承诺 `RunFinished` |
| 配置与启动检查 | [Monitor](M1/Kernel/Monitor.md) §4；[M1TechStack](M1/M1TechStack.md) §4 | 二核对表示，六回归 | P05a 已完成能力回归；配置覆盖/未知字段/绝对 dataDir；凭据来源；bootMs/startTimeoutMs/stopTimeoutMs 正安全整数与默认值，无网络密钥验证 |
| 只读、安全与不支持能力 | [M1Plan](M1/M1Plan.md) §2–3、7–8；[Interaction](M1/Kernel/Interaction.md) §5.1 | 一、三、四、六 | 真实目录 FORBIDDEN 与 fake 目录 UNSUPPORTED_CAPABILITY 两路径；路径逃逸/排除/非授权网络与副作用零成功；测试工具在运行前后对同一仓库计算摘要并比较 |
| Workflow/UI 故障上报集成 | [SystemFaultHandling](M1/SystemFaultHandling.md) §2.2；[Workflow](M1/Module/Workflow.md) §11.1 | 六，外部协作 | Workflow 内部失败先 `closeRun(FAILED, WORKFLOW_INTERNAL)`，无法完成才 `reportSystemFault`；UserInteraction 同一入口；Cary 侧交付后验证注入与上报 |
| 整机固定任务与发布证据 | [M1Plan](M1/M1Plan.md) §6–8；[M1TechStack](M1/M1TechStack.md) §11 | 六，外部协作 | F1–F5、至少一个真实模型跑全部任务；报告来源完整性与未确认项、成功率/成本/延迟基线、兼容矩阵、限制清单与运行说明；外部缺失则整机验收未完成 |

### 6.11 预留关闭与验收边界

阶段一的 Core 使用现有 Monitor/Scheduler 及替身测试其裁决；阶段二完成真实协作。
阶段四关闭 Kernel 内部预留，但允许组合根 panic 控制及新增启动保护仍按阶段六完成；
阶段四用注入的观察替身验证 panic 请求，不把替身纳入产品入口，也不宣称系统级停机已验收。
阶段五以真实基础设施联调，panic 的完整进程退出证据在阶段六补齐，避免各阶段互等。

每项预留从登记到关闭需保留接口、责任阶段、依赖、用例和证据。
阶段结束新发现的缺陷必须修复，或明确移交给本计划已有的后续阶段；不得用“后续联调”掩盖本阶段职责未实现。
涉及共享接缝时按第 3.2 节处理；不自行向他人发送消息或修改其目录。

验收分两栏记录，不能合并成一个模糊的“通过”：

- Kernel/infra 自身验收：真实 Kernel、四类 infra、组合根与受控 Executor/外部模块替身，
  证明内部控制、安全边界、故障处理与兼容契约。阶段六结束前全部通过。
- M1 整机验收：真实 Workflow、UserInteraction/CLI、Catalog、ExecutorSet 与至少一个真实模型，
  执行 F1–F5 并记录证据。其他分支未交付、模型凭据或运行条件缺失时记录外部阻塞，
  不标记整机 M1 完成，不以 demo:fake 或只跑部分任务替代。

真实评测记录 commit、Ubuntu/Node/pnpm 版本、Provider/模型、配置、定义 digest、
fixture 与预期来源、结果、token、成本和耗时。固定 fixture 由测试工具准备，产品不调用 git。
默认按 F1–F5 全部验收，不自行启用 M1Plan 的缩减范围选项。
普通质量门保持离线；真实模型评测独立执行。

Interaction 的数值校准与审计记录待设计项已有落点：阶段一确定运行审计字段和用例；
阶段六用固定任务校准 token/执行/启动/收尾期限并形成记录模板，不新增一个未分配的第七阶段。
临时目录清理由 Supervisor 保持唯一产品责任；阶段五删除 Persistence 未使用的重复清理入口，
同步测试及说明，避免继续保留悬而未决的双实现。

### 6.12 本次规划闭合结论

2026-10-17 对 M1Plan、M1Interface、M1TechStack、SystemFaultHandling、
Kernel 六组件/Interaction、四类 Infrastructure、SharedContracts 逐项核对，
并只读核对其他 Module、ExecutorSet、AgentToolPool 的边界与交付依赖。
第 6.10 节将本分支要求映射到实现阶段与验收证据；外部职责单独登记，不转移为 Kernel 实现。

本轮闭合的是六阶段开发计划修订，不是实现或验收。
六阶段顺序保持不变；阶段一与阶段二已分别于 2026-10-19 完成验收，阶段三规划中，阶段四至六未开始。
后续按负责人指定阶段执行，完成时更新状态与证据。
2026-10-18 仅补齐 SystemFaultHandling 的实现与验收落点（捕获边界、panic 五步、退出码与中断、真实故障注入），
不改变六阶段顺序、阶段范围或已定决定，也不新增第七阶段。
2026-10-19 只同步阶段一验收结果，不改变阶段范围、顺序或规范。
除新增需求、规范冲突或实际交付变化外，不再重复展开整轮阶段重规划。

## 7. 已定的设计决定

C01–C08 起源于 Cary 的 2026-10-10 至 10-13 决定；C07 的四级分类由负责人在
2026-10-17 确认的两类异常方案替代，其余兼容规则保留。新规范已开始实现，阶段一完成 C01–C06 的
Core 部分，阶段二完成 Execution 接入；不按旧代码推定其余阶段已完成。

| ID | 决定 | 已实现 | 剩余 |
| --- | --- | --- | --- |
| C01 | 结算异常（超估算、重复结算冲突）以 `SettlementResult` 返回给 Core 审计，不用 throw | Monitor；Core 消费异常并审计；阶段二真实结算集成通过 | — |
| C02 | Execution → Core 同步登记：先登记尝试，再申请资源或提交结果；派发前登记执行实例；旧实例不得覆盖新实例结果 | 接口、`AttemptIdentityRegistry`、Core 与 Execution 接入（阶段一、二） | 阶段四 actor 联调 |
| C03 | `RunRegistry.handleForward` 接收不可变 `BoundaryContext`；不改公共 Schema | 接口；产品 `RunRegistry`（阶段一） | 阶段四接线 |
| C04 | Fabric 启动后经 `afterStart` 注册 Supervisor 处理器；钩子失败回滚 | 完成 | — |
| C05 | `requestId` 合法的畸形 syscall 由 Gateway 结构化拒绝；缺失或非法 `requestId` 是传输契约错误 | Fabric、Gateway；阶段一核对完成 | 阶段四产品链联调 |
| C06 | RunSummary 写入失败时，终结事件带 `finalizationError`，不伪造引用，保留原结束原因 | contracts、`finalizeRunEvents`、Core 接入（阶段一）；阶段二 RunSummary 发布通过 | 阶段四收尾联调 |
| C07 | 两类异常、Core 语义与组合根 panic（2026-10-17 修订）、角色权限、`abortAllRuns`、故障结束原因复用 `FAILED(KERNEL_INTERNAL)`（SystemFaultHandling） | 旧版关闭与生命周期基础；Core 非停机语义（阶段一） | 执行监管（三）、actor（四）、启动期限（五）、panic 与入口（六）；计划落点见 §6.8 |
| C08 | `SystemFault` 类型在 contracts；Workflow 与 UserInteraction 注入 `reportSystemFault` | 接口与注入 | 两个模块一侧由 Cary 完成 |

## 8. 注意事项

1. **fake 不是验收。** fake 纵向链通过不代表真实 Kernel 的权限、额度、取消与业务验收通过；不要把 `fake-kernel` 搬成产品实现。
2. **UnitReport 可能先于 SyscallAck 到达**，实现与集成测试都不得假设相反的顺序。
3. **发送失败不一定是契约缺陷。** Fabric 停止后发送得到 `NOT_RUNNING`；故障关闭期间由此产生的 `KERNEL_FAULT` 多半发生在运行
   已 CONVERGING 或 CLOSED 时，按规范只写审计，但审计条目应区分这两种原因。
4. **SupervisorPort 没有结构化拒绝的返回形态**，处理器只能抛错，调用方按发送失败处理。
5. **进程内 Executor 不响应中止信号时无法强制终止**，必须如实报告 `STOP_UNCONFIRMED`，不得伪造已停止。
6. **存储的竞态边界**：路径与符号链接检查只覆盖静态重定向，不承诺抵御同机恶意进程的并发改写。
7. **阶段五落实**：Supervisor 保持 tmp 清理责任；删除 Persistence 无产品调用方的 clearTemporaryFiles，
   同步测试与说明，避免两处实现分叉。
8. **排除规则的旧副本**：`executor-set` 中的 `DEFAULT_EXCLUSIONS` 由 meti 删除并改用 contracts（#28），本分支不要改它，也不要再用它。
9. **panic 不承诺终态事件。** 任务收敛与 panic 在基础设施失效时可能无法交付 `RunFinished`；未知效果如实记录，不伪造成功。
10. **最小退出不是第三类异常。** `uncaughtException`、`unhandledRejection` 直接走诊断、同步清理与 70 退出；
    不调用 Core，不等待异步停机；终端适配器不得自行退出进程。
11. **退出码归属固定。** CLI 参数错误 64，panic 70，正常关闭码由 UserInteraction 记录；70 只由组合根产生，
    停机异常不得以 0 退出。
12. **组合根不是模块。** 它不注册 ModuleHost、Fabric 或 Inbox，只调用已登记的控制对象；
    Supervisor 自身失效时仍应能独立报告、调用 ModuleHost 并清理子进程。

## 9. 环境与验证

- 验收平台是 Ubuntu LTS（Windows 上用 WSL2）；Node 24.19.0、pnpm 11.25.0；需要安装 ripgrep。CI（`ubuntu-24.04`，已装 ripgrep）
  对每次推送运行质量门。
- 提交前：`pnpm install --frozen-lockfile`、`pnpm run build`、`pnpm run check`、`git diff --check`。
- 原生 Windows 上 `agent-tool-pool` 的符号链接测试因 `EPERM` 失败，与本分支无关，不要为此修改该包。
- 存储路径、权限、rename、符号链接、`rg` 子进程、Ctrl+C 必须在 Linux 上验证；普通测试不得依赖真实模型或网络。
- 真实子进程退出测试覆盖 CLI 参数错误 64、第一次/第二次 Ctrl+C 130、无运行中断、`uncaughtException`/`unhandledRejection` 70、
  panic 70、正常关闭码；不得在测试主进程触发 exit。
- 故障注入使用真实 Kernel、Fabric、ModuleHost、存储与组合根；fake 只证明局部顺序与期限，
  不宣称任务收敛或全系统验收。
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
| 2026-10-16 | P05a 阶段二：启动关系校验与组合根接线；修正 JSON 转义上界与 final 窗口规范，调整输入预算 | Ubuntu：build、定向 ESLint/Prettier、diff 检查通过；离线冒烟覆盖默认配置、交接遍历、工厂前拒绝和 final 窗口；完整测试待阶段三、四 |
| 2026-10-16 | P05a 阶段三：新增配置关系与固定输入上界测试；适配 fake 测试及 demo 的离线假凭据 | Ubuntu：build、control-plane 7 个文件/96 项测试（新增 59 项）、定向 ESLint/Prettier、diff 检查通过；全仓质量门与 fake demo 执行待阶段四 |
| 2026-10-16 | P05a 阶段四完成：修正 Monitor 旧预算测试数据，全仓验收与离线 fake demo 通过 | Ubuntu：pnpm install --frozen-lockfile、pnpm run build、pnpm run check（38 个文件/355 项）、pnpm run demo:fake（退出码 0）、git diff --check；无真实模型调用 |
| 2026-10-16 | 计划初步修订：更新基线与实现状态，以六阶段替代旧 P06–P11 安排，补充偏差修正、预留规则与验收边界；由负责人继续主导修订 | 仅文档修订；文档结构、历史阶段引用及 git diff --check 核对，未执行开发或重跑历史测试 |
| 2026-10-17 | 按负责人决定修订 M1 与 Kernel 异常设计：两类异常、Core 私有语义、唯一 panic、启动保护与期限；保留其他模块接口名称 | 仅文档修订；源码与测试待各阶段实现，长期架构和其他 Module 文档未修改 |
| 2026-10-17 | 完成 M1 要求覆盖核对，补齐兼容/身份链/统计/安全/真实评测及预留关闭规则；六阶段计划修订闭合，均未开始实施 | 文档范围、链接、格式与差异检查；本轮不运行产品测试、不提交 |
| 2026-10-18 | 按 SystemFaultHandling 补齐计划：捕获边界、panic 五步与职责、退出码与中断、真实故障注入与验收证据 | 仅文档修订；文档结构、链接、格式与差异检查，未运行产品测试、不提交 |
| 2026-10-19 | 阶段一（1.1–1.6）完成并验收：Core 运行管理、外部 syscall、授权与 Lease、预留结算、结果检查、收敛、异常语义与审计；Gateway 偏差关闭。报告见 [M1KernelStage1](M1KernelStage1.md) | 阶段一报告记录：pnpm run build、pnpm run check（44 个文件/433 项）、pnpm run demo:fake（退出码 0）、git diff --check 通过；使用 Execution 与 Supervisor 替身，无真实模型调用 |
| 2026-10-19 | 同步计划状态：阶段一标记完成，更新实现状态、偏差、预留表与 C01–C07 进度；阶段二至六仍未开始 | 仅文档修订；格式、链接与 `git diff --check` 检查 |
| 2026-10-19 | 阶段二（2.1–2.6）完成并验收：Execution 骨架/FIFO、产物归属、内建 report-publish 与 RunSummary、五类 ExecutionRequest、全终态事实与技术重试、预算/容量集成、纵向链与 FIFO 验证；报告见 [M1KernelStage2](M1KernelStage2.md) | `pnpm run check`（48 个文件、485 项）；`pnpm run test:coverage`（全仓语句 92.45%、分支 83.06%、行 94.55%）；`pnpm run demo:fake`（退出码 0）；`git diff --check` 通过；2.1–2.3 已提交于 `51fec05`，2.4–2.6 随本轮提交 |
| 2026-10-19 | 阶段二文档收尾：将 M1KernelStage2.md 重写为实现报告，压缩阶段二实现记录，并同步计划状态、偏差、预留表与 C01–C06 进度 | 仅文档修订；Prettier、链接与 `git diff --check` 检查 |
| 2026-10-19 | Stage3 规划：确定 3.1–3.5 子阶段及执行表、取消、宽限期、事实映射、最小环境、停止清理方案；明确 VIOLATION 例外、usage 与 requestState 归一化；工作文档见 [M1KernelStage3](M1KernelStage3.md) | 仅文档修订；Prettier 与 `git diff --check`；不标记阶段三完成 |
