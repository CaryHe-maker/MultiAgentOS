# MultiAgentOS M1 Communication（Fabric）

## 1. 定位

Fabric 提供通信、路由与事实交接，Core 承担管理职责，但不因此中转全部消息。
长期规划见 [Fabric 架构](../../Architecture/infrastructure/Communication.md)。

## 2. 通讯主体与调用形式

M1 全系统运行在一个操作系统进程中，通讯主体与长期架构一致（见 [Fabric 架构](../../Architecture/infrastructure/Communication.md) 第 2 节）：

| 通讯主体 | 组成 | 主体内部 | 与其他主体之间 | M1 实现 |
|---|---|---|---|---|
| Kernel 核心 | Core、Monitor、Scheduler、Execution | 内部 syscall 与职责接口调用，按组件模块化隔离 | 可序列化消息 | 单个实例，不分片 |
| Supervisor | Supervisor 及其管理的 Executor | — | Kernel 核心与 Supervisor 的接口（见 [Supervisor](../kernel/Supervisor.md) 第 3 节） | 与 Kernel 核心同进程；Executor 在进程内运行，`rg` 以子进程运行 |
| Gateway | Gateway | — | 可序列化消息 | 逻辑独立，与 Kernel 核心同进程 |
| Workflow | Workflow Module | — | 经 Gateway 发起 syscall，经 Inbox 接收事件 | 同进程 |
| UserInteraction | UserInteraction Module 与 CLI | — | 经 Gateway 发起请求，经 Inbox 接收事件 | 同进程 |

进程内消息使用现有 MessageRouter 承载（M1 实现选择见 [M1TechStack](../M1TechStack.md) §10），
保持逻辑上独立的通讯边界，后续可直接替换为跨进程通信。
所有调用都必须遵守以下约束：

- 使用明确、可序列化的数据契约，并在主体边界执行运行时校验。
- 明确异步调用、请求关联、结构化错误、超时及接受与完成的区别。
- 协作不依赖共享可变对象、裸内部句柄或同步回调链。
- 大对象通过受控 Artifact 引用传递，必要的小型结构化结果可以直接交付。
- MessageRouter 投递时复制 payload（`structuredClone`），使误传对象引用、函数或类实例在 M1 即可被发现。

MessageRouter 提供两种通信：

| 方式 | 用途 | 语义 |
|---|---|---|
| 请求-响应（`request`） | 外部 syscall、UserInteraction 请求、跨主体的 Kernel 内部请求 | 调用方等待受理结果；超时不证明操作未发生 |
| 单向消息（`send` / `subscribe`） | Core 的 Outbox 向 Workflow、UserInteraction 的 Inbox 投递事件 | 返回表示已进入接收方 Inbox；同一接收方按顺序投递 |

Kernel 核心与 Supervisor 之间的 `execute`、`cancel`、`fact` 同样只传可序列化数据，
进入 Kernel 核心的消息按运行排队，控制通道优先（见 [kernel/Interaction](../kernel/Interaction.md) 3.2）。

syscall 的分类见 [kernel/Interaction](../kernel/Interaction.md) 第 3 节，Inbox 投递语义见
[Kernel（外部视角）](../module/Kernel.md) 4.5。

## 3. 边界

M1 不实现跨进程 IPC、多进程部署或分布式可靠投递。通信在系统关闭时最后关闭
（见 [ModuleHost](ModuleHost.md)）。
