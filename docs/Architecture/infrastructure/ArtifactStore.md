# MultiAgentOS Artifact Store

## 1. 职责

Artifact Store 保存不可变大对象，提供内容寻址、完整性、引用、访问、保留和垃圾回收原语。它拥有对象字节、hash、存储可用性和 GC 执行事实，不决定领域保留、用户授权或恢复业务语义。

## 2. Artifact 模型

ArtifactRef 至少包含 artifactId、sha256、size、mediaType；受控 metadata 可记录 tenant/project、createdAt、encryption key ref 和 provenance ref。正文以 SHA-256 内容寻址；相同内容可以去重，但跨租户可见性不得因去重扩大。

写入流程为临时上传 → 计算并验证 hash/size → 原子发布 → 返回不可变 Ref。读取必须重新验证 hash、size 和 mediaType；损坏返回 INTEGRITY 错误，不得返回部分内容。

## 3. Artifact 类型

包括 ContextPack、模型原始响应、工具输出、源代码片段、日志、诊断、ChangeSet、patch/commit、测试证据、Workflow/Session checkpoint manifest、workspace snapshot 和报告。协议中只传 Ref，禁止内嵌超限正文。

## 4. 引用与一致性

- 数据库领域事务提交 ArtifactRef 后，引用才成为可达根。
- Artifact 已写但领域事务失败时形成孤儿，由 grace period 后 GC。
- 数据库引用不存在对象时返回完整性故障并阻止完成或恢复。
- Artifact Store 不反向写领域表；可用性变化通过 Event/Query 告知 Owner。

## 5. Retention

CheckpointParticipant 使用 `prepareRetention`、`commitRetention`、`abortRetention`、`queryRetention` 和 `releaseRetention` 管理保留 token。SessionCheckpoint 是 GC root；WorkflowCheckpoint、运行、审计、legal hold 和用户固定点可以形成其他 root。

普通删除只在所有 root 释放并经过 grace period 后物理回收。法规删除、安全撤销或损坏可以使保留对象不可用，但必须留下墓碑并发布失效事实，使相关 checkpoint 转为 DEGRADED、REVOKED 或 CORRUPTED。

## 6. 访问控制与数据保护

- 每次读取依据当前身份、tenant/project、数据等级和用途重新授权；持有 Ref 不等于有读取权。
- 使用传输和静态加密；密钥轮换不改变内容 hash 语义。
- Secret、短期 credential 和未脱敏个人数据不得因调试自动写入 Artifact。
- 下载使用短期、最小范围许可；URL 不得作为长期 ArtifactRef。
- Retention、合法删除和数据驻留策略必须可审计。

## 7. 恢复与复制

恢复时 Store 只验证 Ref 可读性、hash、保留根和访问权限，并在需要时物化对象；不判断用户是否有权启动恢复。远程复制、CAS/S3 Adapter 和本地存储必须提供相同完整性与不可变语义。

## 8. 可观测性与测试

记录容量、对象数、读写延迟、hash 失败、孤儿、保留 token、GC backlog、复制延迟和恢复验证。测试覆盖重复写、部分上传、事务失败孤儿、引用缺失、跨租户拒绝、保留并发、checkpoint 删除/恢复竞争、共享对象不误删、墓碑和加密轮换。
