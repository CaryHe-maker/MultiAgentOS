# MultiAgentOS M1 Kernel 设计范围

## 1. 目的与设计阶段

本文记录 M1 Kernel 已确认的设计范围，作为模块级设计和实现的边界。
范围遵循 [Kernel 架构](../../Architecture/module/Kernel.md) 的六组件宏内核组织，服务于
M1 只读仓库分析。授权、额度、准入、执行交付与结束流程的具体机制见 [UnitCheck](../UnitCheck.md)；
本文与 UnitCheck 共同构成 M1 Kernel 的设计基线。

设计工作分为五个阶段：

1. 确定 M1 Kernel 实现范围（已完成）。
2. 讨论 Kernel 具体机制及单进程软件组织、数据通信机制（已完成的部分见 UnitCheck，剩余事项见第 6 节）。
3. 编写能够直接指导实现的模块级设计文档初稿。
4. 根据其他开发者意见完善设计。
5. 设计项目目录结构。

## 2. 目标与运行边界

M1 采用最小可行子集：Gateway、Core、Scheduler、Execution、Supervisor、Monitor 均承担真实职责，
共同完成一条受控的串行执行闭环，不以空接口代替核心行为。

| 维度 | M1 边界 |
|---|---|
| 运行组织 | 本地、单用户、单项目、单进程、单活动 Task；Planner 与 CodeViewer 通过单向 handoff 串行交接 |
| 业务目标 | 只读仓库分析，支持模型、仓库概览、搜索、文件读取、上下文组装与报告发布所需的执行能力 |
| 执行顺序 | 同轮可提出多个工具调用，所有 Unit 不区分是否涉及 API，统一按 FIFO 串行执行；不引入并行 Agent 调度 |
| 信任边界 | 仅开放可信内置模块和 Executor，不加载任意不可信执行代码 |
| 只读约束 | 不修改被分析仓库，不执行项目命令或项目测试 |
| 必要系统操作 | 允许受控的系统状态、Artifact、审计写入，以及获准的模型 API 请求 |
| 资源限制 | token 额度按 WorkflowRun 计，Planner 与 CodeViewer 共用；运行总时长设上限 |
| 控制能力 | 支持取消、停止和最终收敛；不提供暂停/恢复与崩溃续跑 |
| 用户交互 | 单次目标输入与最终输出；运行中支持终止和必要授权，访问仓库前收集一次 Y/N |

系统自身写入与被分析仓库写入必须明确区分；模型 API 访问不构成任意网络访问权限。
两个 Agent 均属于 M1 交付，Kernel 支持其执行归属与资源交接，业务 handoff 由 Workflow 管理。

## 3. 软件组织与通信边界

M1 设计必须覆盖单进程内的组件组织、模块装配、启动与关闭关系，以及数据通信机制。
各类状态仍只有一个权威写入 Owner，不因同处一个进程而开放内部状态的跨模块修改。

系统仅设 UserInteraction、Workflow、Kernel 三个 Module。Execution 纳入 Kernel；
上下文算法归 ExecutorSet，所需运行状态归 Execution，不再设置独立 ContextEngine。
AgentToolPool、ExecutorSet、SharedContracts 是静态库，不作为自主服务或独立生命周期主体。

ArtifactStore、ModuleHost、Fabric、Persistence 保持独立基础设施地位，由 Kernel 承担相应管理职责，
但不成为 Kernel 内部组件。管理关系与架构分类分别表达：

| 基础设施 | 独立职责 | 管理关系 |
|---|---|---|
| ArtifactStore | 不可变内容存储、完整性与保留原语 | Execution 承担管理职责，产物只由 Execution 写入与发布 |
| ModuleHost | 系统装配、就绪与生命周期机制 | Supervisor 承担监管与生命周期协调职责 |
| Fabric | 通信、路由与事实交接 | Core 承担管理职责，不因此中转全部消息 |
| Persistence | 状态存取与持久化机制 | ModuleHost 管理生命周期，各 Owner 保有数据权威 |

基础设施提供技术机制，领域 Owner 保留业务决定权与状态所有权。
独立地位不要求独立进程，M1 采用单进程部署。

### 3.1 通讯主体与调用形式

M1 全系统运行在一个操作系统进程中，按通讯主体划分调用形式：

| 通讯主体 | 组成 | 主体内部 | 与其他主体之间 |
|---|---|---|---|
| Kernel 核心主体 | Core、Monitor、Scheduler、Execution | 直接函数调用 | 进程内可序列化消息 |
| Gateway | Gateway | — | 进程内可序列化消息 |
| Supervisor | Supervisor（及其监管的 Executor 执行实例） | — | 进程内可序列化消息 |
| 外部 Module | UserInteraction、Workflow | — | 进程内可序列化消息，经 Gateway 进入 Kernel |

进程内消息使用现有 MessageRouter 承载，保持逻辑上独立的通讯边界，后续可直接替换为跨进程通信。
所有调用都必须遵守以下约束：

- 使用明确、可序列化的数据契约，并在主体边界执行运行时校验。
- 明确异步调用、请求关联、结构化错误、超时及接受与完成的区别。
- 协作不依赖共享可变对象、裸内部句柄或同步回调链。
- 大对象通过受控 Artifact 引用传递，必要的小型结构化结果可以直接交付。

### 3.2 syscall 定义

| 请求关系 | 定义 |
|---|---|
| 外部 syscall | UserInteraction、Workflow 经 Gateway 向 Core 请求 Kernel 服务 |
| 内部 syscall | Kernel 其他组件向 Core 发起的请求（申请预留、提交结果检查、上报异常等） |
| 职责接口调用 | Core 处理请求时调用 Monitor、Scheduler、Execution 的职责接口；不属于 syscall |

外部模块与独立基础设施的受保护服务、执行及控制请求统一通过 Gateway 移交 Core。
内部组件向 Core 发起请求无需绕回 Gateway，但仍须校验调用身份与职责权限。
观测数据可直接交给 Monitor；影响账本或权限状态的事实（如用量结算）必须随内部 syscall 交给 Core。

M1 不实现跨进程 IPC、多进程部署或分布式可靠投递。

## 4. 六组件职责范围

### 4.1 Gateway：统一申请入口与准入

- 外部模块申请受保护系统服务、执行能力或提交 Kernel 控制请求时，以 Gateway 为唯一申请入口。
- 确认可信调用身份，校验、规范化请求并建立请求关联，将请求信息移交 Core 的统一控制响应逻辑。
- 检查准入封锁标志：运行被封锁时拒绝 `registerAgentRun` 与 `submitUnit`，放行 `endAgentRun`、`closeRun` 与取消。
- 准入被拒时直接向调用方返回 AdmissionException，并在契约错误时向 Core 报告。
- 授权与 Lease 裁决交由 Core 负责；Gateway 不保存 Lease 实体、快照或验证缓存，也不持有额度数据。

准入封锁由 Core 设置，原因包括 `USAGE_LIMIT`、`RUN_TIMEOUT`、`CANCELLED`、`CLOSING`、`VIOLATION`，
在同一 WorkflowRun 内设置后不解除。M1 不实现请求速率限制。

### 4.2 Core：授权、租约与控制裁决

- 实现并维护统一控制响应逻辑，处理 Syscall（含内部与外部 syscall）、Interruption（中断信号）
  和 Exception（AgentOS 异常，可来自包括 Kernel 在内的整个系统）。
- 通过各组件职责接口落实处理，不递归提交同一控制请求，也不接管其权威状态。
- 维护 AgentRun 登记（AgentRun 身份、所属运行、固定的 Agent 定义引用及状态），不持有 AgentRun 实例。
- 明确授权依据及能力上限：本地用户或系统配置提供授权依据，固定定义限定能力上限；
  模型输出、工具注册和能力声明本身不产生授权。
- 是否需要 Lease，以 Unit 定义中声明的受保护能力为准；M1 的受保护能力为 `repo.read`。
- 将 Lease 作为 Core 私有运行时数据，维护其签发、检查、复用、失效与撤销；对外只返回裁决与派生的范围约束。
- 保留用户的授权决定：属于已同意范围的安全子集直接签发 Lease，危险行为每次询问（M1 不涉及危险行为）。
- 代为调用 Scheduler 分配调用机会、调用 Monitor 预留与结算额度。
- 处理结果检查并向 Execution 返回判定；执行前被拒的 Unit 由 Core 直接向 Workflow 交付结果。
- 维护运行控制状态及其版本（runEpoch），设置准入封锁，组织收敛，发出 RunClosed。

M1 支持只读分析所需的基础人工授权，由 UserInteraction 收集响应，Core 判断适用性并决定
是否签发 Lease；拒绝或超时不默认放行。不引入任意能力扩权、复杂审批、委派与再委派或长期跨运行租约。

### 4.3 Scheduler：API 调用机会

- 由 Core 调用：根据固定定义与可用状态匹配 API 调用目标，分配与释放调用机会（M1 每个 provider 并发为 1）。
- 不维护执行队列，不改变 Unit FIFO 顺序；非 API 步骤不经过 Scheduler。
- 不判断额度；停止或取消后不再发放机会。

实际 Provider 请求由 Supervisor 监管的模型执行任务发起，Execution 维护相应执行状态。
M1 不实现优先级、公平性、抢占、并行 Agent 调度、负载均衡或自适应并发。

### 4.4 Monitor：资源账本与额度控制

- 维护 token 额度、预留、已消费、释放和未知消耗，账本以 WorkflowRun 为单位。
- 由 Core 调用完成预留与结算；所有结算以预留标识幂等，防止重复扣减或重复释放。
- 区分实际消耗与未知消耗；失败、超时或取消不能直接按零消耗处理。
- 软阈值只在结算时判断，以额度状态（NORMAL / WRAP_UP）返回 Core；硬阈值在预留和结算时都可以触发。
- 保有在达到硬阈值时主动提交 Exception 的权力；M1 中体现为被 Core 调用时返回"达到硬限制"。
- 观测数据可被动接收，只用于观测与诊断，不影响账本。

Workflow 负责轮次上限与业务收尾，Monitor 负责实际资源事实。M1 中 Workflow 不接收额度数值，
只接收额度状态。M1 不建设通用监控告警平台、CPU/GPU 周期采样、异常预测或自适应反馈调节；
AgentRun 级额度留作后续演进。

### 4.5 Supervisor：系统生命周期与执行任务监管

- 负责软件系统的启动与正常关闭，协调 ModuleHost 完成装配、依赖就绪与按序卸载。
- 接收 Execution 的执行请求，以 `executionKind` 作为执行定义引用找到对应 Executor，
  装配、创建并启动执行实例，注入范围约束、限制与受控依赖。
- 监管任务生命周期、超时、取消与停止期限，向 Execution 交接完成、失败、终止及违规事实。
- 负责运行总时长计时；超时时向 Core 报告，由 Core 按 Exception 停止运行（`RUN_TIMEOUT`）。
- 不维护 Unit 执行队列，不接管 UnitAttempt、业务执行顺序或结果验收。

M1 的关闭限于停止新执行、尽力结束在途任务及程序资源释放，不实现崩溃恢复。
Supervisor 不能承诺强制终止任意失控任务，也不能在所在进程卡死或崩溃后继续监管；
无法确认停止的任务以"停止未确认"报告，相关效果标记为未知。
独立 OS 子进程、进程池等执行载体仅作为后续扩展方向。

### 4.6 Execution：尝试、执行队列与产物发布

- 幂等建立 UnitAttempt，维护步骤、执行进度、输入输出、已知与未知效果及新旧尝试关系。
- 维护唯一的 Unit FIFO 执行队列，按受理顺序串行推进；前一执行活动完成或确认停止后才启动下一项。
- 需要 API 时经内部 syscall 向 Core 申请预留；执行完成后经内部 syscall 向 Core 提交结果检查，用量随之交给 Core。
- 向 Supervisor 提交 `executionKind`、已获准参数、范围约束与限制，由其装配并执行，不自行扩大操作范围。
- 管理本次分析所需的上下文构建记录、检索台账和来源关联；为上下文组装解析本运行内的输入产物。
- 产物只由 Execution 写入 ArtifactStore，包括执行产物与 Workflow 经 `report-publish` 提交的最终报告。
- 依据 Core 的判定封装结果并交付 Workflow；交付前核对 runEpoch，状态已变时不再交付。
- 收到 Executor 违规报告时隔离该次输出，不交付、不发布，并经内部 syscall 上报 Core。

模型输出只是动作提案，由 Workflow 形成后续 UnitIntent；静态库不保存可变运行状态。
非 API 工作并发执行仅作为后续演进方向，不纳入 M1。

## 5. 执行与控制闭环

完整路径、原因码与异常规则见 [UnitCheck](../UnitCheck.md)。本节只列关键约束。

### 5.1 授权、执行与结果确认

```text
Workflow 调用 submitUnit
  -> Gateway 准入（被拒：Gateway 返回 AdmissionException）
  -> Core 定义核验与 Lease 检查（被拒：Core 向 Workflow 交付 UnitReport）
  -> Execution 幂等创建 UnitAttempt，按 FIFO 串行推进
  -> model-call：内部 syscall 申请预留，Core 调用 Scheduler 与 Monitor
  -> Execution 提交 executionKind 与参数，Supervisor 装配、执行并交回事实
  -> Execution 内部 syscall 提交结果检查；Core 核对结果，model-call 调用 Monitor 结算
  -> Core 返回判定（含额度状态与 runEpoch）；Execution 核对后交付 UnitReport
  -> Workflow 作业务判断，结束或提交后续 UnitIntent
```

Lease 检查未通过不等于可以申请授权；明确禁止或超出能力范围的请求直接拒绝。
Core 检查结果的执行归属与可接受性，Workflow 判断业务结果是否成功；实际执行完成、Core
接受结果和业务验收必须分别表达。执行失败或结果被拒绝均不能免除已发生的消耗。
FIFO 约束执行请求的推进顺序，不阻塞取消、停止、Exception 和查询等控制处理。
重复请求、重复结果和迟到结果不得导致重复执行、重复结算或重新推进业务。

### 5.2 取消、停止与最终收敛

取消/停止必须区分请求收到、接受与实际生效。正常结束（`closeRun`）、硬限制、超时、取消与违规
共用同一收敛过程：设置准入封锁并更新 runEpoch，清空队列并中止在途任务，等待正在进行的交付结束，
释放调用机会，完成最终结算，使 Lease 与用户授权记录失效，发出 RunClosed。
未知效果不得被标记为成功或直接自动重跑。

硬限制、超时与违规触发时，Core 以终止信号结束 Kernel 内部等待中的调用，不再向 Workflow 交付该 Unit 的结果。

### 5.3 panic 与安全停机

panic 仅用于可信基础或关键安全不变量已无法维持的情况，普通工具失败、权限拒绝或 Provider
错误不直接触发全局 panic。除 Core 内部受控维护逻辑外，绕过 Syscall 访问 Lease，或外部主体
绕过 Gateway 的受保护入口执行内核操作，均属于权限边界失守；经可信边界确认后立即拒绝并进入 panic 处置。
Lease 正常过期、撤销或权限不足仅返回拒绝，不触发 panic。不能仅凭 Executor 自报触发 panic。

突然崩溃不保证停机步骤全部执行，不能依赖崩溃后的 Kernel 发出最终通知。
M1 不提供自动故障恢复、透明续跑或高可用。

### 5.4 启动清理、运行记录与审计

- 运行结束后，系统由 Supervisor 按序卸载模块并正常关闭；下次启动从空白运行状态开始，不恢复未完成运行。
- 运行数据按运行分目录：`runs/<runId>/` 保存 AnalysisReport、运行记录与审计记录，启动时**不删除**；
  启动时只清空临时数据。清理不涉及被分析仓库、配置或凭据。
- 运行记录分两部分：业务部分（步骤、Round 数、收尾原因）由 Workflow 写入；执行部分（provider 请求次数、
  token 用量与未知消耗、耗时、结束来源、未知效果）与审计记录由 Core 写入。
- 普通日志不记录 Secret、完整 Prompt、源码或工具正文，必要内容使用受控 Artifact 引用。

## 6. 后续机制设计事项

下列事项仍待第二阶段讨论：

| 主题 | 需要明确的机制 |
|---|---|
| 组织与通信 | ModuleHost 装配顺序、各主体的消息契约与超时 |
| 调度与账本 | tokenLimit、finalReserve、每轮输入上限等数值；输入 token 上界的估算方法 |
| 执行与控制 | 技术重试的错误分类、单次调用的中断细节 |
| 生命周期与故障 | panic 判定边界与安全停机通路、用户通知 |
| 记录与验证 | 运行记录与审计的具体格式、验证场景及验收证据 |

本阶段不规定多进程与 IPC、并行调度、强隔离、暂停/恢复和崩溃续跑的后续交付排期。
