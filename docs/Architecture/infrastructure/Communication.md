# MultiAgentOS Communication Fabric

## 1. 职责

Communication Fabric 传递 Command、Query、Event、Signal 和 Result，提供路由、序列化、认证集成、至少一次投递、去重、重试、消费水位和死信处理。它不解释领域语义，也不形成第二套任务状态机。

## 2. 消息类型

| 类型 | 语义 | 响应 |
|---|---|---|
| Command | 请求 Owner 改变状态 | 接受、拒绝或幂等原结果 |
| Query | 读取 Owner 的版本化视图 | 带 sourceVersion 的结果 |
| Event | 已提交且不可变的事实 | 消费确认，不返回业务结果 |
| Signal | 定向唤醒持久等待 | 接受、重复或目标不存在 |
| Result | 异步操作的规范化完成事实 | 由 correlation 关联请求 |

同步进程内 Port 可省略传输 Envelope，但必须使用相同 payload Schema 和 BoundaryContext。异步、持久或跨进程边界必须使用完整 Envelope。

## 3. 投递语义

- 默认至少一次投递，不承诺任意副作用 exactly-once。
- Producer 通过事务 Outbox 发布；Consumer 通过 Inbox 去重。
- 重试只处理传输失败，不替业务 Owner 决定业务 retry。
- 顺序只在显式 partition/aggregate key 内保证；消费者必须处理乱序和迟到。
- 超过重试策略进入 DLQ，并保留原 Envelope、错误、尝试次数和时间。
- 消息过期、旧 graphRevision 或旧 fencing 由消费者拒绝，不由 broker 猜测。

## 4. 路由与版本

路由键至少包含 schemaName、major、messageType 和目标 Owner。Transport Adapter 不得改写 payload 或把未知版本降级为已知版本。跨 transport 切换必须保持 messageId、correlationId、causationId 和 occurredAt。

## 5. Signal 与持久等待

Signal 必须包含稳定 correlation、目标运行/等待对象、有效期和幂等身份。等待方先持久化等待点再发布外部请求，避免响应先到达而丢失。恢复后使用相同 correlation 继续等待；不得生成第二个逻辑请求。

## 6. 背压与故障

Fabric 暴露 backlog、consumer lag、redelivery、DLQ 和 handler 时长。背压只能限流或暂停接收，不得静默丢弃领域消息。网络分区恢复后重复和乱序属于正常输入。Handler 崩溃时消息不确认；毒消息进入隔离流程，不无限热循环。

## 7. 安全与测试

连接身份映射到 producer/consumer 权限；tenant/project 不得仅依赖客户端字段。传输加密、消息大小、压缩炸弹和反序列化限制必须配置。测试覆盖重复、乱序、迟到、ack 丢失、handler 崩溃、网络分区、版本未知、DLQ、背压和 transport 替换。
