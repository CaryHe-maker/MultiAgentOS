# MultiAgentOS M1 UserInteraction

## 1. 目的与范围

本文规定 M1 UserInteraction 的交互范围：用户请求、授权询问与结果展示。
请求经 Gateway 进入 Kernel，可用请求见 [Kernel（外部视角）](Kernel.md) 第 4.2 节，字段见 [M1Interface](../M1Interface.md) 第 4、5 节；
长期规划见 [UserInteraction 架构](../../Architecture/Module/UserInteraction.md)。

## 2. 职责

- 进入 Kernel 的唯一途径是 `InteractionGatewayPort`：`createRun`、`answerAuthorization`、
  `cancelRun`、`readArtifact`、`shutdown`。
- 实现 `InteractionInboxPort`，按顺序逐条处理 AuthorizationRequest、AuthorizationResolved 与 RunFinished。
  处理事件时只等待自己发起的请求的返回值，不等待用户输入：读取 Y/N 由独立的询问任务完成，Inbox 的处理不因此阻塞。
- 展示 AnalysisReport、结束原因、失败说明与未知效果；展示完成后请求关闭。
- M1 采用单次目标输入与最终输出，运行中用户只能终止运行或回答授权。
- 不直接访问 ArtifactStore、Persistence 或 Workflow；`requestId` 由 UserInteraction 生成（`req_` 加 ULID）。
- 对终端的全部要求由 `TerminalPort` 表达，由 `apps/cli` 实现；CLI 经 `UserInteractionModule.analyze` 进入
  （[M1Interface](../M1Interface.md) 第 14.2 节）。

## 3. CLI 流程

CLI（`apps/cli`，Commander）只调用 UserInteraction 的公开入口：
组合根先调用 CLI 解析与校验参数；无效命令直接返回退出码，不构造或启动系统。
合法命令在系统启动后交给 `UserInteraction.analyze`。
CLI 的帮助与参数错误提示同样使用中文（UTF-8），命令与选项名保留原样；
帮助正常返回 0，参数校验失败返回 64，不把解析器的英文诊断直接展示给用户。

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
       RunFinished           → 撤销仍在等待输入的询问任务 → 第 5 节展示 → 有 runSummaryRef 且 --details 时读取并展示
                               → 记录退出码 → shutdown
用户按 Ctrl+C（运行中）→ cancelRun；之后照常等待 RunFinished
```

| closeReason | 退出码 |
| ----------- | ------ |
| COMPLETED   | 0      |
| FAILED      | 1      |
| RUN_TIMEOUT | 2      |
| VIOLATION   | 3      |
| CANCELLED   | 130    |

降级报告以 COMPLETED 结束，退出码为 0；展示时标明为降级报告并说明收尾原因（第 5 节）。

若 RunFinished 带 `finalizationError = RUN_SUMMARY_WRITE_FAILED`，显示摘要保存失败；最终退出码至少为 1，
原有非零退出码（例如 VIOLATION 的 3）保持不变，并继续请求 `shutdown`。

Ctrl+C 只有第一次由 UserInteraction 处理：运行中调用 `cancelRun`，尚未创建运行或运行已结束时不做任何事。
第二次 Ctrl+C 由组合根的最后防线强制退出进程（退出码 130），UserInteraction 与 `apps/cli` 的终端适配器都不自行退出
（[错误与系统故障处理](../SystemFaultHandling.md) 第 6 节）。

以上是 UserInteraction **记录**的退出码，即 `analyze` 的返回值。进程最终的退出码由组合根决定（第 6 节）；
命令行无法解析时 CLI 返回 64，系统故障为 70，这两个值都不由 UserInteraction 产生。

## 4. 授权询问

- 询问由 Core 在第一个受保护 Unit 到达权限检查时发起，以 AuthorizationRequest 投递到 UserInteraction 的 Inbox。
- 显示内容：仓库路径、排除规则、“读取的内容会发送至 <provider>”与回答期限。
- 用户回答后按 `questionId` 经 Gateway 提交；回答只是原始响应，由 Core 判断适用性并决定是否签发 Lease。
- 拒绝或超时不视为同意。询问已失效时提交回答得到 `QUESTION_NOT_PENDING`，UserInteraction 只关闭询问，不报错。
- 询问任务在用户回答、到达 `expiresAt`、收到对应的 AuthorizationResolved 或 RunFinished 时结束；无论用户是否回答，后续事件都能被处理。
- 终端输入结束视为没有回答：不视为同意，也不提交回答。终端读写出错按询问任务的故障处理（第 6.1 节）。
- 询问以 `expiresAt` 为期限；超时说明对同一询问只展示一次；授权结果始终以 Core 的 AuthorizationResolved 为准。

## 5. 结果展示

展示层必须兼容中文及其他正常 Unicode，不自行翻译或改写模型报告正文；
报告生成的语言由 Prompt 设计负责，不属于本模块的语言推断职责。
报告、授权信息和运行摘要中的 C0、DEL、C1 控制字符必须显示为可见的 `\uXXXX` 转义，
保留 LF 换行及普通文字；转义只作用于展示文本，不修改产物原文、来源路径或协议字段。

- 用户可见文案使用中文（UTF-8），集中维护在 `InteractionMessages` 中，包含结束说明、全部原因码的说明、
  通用说明、授权超时与取消、未知效果、报告与摘要读取失败、摘要保存失败。
  面向开发者的报错与源码注释使用英文；协议码、Schema 标识、字段名与其他协议标识保持原样。
- RunFinished 带 `reportRef` 时，经 Gateway 的 `readArtifact` 读取，按 `workflow.AnalysisReport` 校验后展示：
  结论与来源（路径与行范围）、未确认项；`wrapUp` 存在时附收尾原因；`degraded` 为 true 时标明为降级报告。
  正常报告展示模型的 `summary` 原文；降级报告的 `summary` 是占位文本，不展示，改为按 `wrapUp.reason`
  从 `InteractionMessages` 给出说明；带 `wrapUp.lastIssue` 时，按原因码或非法输出的原因补充最后一次调用为何没有结束。
  报告带 `emptyReads` 时说明另有若干空文件未列入来源。
  报告的全部说明文字只由本模块生成，Workflow 不在报告中写入面向用户的文字。
- 没有 `reportRef` 时按 `closeReason` 展示结束说明；`failure` 存在时，按 `failure.code` 从 UserInteraction 自有的文案表
  （`InteractionMessages`）给出说明，未收录的原因码使用通用说明。`failure.detail` 不展示。
- 报告读取得到 SyscallRejected 或未通过 AnalysisReport 校验时，显示“报告无法读取”，
  继续展示结束说明及其他可展示信息，最终退出码至少为 1，保留原有非零退出码，照常请求 shutdown。
  该结果不调用 reportSystemFault；读取调用本身抛错仍按第 6.1 节处理。
- `--details` 的摘要读取得到 SyscallRejected 或未通过 RunSummary 校验时，
  显示“运行摘要无法读取”，不改变退出码，照常请求 shutdown。
  该结果不调用 reportSystemFault；读取调用本身抛错仍按第 6.1 节处理。
  `finalizationError` 的保存失败说明与非零退出码规则仍然适用，此时不读取摘要。
- `unknownEffects` 不为空时附“部分操作无法确认是否完成”。
- `finalizationError` 表示 RunSummary 发布失败，不能读摘要，也不能伪造 `runSummaryRef`；显示明确的保存失败说明。
  即使有报告仍先展示报告，再展示这一故障；`--details` 只在事件带合法 `runSummaryRef` 时读取摘要。
- 各结束方式下用户看到的内容见 [Kernel（外部视角）](Kernel.md) 第 9 节。
- 用户默认只看到结果；`--details` 时额外展示 RunSummary：各 AgentRun 的 Round
  （`agentRuns[].rounds`）、Unit 与模型调用次数、token、耗时，
  以及 `failure.category` 给出的失败分类。步骤数只在 Workflow 的运行记录中，不展示。

## 6. 关闭

- 展示完成后，先等已发出的授权回答与取消请求返回（不等待用户输入），再调用 `shutdown`；
  运行仍在进行时调用 `shutdown` 会先按取消收敛（Kernel 第 4.3 节）。
- `stop()` 先处理完 Inbox 中剩余的事件再停止，保证 RunFinished 一定被展示。故障关闭时，`stop()` 结束本地对控制请求的等待；
  这不表示远端已经停止，迟到的结果仍被观察，但不再推进任何业务。
- `stop()` 可重复调用，在 `start()` 之前或失败之后调用也安全，只清理已取得的资源（M1Interface 第 10 节）；
  ModuleHost 会对启动失败的模块调用它。清理失败不得被忽略，经 `stop()` 的拒绝或故障上报交给组合根。
- UserInteraction 不自行退出进程：它记录退出码（第 3 节），组合根在 ModuleHost 完成全部关闭（[ModuleHost](../Infrastructure/ModuleHost.md) 第 2 节）后
  决定进程的退出码：正常关闭时取该退出码；出现过系统故障时，该退出码非零则保留，否则为 70
  （[错误与系统故障处理](../SystemFaultHandling.md) 第 5 节）。

### 6.1 自身错误

UserInteraction 不尝试自行恢复，也不把自身错误写成运行结果。以下三处是它的捕获边界，捕获后只调用
`UserInteractionDeps.reportSystemFault`（`source = 'user-interaction'`），由组合根请求运行收敛并关闭系统：

| 位置 | 说明 |
| --- | --- |
| Inbox 处理器 | 作为 Inbox 的失败观察者接入；之后的事件仍按顺序处理 |
| 询问任务 | 它脱离 Inbox 的处理独立运行，必须自带捕获，不得留下未处理的 Promise 拒绝 |
| Ctrl+C 等终端中断的处理 | 同上 |

- `analyze` 自身抛错由组合根的命令入口捕获，不需要再上报。没有注入上报函数时（单独测试本模块），错误使 `stop()` 失败。
- 契约内的结果不是自身错误：createRun 被拒、`QUESTION_NOT_PENDING`、报告或摘要读取被拒、校验不通过，按第 3–5 节展示。
- 按 Kernel 第 4.3 节，`cancelRun`、`shutdown` 总会得到 Ack，授权回答只会以 `QUESTION_NOT_PENDING` 被拒。
  出现其他拒绝时视为控制不变量失效：不伪造成功、不重试，按所在的捕获边界上报。
- 每次 Gateway 调用最多等待 30 秒，超时按所在的捕获边界上报，不重试；用户输入不受这个期限约束。
- 已经记录退出码之后，`shutdown` 失败或超时也只上报，并照常返回该退出码，以便组合根保留非零码。
- 上报故障之后不再发出任何控制请求；之后到达的 RunFinished 仍会展示。

## 7. M1 不实现

Web UI、WorkSession 与 SessionTree、运行中的信息补充或方案选择、暂停与恢复、跨进程的离线查询。
