# MultiAgentOS Persistence Platform

## 1. 职责

Persistence Platform 为各 Module 提供隔离的 Repository、事务、Migration、Journal、Outbox/Inbox、投影重建、备份和恢复原语。它只拥有提交、迁移、投递水位和备份事实，不决定领域状态。

## 2. 数据所有权

- 每个 Module 拥有独立 Schema 和数据库角色，只能写入自身领域表。
- 跨模块读取使用 Query、Event 或只读投影，不得 Join 对方内部表形成隐藏耦合。
- durable runtime 的内部表由 runtime 管理；领域代码不得直接查询或删除。
- 投影、索引、缓存和遥测是可重建派生数据，不得反向覆盖事实源。

### 2.1 运行时状态

| Owner | 状态 |
|---|---|
| Workflow | 业务图、AgentRun、UnitIntent、业务 checkpoint 和恢复操作 |
| Core | 授权、Lease 权威记录、控制操作、结果接收决定 |
| Scheduler | 队列、派发、调度代次和资源分配关联 |
| Monitor | 配额、预留、结算及未知消耗 |
| Supervisor | 监管关系与进程事实 |
| Execution | UnitAttempt、Executor 步骤实例、进度和执行观测 |

这组分属 Owner 的数据构成运行时状态，不提供任意模块可写的全局“AgentOS 内存”。
实际执行完成、结果被接受与业务验收分别保存，不能共同写入一个含义不明的终态。
审计由各 Owner 记录并关联，公共查询窗口不产生新的写入权威。
不可信 Executor 不能直接修改可信 Execution 管理状态。

## 3. 事务模板

需要持久一致性的领域状态变化必须在同一本地事务中完成：

```text
校验 expectedVersion / Inbox
-> 执行纯 Reducer
-> 写聚合新版本
-> 追加 Event Journal
-> 写 Outbox
-> 更新本模块投影
-> 提交
```

提交失败不得发布 Event。Outbox 发布成功但 ack 丢失时允许重复投递，由消费者 Inbox 去重。不得用跨模块分布式事务替代明确的 Saga。

不同 MVP 可以明确选择内存或文件 Adapter 的受限能力，但不能将无事务的多个写入宣称为上述原子提交。
各 Owner 之间仍需幂等交接；Attempt 已创建未调度、预算已预留未启动、
执行已发生而回执缺失，都需要独立核对，不能假定跨模块全局事务。

## 4. Repository 与并发

Repository Port 暴露领域对象，不暴露任意 SQL。聚合使用 optimistic concurrency；expectedVersion 不匹配返回 `VERSION_CONFLICT`，调用方刷新后重新计算，不得 last-write-wins。Command 幂等表以 tenant、command 和 idempotencyKey 唯一；同键不同请求 hash 返回 `IDEMPOTENCY_KEY_REUSED`。

## 5. Journal、Outbox 与 Inbox

- Journal 是领域事实的追加记录，包含 aggregate、version、eventSequence、correlation 和 causation。
- Outbox 与领域事务共同提交，由 dispatcher 至少一次发送。
- Inbox 以 messageId/consumer 唯一，重复消息返回原处理结果。
- consumer offset 是投递进度，不是业务完成状态。
- 保留与压缩策略不得删除仍用于恢复、审计或投影重建的事实。

## 6. Checkpoint 持久化

Persistence 保存 Workflow 生成的 WorkflowCheckpoint、SessionCheckpoint manifest、RestoreOperation 和 retention token 状态，但不决定何时创建、是否可恢复或如何恢复。

SessionCheckpoint 创建采用可恢复 Saga：候选记录 → participant prepare → 本地提交 manifest/outbox → participant commit → 标记 AVAILABLE。required participant 未激活时不得发布 AVAILABLE。崩溃后依据 operationId 查询并继续 commit 或 abort，不创建第二个逻辑保存点。

## 7. Migration

Migration 必须版本化、可审查并在部署前验证。一次只允许一套权威 Schema/Migration 工具。破坏性迁移采用 expand/migrate/contract，先兼容旧代码和运行实例，再删除旧字段。Migration 不得隐式重写不可变事件或 Artifact hash。

## 8. 备份与灾难恢复

备份必须覆盖数据库、Artifact metadata、Schema/Migration 版本和加密配置，并与 Artifact 对象做一致性校验。恢复演练验证 RPO/RTO、PITR、投影重建、Outbox 重放和孤儿 Artifact 处理。数据库恢复不自动恢复有效 Lease、Grant、Secret 或 Executor 会话。持久授权依据由 Core 重验，永久租约也不从旧快照直接复活。Execution 核对效果，Monitor 核对消耗，Supervisor 处理旧执行域。

## 9. 安全与测试

数据库角色按 Module 和 migration 职责分离；tenant/project 过滤在 Repository 和数据库策略两层执行。测试覆盖事务注入崩溃、并发版本冲突、重复 Command、Outbox ack 丢失、Inbox 去重、Migration 回滚、越权 SQL、备份恢复和 checkpoint Saga 各提交点。
