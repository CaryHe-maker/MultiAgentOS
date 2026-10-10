# MultiAgentOS M1 UserInteraction

## 1. 目的与范围

本文规定 M1 UserInteraction 的交互范围：用户请求、授权询问与结果展示。
请求经 Gateway 进入 Kernel，可用请求见 [Kernel（外部视角）](Kernel.md) 第 4.2 节，字段见 [M1Interface](../M1Interface.md) 第 4、5 节；
长期规划见 [UserInteraction 架构](../../Architecture/Module/UserInteraction.md)。

## 2. 职责

- 只持有 `InteractionGatewayPort`：`createRun`、`answerAuthorization`、`cancelRun`、`readArtifact`、`shutdown`。
- 实现 `InteractionInboxPort`，按顺序逐条处理 AuthorizationRequest、AuthorizationResolved 与 RunFinished。
  处理事件时只等待自己发起的请求的返回值，不等待用户输入：读取 Y/N 由独立的询问任务完成，Inbox 的处理不因此阻塞。
- 展示 AnalysisReport、结束原因、失败说明与未知效果；展示完成后请求关闭。
- M1 采用单次目标输入与最终输出，运行中用户只能终止运行或回答授权。
- 不直接访问 ArtifactStore、Persistence 或 Workflow；`requestId` 由 UserInteraction 生成（`req_` 加 ULID）。
- 对终端的全部要求由 `TerminalPort` 表达，由 `apps/cli` 实现；CLI 经 `UserInteractionModule.analyze` 进入
  （[M1Interface](../M1Interface.md) 第 14.2 节）。

## 3. CLI 流程

CLI（`apps/cli`，Commander）只调用 UserInteraction 的公开入口：

```text
multiagentos analyze --repo <绝对路径> [--details] "<目标>"
```

```text
createRun({ goal, repositoryPath })
  ├─ SyscallRejected → 显示原因（如 REPOSITORY_INVALID），退出码 4
  └─ RunCreated → 等待 Inbox 事件
       AuthorizationRequest  → 显示询问，启动询问任务后立即结束本条处理
                               询问任务读到 Y/N → answerAuthorization；到达 expiresAt 时自行结束，不提交回答
       AuthorizationResolved → 撤销仍在等待输入的询问任务；TIMED_OUT、CANCELLED 时显示说明
       RunFinished           → 撤销仍在等待输入的询问任务 → 第 5 节展示 → --details 时 readArtifact(runSummaryRef) 并展示
                               → 记录退出码 → shutdown
用户按 Ctrl+C（运行中）→ cancelRun；之后照常等待 RunFinished
```

| closeReason | 退出码 |
|---|---|
| COMPLETED | 0 |
| FAILED | 1 |
| RUN_TIMEOUT | 2 |
| VIOLATION | 3 |
| CANCELLED | 130 |

## 4. 授权询问

- 询问由 Core 在第一个受保护 Unit 到达权限检查时发起，以 AuthorizationRequest 投递到 UserInteraction 的 Inbox。
- 显示内容：仓库路径、排除规则、“读取的内容会发送至 <provider>”与回答期限。
- 用户回答后按 `questionId` 经 Gateway 提交；回答只是原始响应，由 Core 判断适用性并决定是否签发 Lease。
- 拒绝或超时不视为同意。询问已失效时提交回答得到 `QUESTION_NOT_PENDING`，UserInteraction 只关闭询问，不报错。
- 询问任务在用户回答、到达 `expiresAt`、收到对应的 AuthorizationResolved 或 RunFinished 时结束；无论用户是否回答，后续事件都能被处理。

## 5. 结果展示

- RunFinished 带 `reportRef` 时，经 Gateway 的 `readArtifact` 读取，按 `workflow.AnalysisReport` 校验后展示：
  结论与来源（路径与行范围）、未确认项；`wrapUp` 存在时附收尾原因；`degraded` 为 true 时标明为降级报告。
- 没有 `reportRef` 时按 `closeReason` 展示结束说明；`failure` 存在时，按 `failure.code` 从 UserInteraction 自有的文案表
  （`InteractionMessages`）给出说明，未收录的原因码使用通用说明。`failure.detail` 不展示。
- `unknownEffects` 不为空时附“部分操作无法确认是否完成”。
- 各结束方式下用户看到的内容见 [Kernel（外部视角）](Kernel.md) 第 9 节。
- 用户默认只看到结果；`--details` 时额外展示 RunSummary：各 AgentRun 的 Round（`agentRuns[].rounds`）、Unit 与模型调用次数、token、耗时，
  以及 `failure.category` 给出的失败分类。步骤数只在 Workflow 的运行记录中，不展示。

## 6. 关闭

- 展示完成后调用 `shutdown`；运行仍在进行时调用会先按取消收敛（Kernel 第 4.3 节）。
- `UserInteraction.stop()` 先处理完 Inbox 中剩余的事件再停止，保证 RunFinished 一定被展示。
- UserInteraction 不自行退出进程：它记录退出码（第 3 节），组合根在 ModuleHost 完成全部关闭（[ModuleHost](../Infrastructure/ModuleHost.md) 第 2 节）后，
  以该退出码退出进程。

## 7. M1 不实现

Web UI、WorkSession 与 SessionTree、运行中的信息补充或方案选择、暂停与恢复、跨进程的离线查询。
