# MultiAgentOS Kernel

## 1. 定位

Kernel 是统一权限与执行管理核心，采用宏内核组织。
它在同一模块内组织授权、调度、实际执行、资源和监管。
Workflow 决定业务目标与验收，Kernel 负责操作是否获准及如何受控完成。

## 2. 六组件

| 组件 | 责任 | 状态归属 |
|---|---|---|
| Gateway | 外部 syscall 接入、调用身份与契约检查、准入封锁与限流的执行、按运行路由 | 入口、请求关联与封锁标志的只读投影 |
| Core | 授权、Lease、系统控制、结果裁决与事件交付 | 权限依据、Lease、控制和接收决定、运行时长、Outbox |
| Scheduler | API 调用机会与调用目标安排 | 容量占用及调度关系 |
| Execution | 尝试创建、执行队列、步骤推进、产物发布和效果管理 | Attempt、执行队列、实际进度、产物及上下文状态 |
| Supervisor | 系统生命周期；Executor 子进程的派发、装配、截止时间、终止、回收与健康；上报执行事实 | 执行实例、Executor 子进程、宿主健康与模块生命周期 |
| Monitor | 额度、资源账本、限流判断与运行观测 | 预留、消费、结算及观测数据 |

Execution 与 Supervisor 的展开见 [Execution](../Kernel/Execution.md) 与 [Supervisor](../Kernel/Supervisor.md)。
每个组件只读写自己的私有状态，组件之间的数据与调用规则见第 3.4 节。

## 3. 通讯主体与运行组织

### 3.1 通讯主体

Kernel 对外是一个 Module，以 Gateway 为唯一入口；对内由 Kernel 核心、Supervisor 与 Gateway 三个通讯主体组成。

| 通讯主体 | 组成 | 主体内部 | 进程 |
|---|---|---|---|
| Kernel 核心 | Core、Monitor、Scheduler、Execution | 内部 syscall 与职责接口调用，以函数调用完成；按组件模块化隔离 | 同一进程 |
| Supervisor | Supervisor 及其管理的 Executor 子进程 | Supervisor 与 Executor 子进程之间经执行接口通信 | 独立进程；Executor 在子进程中运行 |
| Gateway | Gateway | — | 逻辑上独立；是否独立成进程由各 MVP 决定 |
| Workflow | Workflow Module | — | 独立通讯主体 |
| UserInteraction | UserInteraction Module 的各交互载体 | — | 独立通讯主体 |

通讯主体之间只交换可序列化的契约数据，不共享可变对象或内部句柄。
单进程部署时，Supervisor 与 Gateway 可以与 Kernel 核心同进程，但仍按可序列化接口协作。

Supervisor 直接管理操作系统进程，独立成进程使它与 Kernel 核心处于不同的故障域：
Kernel 核心失效时，Supervisor 仍可终止并回收 Executor 子进程、清理残余；
Supervisor 失效时，其 Executor 子进程随之退出，Kernel 核心经心跳发现后把在途尝试标记为效果未知。

Gateway 独立成进程的条件是：Kernel 核心按运行分片需要路由、系统对外开放给多用户，
或长连接需要与 Kernel 核心分开扩展。通信设施见 [Fabric](../Infrastructure/Fabric.md)。

### 3.2 运行 actor

每个 WorkflowRun 在任一时刻只有一个 Kernel 核心实例写入其状态。
Kernel 核心为每个运行维护一个运行 actor：该运行的 Inbox（运行 Inbox）、串行处理循环，以及该运行在 Core、Execution、Monitor、Scheduler 中的状态分块
（Lease、账本、尝试、队列、runEpoch 与 Outbox 都在其中）。运行 actor 是并发模型，不是第七个组件。

- **创建与回收**：Core 的运行管理是 Kernel 核心中唯一跨运行的部分，只保存 `workflowRunId → actor` 的映射与生命周期，不保存运行状态。
  只有创建运行的请求能建立 actor；actor 处理的第一条消息完成初始化（开始计时、经 Outbox 通知 Workflow）。actor 结束后，
  运行管理在其 Outbox 投递完毕后回收它，并保留记录结束原因的墓碑，用于拒绝或记录迟到的消息。
- **消息**：Workflow、UserInteraction 的请求，Supervisor 上报的执行事实，以及 Kernel 核心内部的定时器到点，都作为消息进入运行 Inbox。
  运行 Inbox 与外部 Module 的 Inbox 是同一种接收队列，只是按消息类型分为控制通道与工作通道：取消、授权回答、运行超时、收敛兜底到点、Supervisor 上报的终止或违规属于控制通道，
  优先处理；业务请求与正常的执行结果属于工作通道。同一来源在同一通道内保持顺序。
  执行事实交给 Execution 处理，其余消息交给 Core 处理。
- **不可重入**：一条消息处理完之前不开始处理下一条，控制通道的优先只在两条消息之间生效。处理中可以等待本地存储 I/O；
  对其他通讯主体的调用（执行派发、取消、事件投递）只登记为待发送，处理结束后由 actor 之外的发送器按目标逐个、按登记顺序发出，
  执行事实与用户回答作为新消息返回。同步的内部 syscall 中不回调其他组件、不等待 I/O，需要的后续步骤在同一次处理的末尾完成。
- **原子提交**：运行状态按组件分块（见第 3.4 节），一次消息处理中各组件的变化一起持久化，再经 Outbox 对外发出事件；
  不持久化运行状态的 MVP 省略持久化步骤，但发送顺序不变。

运行控制状态为 RUNNING → CONVERGING → CLOSED，只能前进。正常结束、取消、超时、违规与 Kernel 异常共用同一收敛过程：
进入 CONVERGING 时封锁准入、runEpoch 前进并取消在途执行；等待在途执行的终态事实（Supervisor 在宽限期内给出，
Core 另设兜底时限）；最后完成结算、计算未知效果、发出运行结束事件并进入 CLOSED。结束原因以先进入收敛者为准，安全违规例外，
可以在收敛中升级结束原因。

按顺序处理消除了结果、取消与超时之间的竞态：先处理的消息决定结论，后到的消息按已有状态处理。
Supervisor 对每个执行实例只上报一个终态，执行实例层面的结论由它给出；运行层面的裁决只在 Core。

### 3.3 按运行分片

Kernel 核心可以部署为多个实例，按 WorkflowRun 分片：

- `workflowRunId` 经哈希映射到固定数量的逻辑分片，逻辑分片由 Kernel 核心实例通过 Persistence 中的分片租约领取；
- 每次状态写入携带分片 epoch，epoch 过期的写入被拒绝；分片转移时运行的 runEpoch 前进，旧尝试的结果只作为证据；
- Gateway 生成 `workflowRunId` 并按分片路由，被旧 Owner 拒绝时刷新路由后重试，`requestId` 保证重试幂等；
- 执行事实按 `workflowRunId` 送回所属的 Kernel 核心实例；
- 跨运行的资源（如 Provider 级 API 容量）由全局容量服务以带期限的令牌分配。

单个运行不跨实例拆分。超大运行可拆为子运行，额度通过显式委派划给子运行。

### 3.4 Kernel 核心内部的模块化隔离

Kernel 核心是模块化单体：Core、Monitor、Scheduler、Execution 同进程、同通讯主体，
但各自的数据按模块隔离。同处一个进程不开放跨组件访问，Execution、Monitor、Scheduler 不能直接读写 Core 的信息。

| 组件 | 私有数据（只有它读写） | 对其他组件提供的内容 |
|---|---|---|
| Core | Lease、用户授权记录、AgentRun 登记、运行控制状态（runEpoch、准入封锁）、运行时长、Outbox | 裁决结果与原因码、由 Lease 派生的范围约束、当前 runEpoch 的只读值、推送给 Gateway 的封锁投影 |
| Execution | UnitAttempt、执行队列、产物归属索引、上下文构建记录 | 建立尝试、封装结果、按归属解析产物引用 |
| Monitor | 账本（已用、未知、在途预留）、预留记录 | 预留与结算结果、额度状态 |
| Scheduler | 调用容量与占用 | 申请与归还调用机会的结果 |

| 调用方 → 被调用方 | 规则 |
|---|---|
| Gateway → Core | 移交外部 syscall |
| Core → Monitor、Scheduler、Execution | 职责接口调用 |
| 运行 actor → Execution | 分派执行事实；运行 actor 只编排顺序，不读写组件数据 |
| Execution → Core | 内部 syscall：申请预留、提交结果检查（含违规）、申请技术重试 |
| Monitor、Scheduler → Core | 只在被 Core 调用时运行，只通过返回值给出结果或异常，不主动修改 Core 的状态 |
| Execution → Monitor、Scheduler | 不允许；额度与调用机会一律经 Core |
| Monitor ↔ Scheduler，Monitor、Scheduler → Execution | 不允许 |
| 任何组件 → 其他组件的私有状态 | 不允许 |

组件之间只传递派生值与只读结果，不传递内部实体。例如 Execution 需要仓库范围时，取得的是 Core 由 Lease
派生的范围约束，而不是 Lease。运行 actor 只负责编排处理顺序，把每个组件的状态分块交给对应组件，不打通访问。

## 4. Gateway 与 syscall

Gateway 是外部主体请求受保护 Kernel 操作的统一入口，识别来源和目标并分派服务。
它不持有 Lease、额度数值或运行状态，也不根据租约副本独立裁决。

| 请求关系 | 定义 |
|---|---|
| 外部 syscall | 外部 Module（UserInteraction、Workflow）经 Gateway 向 Core 请求 Kernel 服务 |
| 内部 syscall | Kernel 核心其他组件向 Core 发起的请求：申请资源预留、提交结果检查（含违规）、申请技术重试 |
| 职责接口调用 | Core 在处理请求时调用其他组件的职责接口，例如调用 Monitor 结算、调用 Scheduler 分配调用机会；不属于 syscall，也不构成 Core 对自身的递归请求 |

Gateway 检查调用来源、请求契约与准入封锁。准入被拒时，由 Gateway 直接向调用方返回拒绝结果；
准入通过的请求移交 Core 的统一控制响应逻辑。准入封锁由 Core 设置并推送给 Gateway，
Gateway 只读；Core 对封锁状态保留最终检查，复核不通过时返回同样的拒绝结果。

受理、处理与完成必须区分，等待超时不证明操作未发生。
事实报告不等于控制请求。Supervisor 上报的执行事实（含用量与违规）作为消息进入所属运行 actor，由 Execution 与 Core 处理；
Monitor 只在被 Core 调用时运行，不接收任何组件的直接上报。限流判断由 Monitor 在被 Core 调用时给出，
Core 把结论随准入投影推送给 Gateway，由 Gateway 在入口执行。
Fabric 归 Core 管辖，不意味着全部数据必须经过 Core 中转。

调用方身份由可信运行边界给出：每个通讯主体的通信客户端由组合根创建并固定身份，外部 Module 只持有各自那一组请求的端口，
Gateway 依据该身份拒绝越权请求，不接受请求中自报的身份。

## 5. 受保护能力、开发者权限与 Lease

是否需要 Lease，以 Unit 定义中声明的受保护能力为准。声明了受保护能力的 Unit 必须经 Core
进行 Lease 审核；未声明的 Unit 依据可信开发者定义的权限执行，这不是调用者可以选择的默认放行。
两类 Unit 都必须通过准入检查，并受数据、资源和工作范围限制。
面向模型的 Tool 描述只说明模型可以请求什么动作，本身不决定授权。

Workflow 检查动作及模板组合是否合法，Core 判断权限。
模型或 Workflow 不能移除受保护能力声明、替换行为或扩大参数范围来绕过授权。

Core 保留用户的授权决定。后续申请若属于已同意范围的安全子集，可以直接签发 Lease；
危险行为每次都必须单独征得用户同意。同一授权在等待用户回答期间，后续同类申请等待同一结果，
不重复询问。拒绝或超时不视为同意，并在本次运行内保留。

Lease 表示 Core 管理的使用资格，受主体、行为和工作条件约束。
Core 负责签发、变更、失效与撤销；长期资格也不是不可撤销或跨范围通用的权限。

Lease 内容唯一存在于 Core。外部 Module 和其他 Kernel 组件不得保存、直接读取或修改
Lease 实体、快照或缓存。权限检查由 syscall 触发，Core 按当前事实返回裁决。
裁决及执行关联不等于 Lease，不能重建第二套租约权威。
Persistence 可以保存 Core 私有状态，但不向其他组件开放 Lease 数据访问。

## 6. 执行闭环

```text
Workflow → Gateway 准入（被拒：Gateway 返回异常）
  → Core 定义核验与权限检查（被拒：Core 交付拒绝结果）
  → Execution 建立尝试，进入执行队列
  → 需要资源时：Execution 经内部 syscall 申请，Core 调用 Scheduler 分配机会、调用 Monitor 预留（二者同时取得或都不持有）
  → Execution 提交执行请求，Supervisor 在 Executor 子进程中执行，交回执行事实
  → Execution 封装结果并经内部 syscall 提交结果检查，Core 核对结果并调用 Monitor 结算
  → Core 核对运行控制状态版本，经 Outbox 交付结果，Workflow 验收
```

技术重试同样经内部 syscall 由 Core 同意，旧的预留与调用机会先结算、释放再重新申请。
除请求被拒外，Unit 的结果统一由 Core 交付。尝试建立时记录运行控制状态的版本（runEpoch），
Core 交付前核对版本，核对与入队在同一次处理中完成；运行已被取消、结束或停止时不再交付，结果只作为证据保存。

缺少权限时可以拒绝或等待。Core 依据敏感程度与策略发起人工审批，
UserInteraction 的原始响应不直接成为授权。

执行前、推进中与结果接收时的检查共同保证操作仍适用。
曾经获准不保证被取消或替代的执行仍可提交结果。
执行已完成但结果被拒绝时，效果和费用必须保留。

## 7. 事件交付

Kernel 向 Workflow 与 UserInteraction 发出的事件（运行开始、Unit 结果、授权询问、运行结束等）
统一由 Core 的 Outbox 发出，投递到接收方提供的 Inbox。Kernel 只依赖公共契约中的 Inbox 接口，
不依赖外部 Module 的实现。Outbox 与 Inbox 是否持久化由各 MVP 决定，投递语义不变，见 [Protocol](../Protocol.md) 第 6 节。

## 8. 调度与执行协作

执行队列归 Execution，由 Execution 判断固定行为序列的步骤依赖与推进顺序。
Scheduler 只负责 API 等受限资源的调用机会与调用目标，不改变执行队列的顺序。
两者都不替代 Workflow 的业务任务图。
API 池归 Scheduler，Monitor 提供额度与消耗，实际模型和服务调用在 Supervisor 管理的 Executor 子进程中发起。
未就绪步骤不应长期占据机会，权限有效不等于资源可用。

Kernel 核心按顺序处理同一运行的消息，Executor 子进程中的执行可以并行。并行执行时，
执行队列按 AgentRun 划分并设运行级并发上限，只在同一 AgentRun 内保证顺序。

内部组织简化交接，但不自动消除部分失败、未知效果与资源泄漏。
必须能区分未开始、执行中、已完成及无法确认的情况，并保留新旧尝试关系。

## 9. Monitor

Monitor 维护额度、预留、实际消费、释放和待核对消耗。
Workflow 管业务预算的分配与步数，不成为实际资源用量的第二事实源。

额度检查计入全部在途预留。额度状态只能前进：NORMAL → WRAP_UP → EXHAUSTED。
WRAP_UP 提示业务层收尾，不拒绝请求；Monitor 为收尾调用保留额度，普通消耗不能使用这部分额度。
达到硬阈值时 Monitor 拒绝新的消耗型预留，不停止运行：已经发生的消耗照常结算，结果照常交付，
业务层以已有材料收尾。运行的强制停止只来自超时、取消与安全违规。
并行 AgentRun 使用子额度，每份子额度各自保留收尾额度。

账本依据可核对事实维护，负载、延迟等观测可以采用相应采集策略。
失败或取消不等于零消耗，重复事实不能重复结算。
Monitor 被 Core 调用时可以以返回值报告异常，由 Core 决定控制处置；Monitor 不修改 Workflow 状态；
反馈调节不能突破权限和硬资源上限。

## 10. Supervisor 与基础设施

Supervisor 是独立的通讯主体，直接管理进程：负责系统生命周期，以及 Executor 子进程的派发、装配、
截止时间、终止、回收与健康，向 Kernel 核心上报执行事实。它不维护执行队列，不作授权、额度或结果接受的裁决。
详见 [Supervisor](../Kernel/Supervisor.md)。运行总时长由 Core 计时，超时由 Core 按异常处理。

产物发布等 Kernel 内建 Unit 由 Execution 直接完成，不派发给 Supervisor，也不经 Executor。

ModuleHost 归 Supervisor 管辖，负责装配、就绪与正常关闭。
ArtifactStore 归 Execution，Fabric 归 Core；管辖指设施的使用方式与语义，
各设施的启动与关闭由 ModuleHost 统一执行。管辖设施不等于拥有其保存的全部领域数据。

不可信 Executor 在受限的子进程中运行，不能修改可信执行管理状态或取得内核权限。

## 11. 调用、中断与异常

调用（syscall）是主体主动向 Core 请求服务；中断（Interruption）是 Kernel 要求在途执行停止或响应控制变化，
经 Supervisor 作用于执行载体；异常（Exception）表示无法正常继续。
一次调用可以产生中断，中断失败可以产生异常；因果关联不等于消息送达即已生效。
Kernel 向外部 Module 交付的结果与事实通知是事件（Event），接收方据此更新自己的状态，不属于中断。

Core 组织控制职责，Scheduler 阻止新机会，Execution 响应安全点，
Supervisor 监管停止与清理，Monitor 核对资源。
故障事实交给 Workflow 决定业务重试、重规划、补偿或结束。
可重试的错误不自动授权再次执行。

## 12. panic 与安全停机

panic 用于可信基础或关键安全不变量失守。
Core 之外直接访问 Lease 实体，或外部主体绕过受保护入口执行内核操作，必须拒绝并进入
panic 处置。合法权限检查、受控事实传递和普通权限不足不属于此类绕行。

越权须由可信边界确认，不能仅凭 Executor 自报消息触发全局停机。
安全停机停止新准入和调度，尽力收敛执行并保存必要事实。
Kernel 自身失效时不能依赖其必然发出最后通知，未知效果与清理失败必须明确表达。

## 13. 恢复、收敛与视图

Workflow 组织业务恢复，Kernel 核对执行、效果、资源与当前权限。
历史快照不能复活 Lease 或执行会话，未知效果先核对。

最终完成前，Kernel 收敛本次范围的在途步骤、资源与执行资格，向 Workflow 提供确认事实。
其他范围有效的授权不应单独阻止当前工作完成。

Kernel 汇集各 Owner 的版本化事实形成受控视图，不产生第二个写入权威。
暂态输出、确认结果和业务验收分开，敏感正文使用受控产物。
