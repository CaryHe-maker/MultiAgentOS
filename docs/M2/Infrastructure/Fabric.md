# MultiAgentOS M2 Fabric

> 状态：草稿（阶段 1）。

## 1. 定位

Fabric 提供通讯主体之间的通信、路由与交接，Core 承担管理职责（[Fabric 架构](../../Architecture/Infrastructure/Fabric.md)）。
Port、路由表与事件信封见 [Interface](../Interface/README.md) 第 4 节。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| Kernel 核心的接收队列按运行划分（运行 Inbox） | 按 Session 划分（Session Inbox），由 Session actor 处理 | M2Design 第 2.6 节 |
| 发给 Workflow、UserInteraction 的事件只有一个序列（每个运行） | 两个序列：运行级事件按运行编号，Session 级事件按 Session 编号 | Interface 第 4 节 |
| 路由只含 M1 的九种 syscall | 增加 M2 的 syscall 与 Session 级事件（Interface 第 4 节的路由表） | — |

通讯主体、`InProcessFabric` 的实现方式、请求期限、`send` 与 `subscribe` 的语义、有序发送器与通用 Inbox 都与 M1 相同，
见归档的 [M1 Fabric](../../History/M1/Infrastructure/Fabric.md) 第 2–4 节。

## 3. Outbox 与 Inbox

- **Outbox**：位于 Session actor 的 Core 状态分块中。运行级事件放在当前运行的 Outbox，Session 级事件放在 Session 级 Outbox；
  每个接收方仍只有一个有序发送器，两个 Outbox 的事件按登记顺序交给同一个发送器，因此对同一接收方的投递顺序与登记顺序一致。
- **Inbox**：Workflow 与 UserInteraction 的 Inbox 仍为单通道，按 `eventId` 去重；它们按事件类型区分两个序列，各自检查 `seq` 是否连续。
  Kernel 核心的 Session Inbox 使用控制与工作两个通道，不去重（与 M1 的运行 Inbox 相同）；控制通道增加暂停与中止（阶段 5）。
- 两个序列之间的先后由同一个发送器保证：例如 `SessionOpened` 一定在该 Session 第一个运行的 `RunStart` 之前到达。

## 4. 不变量与测试

| 要求 | 测试 |
|---|---|
| 同一接收方的事件按登记顺序投递 | 单元测试：交错登记运行级与 Session 级事件，接收顺序与登记顺序一致 |
| 每个序列的 `seq` 连续 | 契约测试：fake Kernel 的输出满足两个序列各自连续 |

## 5. 阶段

全部内容属于阶段 1；阶段 5 在 Session Inbox 的控制通道中增加暂停与中止。
