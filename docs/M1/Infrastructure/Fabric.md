# MultiAgentOS M1 Fabric

## 1. 定位

Fabric 提供通讯主体之间的通信、路由与交接，Core 承担管理职责，但不因此中转全部消息。
Core 的管辖指通信的使用方式与语义；Fabric 的启动与停止由 Supervisor 驱动 ModuleHost 执行。
长期规划见 [Fabric 架构](../../Architecture/Infrastructure/Fabric.md)，Port 与路由表见 [M1Interface](../M1Interface.md) 第 2、10 节。

## 2. 通讯主体与调用形式

M1 全系统运行在一个操作系统进程中，通讯主体与长期架构一致：

| 通讯主体        | producer           | 组成                                | 与其他主体之间                                  | M1 实现                                                        |
| --------------- | ------------------ | ----------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Kernel 核心     | `kernel-core`      | Core、Monitor、Scheduler、Execution | Fabric                                          | 单个实例，不分片                                               |
| Supervisor      | `supervisor`       | Supervisor 及其管理的 Executor      | Fabric（`SupervisorPort`、`ExecutionFactSink`） | 与 Kernel 核心同进程；Executor 在进程内运行，`rg` 以子进程运行 |
| Gateway         | `gateway`          | Gateway                             | Fabric                                          | 逻辑独立，与 Kernel 核心同进程                                 |
| Workflow        | `workflow`         | Workflow Module                     | 经 Gateway 发起 syscall，经 Inbox 接收事件      | 同进程                                                         |
| UserInteraction | `user-interaction` | UserInteraction Module 与 CLI       | 经 Gateway 发起请求，经 Inbox 接收事件          | 同进程                                                         |

Kernel 核心内部（Core、Monitor、Scheduler、Execution）以函数调用协作，不经 Fabric。

## 3. 实现

M1 的 Fabric 是同进程实现 `InProcessFabric`，为每个通讯主体创建一个 `FabricPort` 客户端：

- 客户端固定写入 `Envelope.producer`、`messageId` 与 `occurredAt`，主体代码不能修改；Gateway 以 producer 判定调用方。
- 每次调用先校验 `BoundaryContext`；上下文错误属于传输契约错误，不能转成 Gateway 的 `INVALID_REQUEST`。
- 每次投递先按 `schemaName` 的 Schema 校验 payload，再以 `structuredClone` 复制，使误传对象引用、函数或类实例在 M1 即可被发现。
  Gateway 的九种 syscall 路由允许 Gateway 注册无效正文处理器：只在 `requestId` 仍合法时调用，
  由 Gateway 返回结构化 `INVALID_REQUEST`；其他路由与非法 requestId 仍直接报告传输契约错误。
- `request`：调用方等待处理方返回；超时不证明操作未发生。M1 不设 Fabric 级超时，由各请求的业务时限兜底。
- `send` / `subscribe`：单向消息；`send` 返回表示已进入接收方队列。同一地址的并发投递按调用登记顺序串行受理，
  一次投递失败不阻断后续投递；不同地址可并行。
- 组合根基于各主体的客户端生成 Port 存根：`WorkflowGatewayPort`、`InteractionGatewayPort`、`SupervisorPort`、
  `ExecutionFactSink`、`WorkflowInboxPort`、`InteractionInboxPort`，路由见 M1Interface 2.2。

所有调用都遵守：使用可序列化的数据契约并在边界校验；区分请求受理与完成；不依赖共享可变对象、裸内部句柄或同步回调链；
大对象通过 ArtifactRef 传递，例外只有执行请求与执行事实、`report-publish` 的报告正文与 `readArtifact` 的响应（M1Interface 7.2）。

## 4. Outbox 与 Inbox

M1 实现内存版 Outbox 与 Inbox，不持久化，进程退出时一起丢失：

- Outbox 位于运行 actor 的 Core 状态分块中；每个接收方一个发送器，按 `seq` 依次调用 `send`，前一个返回后才发下一个。
  发往 Supervisor 与 Gateway 的待发送消息同样各用一个发送器按登记顺序发出（Kernel/Interaction 4.4）。
- Inbox 位于接收方：`deliver` 只做 Schema 校验与入队；按 `eventId` 去重；单个消费者逐条处理，不因 `seq` 缺口等待。
- Fabric 包提供两份通用实现供各主体复用，不要求各自重写：Inbox（通道数与去重键可配置，Workflow、UserInteraction
  使用单通道并按 `eventId` 去重，Kernel 核心的运行 Inbox 使用控制与工作两个通道且不去重）与有序发送器
  （按登记顺序逐条发出，Core 对 Workflow、UserInteraction、Supervisor、Gateway 各用一个）。
- Inbox 的请求若命中去重键立即拒绝，不能留下永不完成的等待；未知通道不消耗去重键。处理器或失败观察者抛错时，
  队列继续排空，未被观察的错误由 `idle()` 报告。有序发送器的失败观察者抛错时同样继续发送，由 `flushed()` 报告。
- 投递语义见 [Kernel（外部视角）](../Module/Kernel.md) 4.5。

## 5. 边界

M1 不实现跨进程 IPC、多进程部署或持久化的可靠投递。Fabric 在各模块中最先启动、最后停止（[ModuleHost](ModuleHost.md) 第 2 节）。
