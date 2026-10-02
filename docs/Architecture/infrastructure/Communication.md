# MultiAgentOS Communication Fabric

## 1. 职责

Communication Fabric 由 Kernel 管辖，保留独立的基础设施 Port 和各进程的通信端点。它传递 Command、Query、Event、Signal 和 Result，提供路由、序列化、认证集成、至少一次投递、去重、重试、消费水位和死信处理。它不解释领域语义，也不形成第二套任务状态机。

Gateway 负责请求资格，Core 控制分派器负责调用、中断和异常的处理语义。
Fabric 不代替鉴权或控制状态机，也不要求所有数据流经过 Core。
具体 Ubuntu LTS IPC 端点、身份绑定和传输选择由交付设计明确。

## 2. 消息类型

| 类型 | 语义 | 响应 |
|---|---|---|
| Command | 请求 Owner 改变状态 | 接受、拒绝或幂等原结果 |
| Query | 读取 Owner 的版本化视图 | 带 sourceVersion 的结果 |
| Event | 已提交且不可变的事实 | 消费确认，不返回业务结果 |
| Signal | 传递中断或定向唤醒持久等待 | 投递/接受、重复或目标不存在；实际生效另行确认 |
| Result | 异步操作结果或待确认执行结果 | 由 correlation 关联请求，不能越过 Owner 接收决定 |
| Stream | 暂态进度及输出片段 | 按订阅与背压契约处理，不表示已确认终态 |

同步进程内 Port 可省略传输 Envelope，但必须使用相同 payload Schema 和 BoundaryContext。异步、持久或跨进程边界必须使用完整 Envelope。

## 3. 投递语义

- 默认至少一次投递，不承诺任意副作用 exactly-once。
- Producer 通过事务 Outbox 发布；Consumer 通过 Inbox 去重。
- 重试只处理传输失败，不替业务 Owner 决定业务 retry。
- 顺序只在显式 partition/aggregate key 内保证；消费者必须处理乱序和迟到。
- 超过重试策略进入 DLQ，并保留原 Envelope、错误、尝试次数和时间。
- 消息过期、旧 graphRevision 或旧 fencing 由消费者拒绝，不由 broker 猜测。

上述耐久交付基线适用于要求不丢失的命令与事实。暂态流可以按显式契约限量、断开或补读，
但不能把其可丢失策略用于权威结果。是否使用持久 broker 由 MVP 范围决定，语义不得暗中降级。

## 4. 路由与版本

路由键至少包含 schemaName、major、messageType 和目标 Owner。Transport Adapter 不得改写 payload 或把未知版本降级为已知版本。跨 transport 切换必须保持 messageId、correlationId、causationId 和 occurredAt。

## 5. Signal 与持久等待

Signal 必须包含稳定 correlation、目标运行/等待对象、有效期和幂等身份。等待方先持久化等待点再发布外部请求，避免响应先到达而丢失。恢复后使用相同 correlation 继续等待；不得生成第二个逻辑请求。

## 6. 背压与故障

Fabric 暴露 backlog、consumer lag、redelivery、DLQ 和 handler 时长。背压只能限流或暂停接收，不得静默丢弃领域消息。网络分区恢复后重复和乱序属于正常输入。Handler 崩溃时消息不确认；毒消息进入隔离流程，不无限热循环。

中断与故障通道必须保留有界处理能力，不能被普通任务或大输出无限阻塞，也不能无限免限流。
Signal 投递成功不证明暂停、取消或物理终止已经完成，回执和实际事实由控制处理者提供。

## 7. 安全与测试

连接身份映射到 producer/consumer 权限；tenant/project 不得仅依赖客户端字段。传输加密、消息大小、压缩炸弹和反序列化限制必须配置。测试覆盖重复、乱序、迟到、ack 丢失、handler 崩溃、网络分区、版本未知、DLQ、背压和 transport 替换。

订阅者需绑定身份和运行范围。长期读取租约可以由受控端点检查，不逐消息进入 Core；租约缓存与撤销传播的失效行为必须明确，不能仅凭连接存在持续放行。
