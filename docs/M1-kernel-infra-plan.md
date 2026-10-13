# M1 Kernel 与 Infrastructure 实现计划

## 1. 用途与当前状态

- 更新日期：2026-10-10。
- 本文是后续对话继续 Kernel 与 Infrastructure 实现工作的上下文和进度入口。
- 本文已由用户要求创建；创建计划不代表已经授权开始业务代码实现。
- 当前已完整阅读 docs 文档，并检查相关骨架、基础设施实现、组合根和测试。
- 当前 P01 契约与接缝核对已完成；尚未修改 Kernel 或 Infrastructure 的业务实现。
- 已在 Windows 运行构建与 P01 范围基线测试，结果见第 10 节；尚未进行 Ubuntu/WSL 验收。
- 后续对话开始时，先读本文，再检查工作区状态与当前代码；不要只凭本文推断实现已经完成。

## 2. 用户明确规定的修改边界

以下边界是用户的明确指令，后续 AI 必须遵守。

### 2.1 另一位负责人的范围

另一位负责人负责 AgentToolPool、ExecutorSet 和 prompt 工程。
不得主动修改以下范围的业务代码、定义、提示词、工具描述或行为策略：

- `packages/libraries/agent-tool-pool/**`，包括目录加载逻辑、定义文件、digest 和封存数据。
- `packages/libraries/executor-set/**`，包括 Executor 行为、Provider Adapter、仓库访问与检索算法。
- prompt 工程相关内容，无论文件放在哪里；包括 Prompt 正文、模板、模型可见工具描述，
  以及用于指导模型的业务提示策略。

为避免间接改变这些组件的行为，该范围的测试、manifest 和配置也不自行修改。
可以只读检查这些文件、调用其公开 Port、运行现有测试，但不得以重构、格式化、
依赖升级、测试修复或“顺手修正”为由改动它们。

发现冲突或认为必须修改上述范围时，必须在修改之前通知用户，说明：

1. 涉及的具体文件、组件和冲突证据。
2. 为什么当前接口或行为阻碍 Kernel/Infrastructure 实现。
3. 是否可以在自己的范围内通过 Adapter、fake 或正确使用现有契约解决。
4. 最小修改建议及生产者、消费者、测试和兼容性的影响。

通知不等于授权。未取得用户明确授权之前，不修改对应部分，也不以旁路绕过架构。
可以继续其他不依赖该变更的工作，并在本文记录阻塞及待协调事项。
不自动向另一位负责人或其他聊天发送消息；跨聊天或外部沟通须有用户授权。

### 2.2 本任务的主要实现范围

- `packages/infrastructure/fabric/**`
- `packages/infrastructure/module-host/**`
- `packages/infrastructure/persistence/**`
- `packages/infrastructure/artifacts/**`
- `packages/modules/kernel/**`

为完成接线与验证，可以在必要时修改：

- `apps/control-plane/**`：组合根、配置校验、生命周期接线。
- `packages/testing/**`：Kernel/Infrastructure 所需的 fake、harness、集成与架构测试。
- 对应文档：本文及与实际变化直接相关的 Kernel/Infrastructure 说明。

以下范围不属于本任务主动实现范围：

- Workflow 的 Agent 循环、业务验收、交接策略。
- UserInteraction 的交互业务和 CLI 产品功能。
- AgentToolPool、ExecutorSet 与 prompt 工程。

公共 `packages/libraries/contracts/**` 是协作接缝，不当作 Kernel 私有代码任意调整。
涉及公共 Port、Schema、工厂签名或跨模块语义变更时，先向用户说明影响并协调，
同步相关规范与契约测试；不得仅为使自己的实现方便而更改接口。
对测试 fake 的修改不能被用来悄悄重定义另一位负责人的真实行为。

用户指定本文路径为 `docs/M1-kernel-infra-plan.md`，保留该名称。
它是对文档 PascalCase 命名惯例的明确例外。

## 3. 规范来源与实施范围

优先阅读：

- [文档索引](README.md)
- [M1 指南](M1/README.md)
- [M1 范围与验收](M1/M1Plan.md)
- [字段级协议与装配接口](M1/M1Interface.md)
- [Kernel 内部交互](M1/Kernel/Interaction.md)
- [Kernel 对外行为](M1/Module/Kernel.md)
- [M1 技术栈](M1/M1TechStack.md)
- [工程规范](Style.md)

Architecture 定义长期职责、安全约束和状态所有权，M1 定义当前交付子集。
会议记录与 Issue 中的历史提案不覆盖现行规范；本文也不替代现行协议。
发现当前规范之间冲突时记录证据，先协调，不自行选择有利于实现的一份。

M1 为本地、单用户、单项目、单进程、单活动 Task 的只读仓库分析。
一个进程只创建一个运行；Planner 与 CodeViewer 单向交接，Unit 按 FIFO 串行执行。
Supervisor 与 Kernel 核心同进程，可信内置 Executor 在进程内运行，只有 rg 使用子进程。
运行状态、Lease、账本、Outbox 和 Inbox 在内存中；磁盘保存运行记录、审计与产物。
不实现崩溃续跑、暂停/恢复、并行 Agent、跨进程 IPC、分片或生产级隔离。

## 4. 架构不变量

- UserInteraction 管输入和展示，Workflow 管业务推进与验收，Kernel 管受控执行。
- Gateway 是外部 syscall 入口，只检查身份、契约和准入投影，不保存 Lease 或 token 账本。
- Lease 及用户授权记录只由 Core 持有；其他组件只拿到裁决和派生范围。
- Core、Execution、Monitor、Scheduler 分别拥有私有状态，只经规定接口交互。
- Execution 仅经 CoreSyscalls 申请资源和提交结果检查，不直连 Monitor 或 Scheduler。
- Monitor 只在被 Core 调用时运行；Scheduler 管 API 调用机会，不维护执行 FIFO。
- 运行 actor 不是第七个组件，只组织消息顺序和组件接线，不取得各组件的领域写入权。
- actor 不可重入，控制通道只在消息之间优先；定时器仅入队，不直接改领域状态。
- 跨主体调用在处理函数中只登记，处理结束后由 actor 外的发送器按目标顺序发送。
- 内部 syscall 同步执行，不等待 I/O、不回调 Execution；需要的收尾在处理末尾完成。
- Supervisor.execute 受理即返回，执行事实作为新消息进入 actor，不能等待执行完成才返回。
- 核对 runEpoch 与把结果放入 Outbox 必须在同一同步处理段完成。
- Kernel 对外事件只有 Core Outbox 一个出口；Execution 和 Executor 不直接推进 Workflow。
- 只有 Execution 写正式 Artifact，包括内建 report-publish 和 RunSummary。
- ArtifactRef 不是读取权限；Execution 必须核对本运行归属，再交存储复验完整性。
- 运行状态只能 RUNNING → CONVERGING → CLOSED；结束事件是各接收方的最后一个事件。
- token 不足仅拒绝新的消耗型预留，不强制停止运行；已发生消耗仍结算，结果仍可交付。
- 未知消耗不按零处理；MODEL 请求可能已发出时不做技术重试。
- 启动只清理 dataDir/tmp，保留 runs；仓库与 dataDir 的真实路径不得互相包含。
- 模型动作是提案；写文件、项目命令、项目测试等未支持能力不能产生副作用。

## 5. 已检查的代码基线

以下是源码检查结果，不代表完整验收：

| 范围                      | 当前情况                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| Fabric                    | InProcessFabric、通用 Inbox、有序发送器和 Port 存根已有实现及测试      |
| Persistence               | FilePersistence、JSON 记录、JSONL 审计、临时文件清理已有实现及测试     |
| ArtifactStore             | LocalArtifactStore、内容寻址、SHA-256/size 复验已有实现及测试          |
| ModuleHost                | 依赖排序、启动回滚、逆序停止已有实现及测试                             |
| Kernel                    | 六组件及 run-actor 主要为空目录或 NOT_IMPLEMENTED 工厂；私有接口已定义 |
| Supervisor                | rg 专用 SubprocessRunner 已实现，但完整 Supervisor 尚未实现            |
| Contracts / AgentToolPool | 已有协议、目录加载与定义固定基础；只读使用，不重写                     |
| 组合根                    | composeSystem、配置加载和 fake 纵向链已有接线                          |
| 产品其他组件              | Workflow、UserInteraction、ExecutorSet 的产品工厂仍有未实现部分        |

不要把 fake 纵向链通过当成真实 Kernel 的权限、额度、取消和业务验收通过。
不要直接把 fake-kernel 整体搬成产品实现；fake 只用于协议联调和测试接缝。

## 6. 分步实施计划

每一阶段都附带适当测试和验证，退出条件成立后再标记完成。
Core 分阶段接入，各阶段不是新的并行事实源。

| ID  | 顺序与范围                      | 主要工作                                                               | 退出条件                                             | 状态                               |
| --- | ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| P01 | 契约与接缝核对                  | 核对公共 Port、私有接口、配置、接线和架构约束；记录必须协调的接口缺口  | 实现所需接缝明确，没有未经授权的跨负责人改动         | 已完成                             |
| P02 | Fabric                          | 验证身份、Schema、数据隔离、Inbox、发送顺序与失败处理                  | 控制优先、不可重入和处理结束后发送均有证据           | 已完成；真实 actor 接入在 P06 再验 |
| P03 | Persistence → ArtifactStore     | 补齐路径边界、写入失败、关闭排空、运行隔离与完整性                     | 临时写入不形成有效引用；运行数据保留；失败可解释     | 未开始                             |
| P04 | ModuleHost + Supervisor 引导    | 实现实际启动顺序、Fabric 就绪后服务注册、启动失败回滚                  | 全部就绪前不开放请求；已启动模块正确回滚             | 未开始                             |
| P05 | Monitor → Scheduler             | 实现预留、实际/未知结算、finalReserve、单向额度状态与机会释放          | 幂等及异常结算、普通与 final 额度边界正确            | 未开始                             |
| P06 | actor + Core 运行管理 + Gateway | 实现运行创建、请求幂等、两通道、计时、准入投影与消息分发               | createRun 到 RunStart 真实链通过，actor 无等待环     | 未开始                             |
| P07 | Core 定义与授权                 | 实现 AgentRun 登记、定义核验、Unit 准入、询问、回答/超时与私有 Lease   | 无权限不派发，同范围只问一次，拒绝被记住             | 未开始                             |
| P08 | Supervisor 执行                 | 用 fake Executor 验证受理、notBefore、deadline、取消、宽限期和唯一终态 | TERMINATED/STOP_UNCONFIRMED 及迟到返回语义正确       | 未开始                             |
| P09 | Execution + Core 结果路径       | 实现 Attempt/FIFO、引用解析、产物、重试、预留与结果检查                | 内建报告发布及五类 Executor 路径通过，无资源泄漏     | 未开始                             |
| P10 | Core 完整收敛与关闭             | 统一结束、取消、超时、违规、兜底、摘要、最终事件及 Outbox 排空         | 每个运行结束事件唯一，未知效果明确，设施关闭顺序正确 | 未开始                             |
| P11 | 组合与 Ubuntu 验收              | 真实 Kernel 配合外围 fake 验证，再按其他组件就绪情况接入真实系统       | 本范围质量门和故障集成通过，Ubuntu 证据已记录        | 未开始                             |

P06 起就验证基本取消与运行状态边界，不等 P10 才首次考虑失败路径。
P10 负责证明各组件的收敛逻辑在整条链上正确组合。
P11 的完整产品 E2E 和 F1–F5 依赖其他负责人交付，不因外围 fake 通过就标记 M1 完成。

## 7. 实现前需要特别核对的问题

以下为建立计划时的检查关注点；P01 已确认项、证据与协调建议见第 10 节。未确认的项目仍不作为缺陷结论：

1. OrderedSender.enqueue 会立即启动发送；actor 需在处理结束后才提交待发项，
   不能在处理中直接调用它并假定已经满足发送时序。
2. Persistence.stop 的写入跟踪与尚未进入实际写入的排队审计，都应被排空；
   同一路径多个 auditLog 句柄的顺序和失败语义也需核对。
3. Persistence namespace 的目录隔离不等于访问能力隔离；组合时必须限制 Owner 的可用范围。
4. 校验 Artifact 引用和内容，区分 Kernel 对外统一拒绝语义与存储内部错误；
   不把现有读写测试当成全部损坏、并发和失败发布场景已覆盖。
5. Supervisor 必须在 Fabric 就绪后、执行请求到达前注册服务；
   核对 ModuleHost 是否需要引导接缝，避免生命周期循环依赖。
6. 文档要求 Monitor 返回结算异常供 Core 审计，而现有 settle 签名仅返回 BudgetState；
   在 P01 明确兼容的异常返回机制，不靠解析异常字符串。
7. Core 结果检查需要执行实例、重试、预留和归属关联；
   核对私有接口能否提供所需只读值，不能通过访问 Execution 私有状态补缺口。
8. 启动校验必须覆盖可达 Agent 的 provider、模型限制、不可裁剪上下文和预算；
   当前基础配置校验不能被假定已完成这些跨定义检查。
9. 结果先于 SyscallAck 到达是允许的；集成测试不能隐含相反假设。
10. Fake 的用户拒绝等脚本行为不必然等于真实业务策略；真实行为以当前 M1 规范为准。
11. 进程内 Executor 不响应 AbortSignal 时无法被强制终止；必须如实报告停止未确认。
12. 文件存储失败、RunSummary 发布失败、发送契约失败等情况需有明确处理路径；
    若现行规范不足，先记录并协调，不能伪造成功或终态产物引用。

## 8. Windows、WSL 与验收分工

正式验收要求是 Ubuntu LTS；Windows 本机使用 WSL2 Ubuntu LTS 对应验证。
CI 当前使用 ubuntu-24.04，实际本地 WSL 发行版、运行时和工具版本尚未检查。

| 工作                                                       | 环境要求                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| 阅读、编辑 TypeScript、纯逻辑与 fake 测试                  | 不强制 WSL；正式开发建议统一在 WSL 运行工具链                        |
| Monitor、Scheduler、授权、幂等、actor 和进程内 Fabric 测试 | 可在 Windows 初步执行，最终在 Ubuntu 复验                            |
| 存储路径、权限、rename、关闭排空                           | 必须在 Ubuntu 做目标平台验证                                         |
| /proc/self/fd 文件打开后路径复核                           | 需要 Linux；属于 ExecutorSet，验证或冲突协调不能变成主动修改         |
| symlink、路径逃逸、文件替换场景                            | 在 WSL/Linux 文件系统上验证，尊重 ExecutorSet 修改边界               |
| rg 子进程中止、输出超限、截止时间、清理                    | 在 WSL 验证目标平台行为；另测 rg 不可用的路径                        |
| CLI Ctrl+C、授权撤销、退出码与系统关闭                     | 需要 Ubuntu 用户流程验证；不主动实现外围业务                         |
| 本范围质量门、集成与正式 M1 E2E/F1–F5                      | 必须有 Ubuntu LTS 执行证据；后两项依赖完整产品就绪                   |
| 真实模型 API 调用                                          | 技术上不要求 WSL；正式评测随 Ubuntu 系统执行，普通测试不依赖真实模型 |

建议 WSL 内独立安装仓库 manifest 指定的 Node 与 pnpm，并独立安装 Linux node_modules。
优先使用 WSL 的 Linux 文件系统工作副本验证 Linux 文件语义；避免混用 Windows 依赖。
系统 dataDir 位于被分析仓库之外；Secret 不进入本文、协议、日志或 Artifact。

M1 不需要部署 PostgreSQL、DBOS、NATS、Redis、S3、Docker/Podman、进程池或生产级沙箱。
不得因长期架构提到这些技术，就提前把它们作为当前实现的必需依赖。

## 9. 验证与进度更新规则

- 每完成一个可独立验证的任务，或发现阻塞/作出重要协调决定，就更新本文。
- 状态使用：未开始、进行中、待协调、已完成；没有测试证据不标记已完成。
- 实现修改时运行适当的单元、契约、集成或故障测试；不要以真实模型替代确定性测试。
- 提交前按工程规范运行 pnpm run check 和 git diff --check，并按阶段执行 build。
- 文档单独修改只做格式和差异检查，不宣称业务测试已经执行。
- 验证记录写明命令、Windows/WSL/CI 环境、通过/失败/未运行，以及必要的限制。
- 更新已检查源码基线，防止新对话把已经完成的内容再次实现。
- 记录实际修改的文件、关键不变量、下一步和待协调范围，不只记录“完成”。
- 不自动 commit、push、创建 PR 或合并；按用户后续授权和工程规范执行。
- 不覆盖用户或其他负责人的未提交改动；每次开始先检查 git status 与 diff。
- 本文不记录密钥、完整 Prompt、源码正文或未经脱敏的模型输出。

### 9.1 当前继续点

- 当前任务：P01 核对已完成；用户已批准 C01–C06，接口与独立逻辑已开始实现，见第 12 节。
- P02 的 Fabric 基础设施已完成并有测试证据；下一阶段按顺序进入 P03。真实 actor 接入时在 P06 复核发送时序。
- 尚未检查：本地 WSL 实际环境、Ubuntu 验收和远端 Issue/PR 进度；Windows 基线已检查。
- 不要先启动真实模型评测，也不要修改另一位负责人的包。

### 9.2 待协调事项

| ID  | 事项                                                            | 影响阶段 | 用户决定 | 状态                                              |
| --- | --------------------------------------------------------------- | -------- | -------- | ------------------------------------------------- |
| C01 | Monitor 结算异常的结构化返回，详见 10.2                         | P05、P09 | 用户同意 | 接口与 Monitor 已实现，Core 待接入                |
| C02 | 尝试与执行实例的同步登记接缝，详见 10.2                         | P06、P09 | 用户同意 | 接口与登记逻辑已实现，Core/Execution 待接入       |
| C03 | RunRegistry 接收不可变消息上下文，详见 10.2                     | P06      | 用户同意 | 接口已更新，RunRegistry 待实现                    |
| C04 | Fabric 就绪后 Supervisor 注册的启动钩子，详见 10.2              | P04      | 用户同意 | ModuleHost 钩子已实现，Supervisor 待接入          |
| C05 | Fabric 校验失败与 Gateway INVALID_REQUEST 的错误边界，详见 10.2 | P02、P06 | 用户同意 | Fabric/Gateway 已实现，产品链待联调               |
| C06 | RunSummary 永久写入失败的安全退出语义，详见 10.2                | P10      | 用户同意 | 契约与事件构造已实现，Core/UserInteraction 待接入 |

这些是核对得到的设计协调事项，不代表需要修改另一位负责人的业务代码。
全部事项均已由用户决定；按第 2 节的修改边界继续实施。上表的“已实现”仅指所列层次，不表示产品链已完成。

### 9.3 完成与验证记录

| 日期       | 任务               | 实际变更                                        | 验证与环境                                                                                       | 下一步                       |
| ---------- | ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------- |
| 2026-10-10 | 建立计划           | 创建本文；明确用户修改边界、实现顺序和 WSL 要求 | Windows：单文件 Prettier 格式检查、git diff --no-index --check 通过；未运行业务测试或 WSL 验收   | 等待用户授权实现，再开始 P01 |
| 2026-10-10 | P01 契约与接缝核对 | 仅更新本文；记录接缝矩阵、C01–C06 建议与继续点  | Windows：build 通过，16 文件/134 测试通过；文档格式、UTF-8/LF、链接与差异检查通过；未做 WSL 验收 | P02；对应接口变更仍待确认    |

## 10. P01 核对结果与继续实现接缝

### 10.1 核对范围与结论

核对日期：2026-10-10。源码基线：`a86173aa47a4faa5a091ddbfea97ba18e653cb6b`。
当前分支：`feature/M1/kernel-infrasturcture`；沿用当前分支，未新建分支。
开始与结束检查均仅见本文档未跟踪，没有其他待提交源码改动。

P01 已完成的是契约、接线、配置和所有权核对，以及构建与既有测试的基线验证。
并未实现六组件，也未解决下表的接口缺口。待确认项是后续相应阶段的准入条件，不能当作已授权改动。

| 接缝                                 | 核对依据                                                                     | 结论及下一步                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Workflow / UserInteraction → Gateway | `contracts/src/ports.ts`、`fabric/src/stubs/port-stubs.ts`、M1Interface 2、4 | 四个 Workflow syscall、五个交互请求与 Schema ID 对齐；保持调用方工厂和 Port 签名                           |
| Gateway → Kernel Core                | `GatewayForwardSchema`、`AdmissionProjectionSchema`、Gateway 规范            | 已覆盖九类转发与单向准入投影；Core 接收 envelope 时仍须检查 producer，消息上下文见 C03                     |
| Core → Supervisor → Core             | `SupervisorPort`、`ExecutionFactSink`、ExecutionRequest/Fact Schema          | 五种 Executor、scope/limits/result 关联与终态原因码已编码；Supervisor 必须受理即返回，事实入口仅入队       |
| Execution → ExecutorSet              | ExecutorRegistry / ExecutorEnvironment 与 M1Interface 7、8                   | 保持现有注册表、已解析输入、AbortSignal、SubprocessRunner 和 credentials；不需改 ExecutorSet 来开始 Kernel |
| Core / Execution → CatalogPort       | pinAgent、PinnedDefinitionSet 与 M1Interface 9                               | 现有只读接口足以固定定义、校验 digest，并沿 handoffTargetRef 遍历可达 Agent；不需新增目录枚举接口          |
| Execution → ArtifactStore            | ArtifactStorePort 与 Execution 4、5、9                                       | 只有 Execution 持有写入能力，归属索引由它维护；存储复验不能替代归属检查                                    |
| Workflow / Core → Persistence        | PersistencePort、composeSystem                                               | 目前向两方注入同一完整对象，namespace 所有权只靠约定；P03/P04 增加同签名的 Owner 限定 facade               |
| Core → Monitor / Scheduler           | Kernel 私有接口与 Monitor/Scheduler 规范                                     | 预留、释放、finalize 与容量 Port 已定义；结算异常 C01、执行身份 C02 尚缺接缝                               |
| Supervisor → ModuleHost              | ModuleHostControl 与 ModuleHost 启动循环                                     | 只暴露整体 start/stop，无 fabric 就绪阶段回调；启动接缝见 C04                                              |
| 组合根 → 所有产品工厂                | M1Interface 14 与 composeSystem                                              | 工厂签名对齐；保持只构造不启动、由 supervisor.start 引导；跨定义配置校验需要补齐                           |

路径中的包名以仓库 `packages/` 下对应包为准；以下证据链接均指向具体源码或权威文档。

### 10.2 必须协调的接口与规范缺口

#### C01：Monitor 无法按现有返回类型交回结算异常

证据：[Monitor 2、3.4](M1/Kernel/Monitor.md) 要求把超估算与重复结算冲突以返回值交给 Core 审计，
但 [MonitorDuties.settle](../packages/modules/kernel/src/interfaces/index.ts) 与
[Interaction 3.4](M1/Kernel/Interaction.md) 的返回值均只有 BudgetState。

建议最小变更：在 Kernel 私有接口中定义 SettlementResult，返回 budgetState 和类型化 anomalies；
明确 finalize 触发的 UNKNOWN 结算也不会丢失异常证据。Core 登记待写审计，处理末尾完成 I/O。
不使用异常字符串、Monitor 直接写 Core 审计或共享账本代替返回值。
影响限于 Kernel 私有类型、Monitor/Core 消费者、相应规范和测试，不进入公共 contracts。
该签名与现行规范冲突，须先确认，再在 P05 落地。

#### C02：Core 缺少同步核对尝试及当前执行实例的身份接缝

证据：[Core 5](M1/Kernel/Core.md) 要求核对尝试归属、当前 executionId，且同步 syscall 不回调 Execution。
[现有接口](../packages/modules/kernel/src/interfaces/index.ts) 中 createAttempt 只在 Promise 完成后返回 id，
ResultCheck 只携带身份声明，没有独立登记接缝；retryExecution 也无法独立证明首次执行与重试的关联。
此外，空闲时 createAttempt 可能立即推进，甚至提交内建报告或派发前拒绝，不能等其返回后才首次登记尝试。

建议最小变更：增加 Execution → Core 的同步身份登记 syscall，分别登记尝试的不可变关联和新执行实例；
必须先登记尝试，再申请预留或提交结果检查；必须先登记执行实例，再登记 Supervisor.execute 待发送项。
Core 保存结果裁决所需的关联投影，Execution 继续独占 FIFO、执行状态和重试历史。
Core 的预留关联保存 estimatedTokens/final，用于重试重新申请；不把 reservationId/grantId 放入对外消息。
不新增 Core 对 Execution 的同步查询回调，不由 actor 保存并裁决领域关联。
影响为 Kernel 私有类型、Core/Execution、Interaction/Core/Execution 文档和相应测试。用户已同意按该方向实施；必须测试重复结果、迟到事实、取消与内建 Unit 的同步完成。

#### C03：RunRegistry.handleForward 没有传入消息上下文

证据：[M1Interface 2.4](M1/M1Interface.md) 要求沿用 Gateway 生成的 correlationId；
[RunRegistry](../packages/modules/kernel/src/interfaces/index.ts) 只接收 GatewayForward，
而 tenantId/projectId/correlationId 等位于 Envelope，createRun payload 中没有这些字段。
CatalogPort 和对外 Fabric 发送均需要 BoundaryContext。

建议最小变更：私有 handleForward 增加不可变上下文参数，由 kernel-core 边界校验 envelope 后传入；
运行上下文在创建时固定，运行内关联值以已固定值为准，不使用“当前 envelope”全局变量。
未知运行事实的审计可以在边界处理；已知运行 report(fact) 使用已固定的运行上下文。
不向 GatewayForwardSchema 增加字段，不改变 Workflow/UserInteraction 或公共 FabricPort。
影响为 Kernel 私有 RunRegistry 与 Interaction 3.4，须在 P06 前确认。

#### C04：启动控制接口没有提供 Fabric 就绪阶段的注册点

证据：[ModuleHost 2](M1/Infrastructure/ModuleHost.md) 指定 Fabric 就绪后注册 SupervisorPort；
[ModuleHost.start](../packages/infrastructure/module-host/src/index.ts) 是整体启动循环，
[ModuleHostControl](../packages/modules/kernel/src/supervisor/index.ts) 没有阶段钩子。
[FakeSupervisor](../packages/testing/src/fakes/fake-kernel.ts) 在全部模块 start 完成后才注册服务，
只能证明 fake 链没有提前发请求，不能证明产品按指定引导顺序注册。

建议最小变更：ModuleHost.start 支持可选 afterStart(moduleId) 钩子，Supervisor 在 fabric 启动成功后
仅注册自己的服务；随后继续启动 kernel-core 等模块。先把模块计入已启动集合，再调用钩子，
确保钩子失败时也回滚 Fabric；启动/回滚错误都保留。
现有无参数调用保持可用，工厂外层签名不变，但 ModuleHostControl 是公开导出的装配接缝，
用户已同意按该方向实施，仍须同步规范；测试 fake 按需要同步。不把 Supervisor 作为受它自身驱动的模块重新注册。
Kernel 不能直接 import persistence 包清理 tmp，因为当前依赖边界只允许 contracts/fabric；
可以在 Supervisor 内按现行规范使用 Node 文件系统能力，不因此扩大包依赖。

#### C05：无效 syscall 在 Fabric 被抛出，无法得到 Gateway 的结构化拒绝

证据：[Gateway 3](M1/Kernel/Gateway.md) 规定请求不符合 Schema 返回 INVALID_REQUEST；
[InProcessFabric](../packages/infrastructure/fabric/src/in-process/in-process-fabric.ts) 在调用处理器之前
通过 assertValid 校验，失败抛出 ContractValidationError；
[现有测试](../packages/infrastructure/fabric/src/fabric.test.ts) 明确断言该异常，已在本轮通过。
这不只是 Gateway 尚未实现：即使实现其校验，非法 payload 也到不了处理器。

用户已确认的处理规则：requestId 合法的畸形请求由 Gateway 结构化拒绝；缺失或非法 requestId 按传输契约错误处理。
实现时给 Gateway syscall 路由定义受控的结构化校验失败处理接缝，
确保 producer 检查、Schema 拒绝、issuer、请求标识和日志归属一致；其他路由的契约错误仍显式报告。
缺失/无效 requestId 无法按现有 SyscallRejected Schema 形成响应；这一类不伪造 ID。
只允许 Gateway syscall 的受控处理接缝接触有合法 requestId 的畸形正文；其他路由仍严格校验，不把传输异常伪装成 Gateway 裁决。
可能影响 Fabric 路由实现、Gateway、存根测试及 M1Interface/Fabric/Gateway 文档；
若具体实现需改公共 Port/Schema，先通知并核对跨模块兼容性。P02 先验证路由边界，再实现该规则。

#### C06：永久存储失败时，必填 RunSummary 引用无法产生

证据：[Interaction 6](M1/Kernel/Interaction.md) 要求先发布摘要，再发送最终事件；
[runEndVariants](../packages/libraries/contracts/src/kernel-control/run-outcome.ts) 对所有结束原因都要求 runSummaryRef。
ArtifactStore.put 可能失败；目前没有定义无法写入摘要时如何安全退出并解开系统关闭等待。

建议先明确系统级不可恢复存储故障的停机语义，保持不伪造 ArtifactRef、不无限等待。
优先考虑保留现有公开 Schema、明确此类故障的安全关闭与错误上报；
若必须允许没有摘要的最终事件，将影响公共 contracts、Workflow 和 UserInteraction，需单独协调。
本项是规范缺口，尚未通过故障注入复现产品行为；P10 实现前必须明确，不能提前修改外围业务。

### 10.3 可在本任务范围内完成、无需改其他负责人代码的工作

1. 配置关系校验放在组合根加载 Catalog 后、调用产品工厂前，而不是 Kernel 工厂中：
   KernelCoreDeps 不含 workflow.entryAgentRef，组合根持有完整配置与 CatalogPort。
   更新 system-config.ts 中“跨 Catalog 校验属于 Kernel”的注释时，应与实际职责一起修正。
2. 通过 pinAgent 从入口 Agent 遍历 handoffTargetRef，维护 visited，核对目标 digest、provider、模型能力、
   每个 Agent 的普通/final 工具 Schema 与不可裁剪输入上界；不读取或修改私有目录实现。
3. 使用 contracts 的 estimateItemTokens/estimatePackTokens 与 registry.jsonSchemaOf。
   只读取固定 Prompt 与 modelDescription，不改写提示词，不擅自改变模板渲染规则。
   tokenLimit、finalReserve、wrapUpMargin、模型输入/输出限制和 FILE_READ 预算关系按现行规范核对。
4. 给 Workflow 与 Core 注入同签名 PersistencePort facade，拒绝越权 namespace；
   保留 capabilities 和既有工厂签名，不让组件取得 FilePersistence 具体实例。
5. 原样复用现有五类 Executor 注册表和共享 harness；Supervisor 对 MODEL 缺省 requestState 取 UNKNOWN，
   非 MODEL 丢弃 usage/requestState，按 Schema 形成事实，执行产物仍由 Execution 写入。
6. Kernel 核心边界直接验证 envelope.producer，不能仅相信 GatewayForward.caller。
   现有 serveSupervisor/serveExecutionFacts 存根只传 payload，产品边界需保留身份核验，
   可以在本范围新增带核验的服务适配，不通过修改另一个组件实现获得信任。
7. actor 使用控制/工作两个通道且不做 Inbox 去重，请求按 canonical-json SHA-256 幂等。
   createRun 的幂等摘要只涵盖原请求，不包含 Gateway 为每次转发临时生成的 workflowRunId。
   消息处理与 settleConvergence 完成后才把待发送项交 OrderedSender；定时器仅入队。
8. 运行全部 CLOSED 后还需排空各目标发送器，Supervisor.shutdown 受理后异步停止模块，
   避免当前 Fabric.request 的响应与销毁 Fabric 互相等待。

这些是后续实现约束与设计方向，不是本轮代码变更，也不替代 C01–C06 的决策。

### 10.4 验证证据与限度

环境：原生 Windows PowerShell，Node `v24.19.0`、pnpm `11.25.0`。
本轮先执行构建，再复跑以下基线测试，避免跨包导入陈旧 dist：

```text
pnpm.cmd run build
pnpm.cmd exec vitest run packages/libraries/contracts/src packages/infrastructure packages/testing/src/architecture.test.ts packages/testing/src/harnesses apps/control-plane/src/config/system-config.test.ts apps/control-plane/src/bootstrap/compose-system.test.ts
```

结果：构建通过；16 个测试文件、134 项测试通过。覆盖公共 Schema/Registry、四类 infra、
现有架构边界、Catalog/Executor harness、基础配置和 fake 组合链。
既有架构测试只是依赖与导入规则检查；骨架尚未实现，不能据此宣称 Lease 隔离或生命周期行为已验收。

另以构建产物执行只读配置探针：将默认 tokenLimit 改为 1，assertSystemConfig 仍成功；
规范要求的 finalReserve + wrapUpMargin 为 `48000 + 8192 + 64000 + 8192 = 128384`。
这证明基础 Schema 校验不等于关系校验；没有修改默认预算、目录定义或配置文件。

未运行：完整 pnpm run check、真实产品链、Provider API、WSL/Linux 权限/路径/进程验收。
构建只生成被忽略的产物；没有修改任何业务源码、manifest、公共契约、定义或 prompt。
本轮实际变更仅本文；单文件 Prettier、UTF-8 无 BOM、LF、文末单换行、文内链接与差异检查通过。

P01 的退出条件已满足：接缝清单与缺口明确，验证基线已记录，没有未经授权的跨负责人改动。
下一阶段是 P02；后续阶段遇到对应 C 项时，先取得明确决定再变更接口。

## 11. 用户反馈后的决策与待定问题（2026-10-10）

- C02 已确认：尝试必须先同步登记，再申请资源或提交结果；派发前登记当前执行实例。
  实现须核对归属、当前 executionId、runEpoch、重复与迟到事实；旧实例不得覆盖新实例结果。
- C04 已确认：增加 Fabric 就绪后的 Supervisor 服务注册时机。钩子失败须回滚已启动模块；
  保持注册幂等，并验证失败后重启是否会留下旧 handler。
- C05 已确认：requestId 合法的畸形 syscall 由 Gateway 结构化拒绝；缺失或非法 requestId
  是传输契约错误。实现只针对 Gateway syscall 路由建立受控边界，保留其他 Schema 的严格校验。
- C01 尚待最终决定：JavaScript/TypeScript 的 throw 可以在同进程由 Core 捕获，但超估算和重复结算冲突
  是“已记账、仍交付结果”的异常事实。现行 Monitor/Interaction/Core 规范明确要求作为返回值交给 Core 审计。
  直接 throw 若导致结果检查提前退出，可能丢失预算状态、调用机会释放或 UnitReport；若异常在账本变更之后
  抛出，重试还可能重复扣账。建议保留返回类型化异常，真正无法维持账本不变量的故障再 throw，
  由 Core 转为 KERNEL_INTERNAL 收敛。若用户选择 throw 表达可继续结算异常，须修改现行规范，
  且异常必须含已提交的预算状态并有完整 catch/finally 测试；不要把异常字符串作为业务协议。
- C03 当前只要求解释，尚未单独决定接口方案。RunRegistry 属于 Core 的跨运行部分，
  负责 createRun/shutdown、以 workflowRunId 路由到 actor、回收与墓碑；它不持有运行内 Lease/账本。
  现有 handleForward 只收 GatewayForward 正文，而 tenantId/projectId/correlationId 位于 Envelope，
  因此建议边界校验 envelope.producer 后传不可变 BoundaryContext，创建时按运行固定。
- C06 用户提出“RunSummary 失败时提交 exception 给用户并继续关闭”。方向合理，但当前没有跨主体
  任意 throw 到用户的通道；RunFinished/RunClosed 的每种变体都强制 runSummaryRef，
  UserInteraction 只凭 RunFinished 展示、记录退出码、请求 shutdown。直接 throw 会让等待者无最终事件，
  `main` 又先等 runCli 后等 whenStopped，可能无法进入关闭。
  推荐把故障在 Core 转为结构化的结束故障，向 Workflow 和 UserInteraction 交付同一结果，
  用户看到明确“摘要保存失败”、退出码非零，然后排空并关闭。需要给该专用结束变体允许缺少
  runSummaryRef，仍保留原 closeReason/未知效果的必要语义；现有 VIOLATION 优先级不能被存储故障掩盖。
  这会触及公共 RunEnd Schema、Workflow/UserInteraction 展示与结束测试，超出本任务单独修改边界；
  在用户确定具体契约和相关负责人协调前，不实现或修改外围业务。
  若 Fabric/终端也失效、结构化事件发不出去，则使用进程级故障退出与有界清理作为最后兜底，
  不伪造 runSummaryRef，也不承诺正常结果展示。

以上为当时的决策记录；实际代码进度以第 12 节为准。

## 12. 决策落地进度（2026-10-10）

本轮开始实现用户批准的 C01–C06。代码只改 Kernel、Infrastructure、公共 contracts 和必要的控制面测试；
没有改动 `agent-tool-pool`、`executor-set` 或 prompt 工程业务代码。

| 事项 | 当前代码                                                                                                                                         | 仍须完成                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| C01  | `Monitor.settle` 返回 `SettlementResult`，携带结构化异常事实；超估算、重复冲突按实际用量入账且幂等                                               | Core 处理返回值，写入审计、生成 UnitReport 并执行最终预算裁决                                            |
| C02  | 新增同步 `registerAttempt`/`registerExecution` 接口及 Core 私有 `AttemptIdentityRegistry`；检查归属、当前 epoch、执行实例、Lease、重试和重复结果 | 在 Core/Execution 的受理、预留、派发和结果路径接入；覆盖真实迟到事实与收敛竞态                           |
| C03  | `RunRegistry.handleForward` 增加只读 `BoundaryContext` 参数                                                                                      | 实现产品 RunRegistry，在边界固定运行上下文并据此审计与发事件                                             |
| C04  | `ModuleHost.start(afterStart)` 支持 Fabric 启动后的钩子；失败回滚并保留原故障与回滚故障                                                          | 实现 Supervisor 产品注册，并在组合根接入；验证失败重启无旧 handler                                       |
| C05  | Fabric 仅允许 Gateway 的九个 syscall 路由注册畸形正文处理器；合法 requestId 由 Gateway 返回结构化拒绝，缺失/非法 requestId 继续抛传输契约错误    | 增加产品链联调与完整 Gateway 状态/幂等测试                                                               |
| C06  | RunClosed/RunFinished 增加无摘要引用的 `finalizationError` 变体；`finalizeRunEvents` 保留原结束原因和未知效果，返回发布故障供审计                | Core 在发布失败后仍投递两个终结事件并关闭；UserInteraction 产品显示错误且保证非零退出，Workflow 消费变体 |

本轮单元测试覆盖 ModuleHost 钩子回滚、Fabric/Gateway 请求边界、Monitor 结算、身份登记和 RunSummary 发布失败。
Windows 上 `pnpm run build` 与 `pnpm run typecheck` 已通过；`pnpm exec vitest run --exclude packages/libraries/agent-tool-pool/src/adapters/file/file-definition-source.test.ts`
通过 30 文件、231 测试。完整 `pnpm run test` 为 30 文件/243 测试通过、1 个 `agent-tool-pool` 符号链接测试因 Windows `EPERM` 失败，
不应为规避该环境限制修改另一位负责人的业务代码。完整 `pnpm run check` 的格式阶段另报告该包三个未修改的 YAML 文件不符合 Prettier；
本轮修改的源码已单独格式化，`pnpm run lint` 已通过。WSL 验收仍未做。下一步继续 P02 与产品接入。

继续新对话时先检查 `git status`，保留当前未提交改动；不要把独立助手类误认为已完成 Core/Supervisor/UserInteraction 产品实现。

## 13. P02 Fabric 验收与继续点（2026-10-10）

在既有请求路由、Schema 校验与拷贝基础上，本轮补了以下 Fabric 行为：

1. `BoundaryContext` 在传输边界校验；上下文非法时即使正文有合法 `requestId`，仍作为传输契约错误。
   只有正文自身畸形且具有自身合法 `requestId` 时才进入 Gateway 的结构化拒绝接缝。
2. Inbox 对重复请求立即拒绝，对未知通道不占用去重键；`idle()` 在启动前有积压时等待排空。
   重复 `start` 被拒绝；失败观察者抛错不停止后续消息，未观察的错误从 `idle()` 显式返回。
3. 同一地址的并发 `send` 串行受理，前一投递失败不阻断下一投递。OrderedSender 可正确发送 `undefined` 项；
   失败观察者抛错后继续处理剩余项，并由 `flushed()` 报告该错误。
4. 测试证明控制通道优先、Inbox 处理不可重入、模拟 actor 在处理结束后提交待发送项。真实 Core actor 尚未实现，
   P06 接入时必须再次做产品级时序测试，不把模拟测试当作产品行为验收。

本轮修改位于 `packages/infrastructure/fabric/src/` 及其规范，不涉及另一位负责人的业务代码。
Windows 验证：`pnpm run build`、`pnpm run lint`、`pnpm run typecheck`、`git diff --check` 通过；
排除已知 Windows 符号链接限制的完整测试为 30 文件、237 测试通过。
`pnpm run format:check` 仍只报告另一位负责人所有的三个未修改 YAML 文件；本轮源码已单独格式化。
WSL 验收仍未做。
下一步 P03：Persistence → ArtifactStore，先检查路径与命名空间隔离，再实现失败与关闭排空测试。
