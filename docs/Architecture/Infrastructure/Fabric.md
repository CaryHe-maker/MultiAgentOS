# Fabric 通信基础设施

## 1. 定位与管辖

Fabric 由 Kernel.Core 管辖，提供通信、路由和交接能力。
它不决定业务推进、授权、结果接受或资源结算。
Core 管辖通信设施不意味着所有事实都必须经过 Core 处理。
管辖指通信的使用方式与语义，Fabric 的启动与关闭由 ModuleHost 在 Supervisor 协调下执行。

通信契约独立于部署方式；同进程协作与跨进程协作保持可识别的请求、结果和失败语义。
Module 与组件边界不直接等同于进程边界。

## 2. 通讯主体

| 通讯主体 | 组成 | 进程 |
|---|---|---|
| Kernel 核心 | Core、Monitor、Scheduler、Execution（模块化单体） | 同一进程；可按 WorkflowRun 分片为多个实例 |
| Supervisor | Supervisor 及其管理的 Executor 子进程 | 独立进程；按节点部署 |
| Gateway | Gateway | 逻辑上独立；是否独立成进程由各 MVP 决定 |
| Workflow | Workflow Module | 独立通讯主体 |
| UserInteraction | UserInteraction Module 的各交互载体 | 独立通讯主体 |

按运行分片后，跨运行的资源分配可以由全局容量服务承担。
Persistence、ArtifactStore 等基础设施提供存储机制，不作为通讯主体。

通讯主体内部可以直接函数调用，但 Kernel 核心内的组件仍按模块隔离，只经职责接口与内部 syscall 交互
（见 [Kernel](../Module/Kernel.md) 3.4）。通讯主体之间只交换可序列化的契约数据，并在边界执行运行时校验，
不共享可变对象、内部句柄或同步回调链。同进程部署时也遵守这一约束，使通讯主体可以独立成进程而不改变语义。

## 3. 通信分类

| 通信 | 参与方 | 边界 |
|---|---|---|
| 外部系统调用 | Workflow、UserInteraction → Gateway → Kernel 核心 | 经 Gateway 检查后进入 Core；分片部署时由 Gateway 按 `workflowRunId` 路由 |
| Kernel 核心内部协作 | Core、Monitor、Scheduler、Execution | 内部 syscall 与职责接口调用，以函数调用完成，不经 Fabric；按组件模块化隔离 |
| 执行派发 | Kernel 核心 ↔ Supervisor | 执行请求、取消、执行事实与心跳；执行事实携带运行、尝试与执行实例标识，以运行控制状态版本防护；执行事实进入运行 actor 后由 Execution 处理，用量与违规经 Execution 的结果检查交给 Core |
| 执行载体 | Supervisor ↔ Executor 子进程 | 属于 Supervisor 内部，Executor 子进程不与其他主体通信 |
| 事件交付 | Core 的 Outbox → Workflow、UserInteraction 的 Inbox | 单向投递，有序、可去重，语义见 [Protocol](../Protocol.md) 第 6 节 |
| 产物访问 | 获准主体 → ArtifactStore 的受控访问边界 | 不以通信可达替代内容授权 |

事实通道不能成为执行、授权或控制操作的旁路。Monitor 只在被 Core 调用时运行，不作为任何通信的接收方。
路由成功不证明调用获准，设施不能自行赋予调用者新的身份和权限。调用方身份由组合根为每个通讯主体创建的通信客户端写入，
主体代码不能修改，接收方不采信请求中自报的身份。
Lease 内容不进入公共通信或观测通道，只由 Core 维护。

进入 Kernel 核心的消息按运行排队，控制类消息（取消、授权回答、运行超时、收敛兜底到点、Supervisor 上报的终止或违规）
优先于工作类消息处理，见 [Kernel](../Module/Kernel.md) 3.2。

## 4. 受理与交接

长操作采用可区分的受理与完成语义，不要求保持一次调用直到业务结束。
投递、受理、执行和结果接受分别有自己的事实，通信超时只能说明观测不足，
不能证明操作没有发生。

关键交接需要支持重复识别、迟到处理和状态核对。
通信重传不等于业务重试，Fabric 不应擅自启动新的业务尝试。
跨主体交接中断时，由相关 Owner 根据权威状态决定恢复行动。

## 5. 可靠性与流量

运行终态、权限变化、资源结算等关键事实不能按普通遥测丢弃。
进度、展示流和资源采样可以采用与其用途相符的聚合或降频，
但必须保留与正式事实的区别。

拥塞时应限制新工作和积压，并保障必要控制与结果交接的可达性。
不能让大量展示或观测流量阻塞中止、安全关闭和权威状态报告。

## 6. 生命周期与可观测性

Fabric 与 ModuleHost 配合完成就绪、排空和关闭。
关闭前处理必要交接，无法确认的交接保留为待核对状态。

通信观测用于发现延迟、积压、失败和断连，不反向覆盖领域事实。
追踪保留必要关联与信任边界，避免泄露凭据和敏感内容。
