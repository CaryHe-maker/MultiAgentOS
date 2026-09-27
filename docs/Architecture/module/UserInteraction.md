# MultiAgentOS UserInteraction

## 1. 定义

UserInteraction 是人类与 MultiAgentOS 交互的唯一产品边界。Web、CLI 和 IDE 均为该模块的 Adapter，不得形成绕过 Kernel 的独立控制面。

## 2. 权威对象

| 对象 | 语义 |
|---|---|
| WorkSession | 围绕持续目标组织多轮运行、观察和分支的交互容器 |
| SessionTreeNode | WorkSession 中一次运行、恢复或派生关系的节点 |
| InteractionTurn | 用户输入与系统展示的交互记录 |
| PromptRevision | 不可变的用户意图版本；修改产生新版本 |
| UserIntent | 用户要求系统执行的规范化控制意图 |
| InteractionViewState | 草稿、筛选、布局和显示偏好 |
| ReviewResponse | 用户提交的审核原始响应；不是权威审核决定 |

UserInteraction 是上述对象的唯一写入者，但不拥有 WorkflowRun、执行状态、SessionCheckpoint 内容、HumanReviewDecision 或 RuntimeProjection。

## 3. 能力

- 创建、命名、归档和选择 WorkSession。
- 提交初始 Prompt、补充信息和不可变 PromptRevision。
- 展示 SessionTree、运行分支、任务图、MissionScope、成本、Artifact、错误和恢复可用性。
- 请求 run、inspect、report、pause、resume、cancel、retry、rerun、fork、replan 和 checkpoint 操作。
- 展示审核风险、规范化参数、影响范围、证据、替代方案、成本、回滚方式、有效期和职责分离要求。
- 收集 approve、reject、request-changes、provide-information 和 accept-result 等 ReviewResponse。
- 根据事件游标和 Query 重建视图；界面断线不得改变运行生命周期。

## 4. 控制路径

```text
Adapter -> UserInteraction -> UserIntent -> KernelControlPort
Kernel -> RuntimeProjection / ReviewProjection -> UserInteraction -> Adapter
```

所有改变运行状态的意图必须携带 IdentityContext、目标对象、expectedVersion、idempotencyKey 和 reason。UserInteraction 只表达意图；Kernel 完成认证、授权、策略、状态和版本准入后，才能转发给状态 Owner。

## 5. Session 与恢复交互

- SessionTree 保存用户如何组织和派生运行，不替代 TaskGraph 或 MissionScope Tree。
- PromptRevision 发布后不可覆盖；恢复或分支时创建新 revision，并保留父引用。
- SessionCheckpoint 的内容和可恢复性由 Workflow 拥有。UserInteraction 只维护标题、标签、固定状态请求、展示关系和用户选择。
- 新运行已提交前不得提前向 SessionTree 添加成功分支。
- 删除、固定、恢复或重命名 checkpoint 都必须经 Kernel 准入。

## 6. 人类审核

UserInteraction 展示 Kernel 发布的脱敏 ReviewProjection，并提交用户原始 ReviewResponse。它不得：

- 验证审查者权限或聚合多人决定；
- 创建 HumanReviewDecision；
- 解除 Workflow 等待；
- 签发 Grant、Lease 或 ExecutionPermit；
- 在参数、revision 或 policy 改变后复用旧响应；
- 为展示证据扩大审查者的数据权限。

审批事实由 Kernel 裁决；审核等待和决定后的业务行为由 Workflow 解释。

## 7. 投影与一致性

用户可见运行状态必须来自 Kernel 拥有的 RuntimeProjection。投影至少带 `sourceVersion`、更新时间和来源身份；客户端按版本单调应用，忽略重复或倒退更新。UserInteraction 不得轮询 Executor、读取进程内存或直读其他 Module 数据库拼接“真实状态”。

## 8. 安全与隐私

- Prompt、ReviewResponse、源代码和个人数据均视为敏感输入。
- 日志只记录标识、大小、类别和脱敏摘要；正文使用受控 ArtifactRef。
- 草稿与显示偏好不得影响执行授权。
- 所有查询限定 tenant/project、WorkSession 和当前身份范围。
- Web/CLI/IDE Adapter 不得持有长期执行凭据。

## 9. 测试要求

测试必须覆盖 PromptRevision 不可变性、SessionTree 分支、重复 UserIntent 幂等、expectedVersion 冲突、投影乱序、断线重建、审核响应失效、越权证据隐藏，以及 Adapter 无法绕过 Kernel 的架构规则。
