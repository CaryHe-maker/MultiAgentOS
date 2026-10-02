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

所有改变运行状态的意图经 Gateway 提交，并说明身份、目标、请求关联和适用版本。
请求沿用 IdentityContext、目标对象、expectedVersion、idempotencyKey 和 reason 的语义约定；
身份必须来自可信上下文，重复请求或版本冲突不能通过 UI 重发产生隐式覆盖。
有效租约可以避免重复进入 Core 裁决，但不允许直接修改目标状态。
AgentOS 调用的接受、由其产生的中断送达及实际生效必须分别展示。
具体字段由各 MVP 的版本化接口确定，不得原地改变既有字段含义。

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

用户可见运行状态来自 Kernel 汇总的受控视图，各底层事实仍由其 Owner 维护。
RuntimeProjection 保留 sourceVersion、更新时间和来源身份，以支持客户端单调应用与断线重建。
投影带来源和版本，客户端不能用旧更新覆盖当前状态，也不能直读其他模块内部存储。

执行进度和模型输出可以通过专用逻辑流通道展示，由 Execution 或模型网关生产。
订阅需限定运行和数据范围，暂态片段不能当作 Kernel 已接受结果或 Workflow 已验收成功。
只展示供应商实际提供且允许展示的推理相关内容或摘要，不假定可取得内部推理。
断线、慢消费者和重连策略由 MVP 明确，UI 断线不能改变执行事实。

## 8. 安全与隐私

- Prompt、ReviewResponse、源代码和个人数据均视为敏感输入。
- 日志只记录标识、大小、类别和脱敏摘要；正文使用受控 ArtifactRef。
- 草稿与显示偏好不得影响执行授权。
- 所有查询限定 tenant/project、WorkSession 和当前身份范围。
- Web/CLI/IDE Adapter 不得持有长期执行凭据。

## 9. 测试要求

测试必须覆盖 PromptRevision 不可变性、SessionTree 分支、重复 UserIntent 幂等、expectedVersion 冲突、投影乱序、断线重建、审核响应失效、越权证据隐藏，以及 Adapter 无法绕过 Kernel 的架构规则。
