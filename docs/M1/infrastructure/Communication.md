# MultiAgentOS M1 Communication（Fabric）

## 1. 定位

Fabric 提供通信、路由与事实交接，Core 承担管理职责，但不因此中转全部消息。
长期规划见 [Fabric 架构](../../Architecture/infrastructure/Communication.md)。

## 2. 通讯主体与调用形式

M1 全系统运行在一个操作系统进程中，按通讯主体划分调用形式：

| 通讯主体 | 组成 | 主体内部 | 与其他主体之间 |
|---|---|---|---|
| Kernel 核心主体 | Core、Monitor、Scheduler、Execution | 直接函数调用 | 进程内可序列化消息 |
| Gateway | Gateway | — | 进程内可序列化消息 |
| Supervisor | Supervisor（及其监管的 Executor 执行实例） | — | 进程内可序列化消息 |
| 外部 Module | UserInteraction、Workflow | — | 进程内可序列化消息，经 Gateway 进入 Kernel |

进程内消息使用现有 MessageRouter 承载（M1 实现选择见 [M1TechStack](../M1TechStack.md) §10），
保持逻辑上独立的通讯边界，后续可直接替换为跨进程通信。
所有调用都必须遵守以下约束：

- 使用明确、可序列化的数据契约，并在主体边界执行运行时校验。
- 明确异步调用、请求关联、结构化错误、超时及接受与完成的区别。
- 协作不依赖共享可变对象、裸内部句柄或同步回调链。
- 大对象通过受控 Artifact 引用传递，必要的小型结构化结果可以直接交付。

syscall 的分类见 [kernel/Interaction](../kernel/Interaction.md) 第 3 节。

## 3. 边界

M1 不实现跨进程 IPC、多进程部署或分布式可靠投递。通信在系统关闭时最后关闭
（见 [ModuleHost](ModuleHost.md)）。
