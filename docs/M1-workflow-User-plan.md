# M1 Workflow 与 UserInteraction 实现计划

## 1. 用途与当前状态

### 1.1 本文的地位

- 本文是 `feature/M1/workflow-UserInteraction` 分支的工作文档，有三个用途：按步骤规划 Workflow、
  UserInteraction 与 CLI 的实现；记录进度与验证证据；作为后续对话（AI agent）接手这项工作的上下文入口。
- 本文不是规范。规范是 `docs/M1/` 下的文档；本文第 5 节只是把它们对本分支的要求整理成核对清单，
  两者不一致时以规范为准，并修正本文。
- 本文不进入 `feature/M1/main`、`feat/M1` 与 `main`。向 `feature/M1/main` 提 PR 时使用不含本文的导出分支（第 9.3 节）。
- 进入 `main` 的任何文件都不得依赖本文：规范、源码注释、错误信息与测试不链接本文，
  也不使用本文的阶段编号（T01–T19）、问题编号（Q01 起）和决定编号（D01 起）。只有本文可以引用规范。
  下面的命令除本文外应当没有结果：

  ```bash
  git grep -nE "workflow-User-plan|\bT(0[1-9]|1[0-9])\b|\bQ[0-9]{2,}\b" -- . \
    ':!docs/M1-workflow-User-plan.md' ':!pnpm-lock.yaml'
  ```

- 文件名是文档 PascalCase 命名惯例的例外，由用户指定，保留该名称。

### 1.2 当前状态

- 更新日期：2026-10-15。
- 本轮起点：`57dc85d`，已包含用户合入的共享契约更新；最新 HEAD 与提交正文以 git log 为准。
  用户已授权整理为三个提交并推送当前工作分支，不创建 PR、不切换或合并分支；见第 10.9 节。
- Workflow 已接入工厂、循环、交接、报告发布与记录，通过模块内替身验收；尚未完成真实 Kernel 联合验收。
  UserInteraction 已接入工厂、授权、中文展示、退出码与组合根故障回调。
- 任务共 19 项：T01–T17 已完成，共 17 项；剩余 2 项：T18 进行中、T19 等待中。
  这是任务数量统计，不是工时比例；已完成指本分支实现与已记录的测试验收。
- CLI、完整组合及共享 Inbox 接缝验收已完成；首次合入与真实联调未完成。
  详情见第 10.1 节。
  语言要求已更正，Q11 解除；Q14 已由用户决定并实现；预算事实优先已实现。
  用户最终决定 FAILED 只走错误路径，不提交降级报告；Q17 已解除，不修改共同契约。
  用户已同意 Q18 的本分支映射例外，不修改报告结构与共同协议。
  Q19–Q23 均已决定并实现；当前问题状态见第 10.5 节，历史讨论单独标注。
- 最新完整质量门为 55 文件／593 测试；Ubuntu-24.04 隔离副本 build 与完整 check 通过，见第 10.3 节。
  共享 Inbox 的已知 fake 边界差异已修复；根说明文档、前缀 fixture 与 Prompt 按用户决定后续处理。
  T18 首次合入不等待其他分支的真实实现；T19 才依赖真实 Kernel、Executor 与可用定义。

### 1.3 后续对话的开始步骤

每个新对话接手时按顺序做，不要只凭本文推断实现已经完成：

1. 读本文第 1、2、6、10 节。
2. 运行 `git status`、`git log --oneline -10`，并与第 10.1 节的继续点核对；不一致时以仓库为准并更新本文。
3. 读当前阶段在第 7 节列出的规范小节，以及要修改的源码。
4. 只做当前阶段的工作。完成后按第 8 节验证，按第 10 节更新本文。
5. 不自动 commit、push 或创建 PR：这三件事都要等用户明确要求（第 9.1 节）。

## 2. 修改边界

以下边界来自 [M1Plan](M1/M1Plan.md) 第 4.1 节与用户的明确指令，必须遵守。

### 2.1 本分支可以直接修改的范围

- `packages/modules/workflow/**`
- `packages/modules/user-interaction/**`
- `apps/cli/**`
- `docs/M1/Module/Workflow.md`、`docs/M1/Module/UserInteraction.md`：这两份是本分支实现所依据的规范，
  实现中发现的缺口在这里补齐（先取得用户决定，见第 6 节）。
- 本文。

### 2.2 共享接缝

2026-10-15 用户已明确授权 Q24 的最小修复：修改两个既有共享 fake 的 Inbox 入口，
补校验、消息复制及共享回归；不扩大到共享 Inbox、Fabric、Kernel 或其他 fake。见 D28。

以下内容三个分支共用。本分支需要改动它们时，必须作为单独的提交，只包含接缝本身及其规范、fake 与测试的同步修改，
先合入 `feature/M1/main`，再由各分支同步（M1Plan 4.1 的五条规则）。不得夹在功能提交里。

- `packages/libraries/contracts/**`（Schema、Port、跨模块类型）
- `packages/testing/**`（fake、fixture、共享 contract test）
- `WorkflowDeps`、`UserInteractionDeps`、`TerminalPort`、`AnalyzeCommand` 与两个工厂的签名
  （M1Interface 第 14.2 节）
- `docs/M1/M1Interface.md`、`docs/M1/Library/SharedContracts.md`
- 根目录的构建与检查配置、`pnpm-lock.yaml`

### 2.3 不属于本分支的范围

| 范围 | 归属 | 本分支的做法 |
| --- | --- | --- |
| `packages/modules/kernel/**`、`packages/infrastructure/**`、`apps/control-plane/**` | `feature/M1/kernel-infrasturcture` | 只读；需要变化时向用户提出 |
| `packages/libraries/executor-set/**`、`packages/libraries/agent-tool-pool/**`、Prompt 正文、Tool 的 `modelDescription` | `feature/M1/pool-executor`（meti） | 只读；不以重构、格式化或“顺手修正”为由改动 |

发现必须修改上述范围时，在修改之前通知用户，说明涉及的文件、证据、能否用本分支内的 Adapter 或测试替身解决，
以及最小修改建议。通知不等于授权。可以先继续不依赖该变更的工作，并在第 6 节或第 10.2 节记录阻塞。

系统级测试（真实 Workflow 与 UserInteraction 配合 fake Kernel 经 `composeSystem` 运行）只能放在
`apps/control-plane`，因为只有组合根能同时依赖全部模块。它属于上表第一行，处理方式见 Q08。

## 3. 规范来源

优先阅读，按顺序：

| 文档 | 用途 |
| --- | --- |
| [M1Plan](M1/M1Plan.md) | 范围、非目标、分工、完成定义、发布阻断项 |
| [Workflow](M1/Module/Workflow.md) | Workflow 的全部业务机制，本分支的主要规范 |
| [UserInteraction](M1/Module/UserInteraction.md) | CLI 流程、授权询问、结果展示、关闭、自身错误 |
| [Kernel（外部视角）](M1/Module/Kernel.md) | syscall、回应、运行状态下的请求处理、授权、额度状态、结束方式、原因码处理 |
| [M1Interface](M1/M1Interface.md) | 字段级定义：第 2.3、2.4、3.4、4、5、6、9、10、14 节 |
| [错误与系统故障处理](M1/SystemFaultHandling.md) | 捕获边界、`reportSystemFault`、退出码、`stop()` 契约 |
| [AgentToolPool](M1/Library/AgentToolPool.md) 第 4 节 | 两个 Agent 的 `limits`、`startUnitRefs`、`actions`，各 Unit 的 `failurePolicy`，四个 Tool |
| [M1TechStack](M1/M1TechStack.md) 第 4、6、11 节 | CLI、reducer 的技术约束与质量门 |
| [Style](Style.md) | 代码、文档、提交与 PR 规范 |

Architecture 定义长期职责，M1 定义当前交付子集；M1 不实现的能力见 M1Plan 第 3 节，不得顺手实现。
`packages/libraries/contracts` 中的 Schema 是已实现协议的可执行事实源，与文档冲突时记录证据并先协调，不自行选择。

可参考的现有代码（只读）：

- `apps/control-plane/src/bootstrap/perspectives.test.ts`：
  其中的 `referenceWorkflow` 与 `referenceInteraction`
  是只依赖公开接缝写成的最小参照实现，展示了完整的 syscall 顺序、UnitReport 先于 SyscallAck 的处理和询问任务。
  它们是测试代码，不满足规范的大部分要求，不得直接搬作产品实现。
- `packages/testing/src/fakes/fake-kernel.ts`：`FakeKernelOptions` 可以产生本分支需要处理的全部结束方式与事件。

## 4. 现状与依赖

### 4.1 已经具备的

| 内容 | 位置 |
| --- | --- |
| 全部 Schema、Port、原因码与校验工具 | `packages/libraries/contracts` |
| 两个工厂的签名、依赖清单、`TerminalPort`、`AnalyzeCommand`、退出码表 | 两个模块包的 `src/index.ts` 与 `domain/exit-codes.ts` |
| `Inbox`（单消费者队列，带 `dedupeKey` 与 `onError`）、Gateway 与 Inbox 的 Port 存根 | `packages/infrastructure/fabric` |
| CLI 的解析与校验（`parseCli`、`runParsedCli`）、Node 终端适配器 | `apps/cli` |
| 组合根、进程入口 `bin.ts`、系统控制、最后防线（含第二次 Ctrl+C） | `apps/control-plane` |
| fake Kernel、fake Executor、fake Catalog、fake 终端；fake 纵向链 | `packages/testing`、`apps/control-plane` 的测试 |
| 目录中的 16 个定义文件（Prompt 正文与 Tool 描述仍为占位） | `packages/libraries/agent-tool-pool/definitions` |

### 4.2 尚不具备、由其他分支交付的

| 内容 | 归属 | 对本分支的影响 |
| --- | --- | --- |
| 产品 Kernel 核心与 Supervisor 的执行派发 | kernel 分支 | T01–T17 使用 fake 或模块内替身，T18 首次合入不等待；T19 需要真实实现 |
| 真实的五个 Executor（本分支的 `createExecutorRegistry` 仍抛 `NOT_IMPLEMENTED`） | pool-executor 分支 | 不阻塞本分支确定性验收与 T18；T19 联合验收需要它 |
| Prompt 正文与 Tool 的 `modelDescription` 定稿 | Cary 与 meti | 不阻塞 T18；影响 T19 的真实模型表现，不影响确定性测试 |

### 4.3 工程约束

- 两个模块的 `dependencies` 只允许 `@multiagentos/contracts` 与 `@multiagentos/fabric`，由架构测试强制。
- 两个模块不得依赖 `packages/testing`：它反过来依赖这两个模块。模块自己的测试使用模块内的测试替身（T02）。
- `apps/cli` 只允许依赖 `contracts` 与 `user-interaction`。
- 不得引入 provider SDK 与 `child_process`；不新增依赖（需要时先走 M1TechStack 第 13 节）。
- TypeScript 严格模式、禁止 `any`、禁止 floating promise、`import type`；每行最多 100 字符。

## 5. 实现必须满足的要求

本节是规范的核对清单，每条后面是出处。实现与评审时逐条对照；规范正文才是定义。

### 5.1 两个模块共同的要求

| 编号 | 要求 | 出处 |
| --- | --- | --- |
| R-C1 | 进入 Kernel 的唯一途径是各自的 GatewayPort；不直接访问 ArtifactStore、对方模块或 Kernel 内部 | Kernel 第 4 节、M1Plan 第 8 节 |
| R-C2 | `inbox.deliver` 只入队即返回；事件按 `eventId` 去重，按到达顺序逐条处理，不因 `seq` 缺口等待 | Kernel 4.5 |
| R-C3 | 处理事件时只等待自己发起的请求的返回值 | Workflow 第 4 节、UserInteraction 第 2 节 |
| R-C4 | `requestId` 由模块生成（`req_` 加 ULID，使用 `newId`）；一次请求意图一个 `requestId`，重发沿用 | M1Interface 2.3 |
| R-C5 | `BoundaryContext.correlationId` 可以任意生成；自己的记录以 `workflowRunId` 为关联键 | M1Interface 2.4 |
| R-C6 | `stop()` 可重复调用，在 `start()` 之前或失败之后调用也安全；先处理完 Inbox 中剩余的事件再停止 | SystemFaultHandling 第 4 节、UserInteraction 第 6 节 |
| R-C7 | 契约内的结果用返回值表达；`throw` 只用于缺陷，且不跨通讯主体；`catch` 只出现在规定的捕获边界 | SystemFaultHandling 2.2 |
| R-C8 | Inbox 必须接入失败观察者（`onError`），并连到 `reportSystemFault`；该依赖缺省时错误留给 Inbox，使 `stop()` 失败 | SystemFaultHandling 2.2、Workflow 11.1、UserInteraction 6.1 |
| R-C9 | 工厂只构造，不启动；`manifest.moduleId` 与依赖按 M1Interface 第 10 节 | M1Interface 第 14 节 |

### 5.2 Workflow

| 编号 | 要求 | 出处 |
| --- | --- | --- |
| R-W1 | 处理以 `(状态, 输入) → (新状态, 动作)` 的 reducer 实现；输入包括 Inbox 事件与 syscall 的返回值；状态按第 4 节列出的字段保存 | Workflow 第 4 节、M1TechStack 第 6 节 |
| R-W2 | RunStart 后固定入口 Agent；集合有 `handoffTargetRef` 时固定目标并核对 digest；失败时 `closeRun(FAILED, PIN_FAILED)` | Workflow 9.1 |
| R-W3 | 启动 Unit 按 `startUnitRefs` 顺序逐个提交；`repository-orient` 的输入为 `{ objective: goal }`，成功时保存 `orientPackRef` | Workflow 9.1 |
| R-W4 | 每一轮先 `context-assemble` 再 `model-call`；`final` 两者一致；`status` 如实填写 | Workflow 9.1、M1Interface 6.3、6.4 |
| R-W5 | 一轮的工具 Unit 一次全部提交，按 `requestId` 收齐全部 UnitReport 后才进入下一步；UnitReport 可以先于 SyscallAck 到达 | Workflow 第 4 节、Kernel 4.4 |
| R-W6 | `ModelCallOutput` 按第 5 节的规则解释为 TOOL_CALLS、HANDOFF、FINISH 或 INVALID，包括五种 INVALID 原因 | Workflow 第 5 节 |
| R-W7 | Validation 的五项检查按顺序进行，不通过的调用记录带 `toolCallId` 的 FEEDBACK 且不提交；通过的以该工具所属 Unit 提交 | Workflow 第 6 节 |
| R-W8 | `regenerationCount`、`noProgressCount` 的增减与清零，以及达到上限时设置的 `wrapUpReason` | Workflow 第 5、6 节 |
| R-W9 | SyscallRejected：`RUN_BLOCKED` 停止推进并等待 RunClosed；其他原因码 `closeRun(FAILED)`；`closeRun` 被拒时不再发起请求 | Workflow 7.1 |
| R-W10 | UnitReport 的 REJECTED、FAILED 查该 Unit 的 `failurePolicy`，未列出的按 FATAL；一轮内取最严重者；final-call 的 model-call 失败一律 DEGRADED_REPORT | Workflow 7.2 |
| R-W11 | `roundsUsed` 的计数规则；final-call 的触发条件（`wrapUpReason` 已设置，或 `maxRounds − roundsUsed ≤ 1`）；多个原因保留最先的 | Workflow 第 8 节 |
| R-W12 | `budgetState` 为 WRAP_UP 时本轮已提交的工具 Unit 照常执行完；EXHAUSTED 时不再发起 model-call 与新的工具 Unit | Workflow 第 8 节 |
| R-W13 | 每个 WorkflowRun 至多一次 final-call；其结果不是合法 FINISH 时不重新生成，直接生成降级报告 | Workflow 第 8 节 |
| R-W14 | 交接：`endAgentRun(Planner)` → `registerAgentRun(CodeViewer)` → 启动 Unit → 第一轮携带 brief；单向；只有 `BUDGET_WRAP_UP` 跨 AgentRun 继承 | Workflow 9.2 |
| R-W15 | 来源核验：每个来源必须被本运行中某一次成功的 file-read 覆盖（路径相同、行范围被包含）；三种未确认原因 | Workflow 10.1 |
| R-W16 | AnalysisReport 满足 Schema 的条件约束：非降级时每条结论至少一个来源；降级时 `wrapUp` 必填且两个列表为空 | M1Interface 1.4、6.6、Workflow 10.2 |
| R-W17 | 报告发布必须在当前 AgentRun 仍为 ACTIVE 时进行；顺序为写记录 → `report-publish` → `endAgentRun` → `closeRun(COMPLETED)` | Workflow 10.1 |
| R-W18 | 任何一次处理只能落入“继续推进、等待结束、无法继续”三种情况之一；收到 RunClosed 后停止推进并记录业务终态 | Workflow 第 11 节 |
| R-W19 | 自身内部错误先 `closeRun(FAILED, WORKFLOW_INTERNAL)`；做不到才经失败观察者上报，不在同级重试 | Workflow 11.1 |
| R-W20 | `WorkflowRunRecord` 经 `PersistencePort.repository('workflow', workflowRunId)` 保存，写入两次，字段见第 13 节 | Workflow 第 13 节 |
| R-W21 | 不持有任何 token 数值，不读取 token 配置；只经 `budgetState` 得知额度状态 | Workflow 第 2、12 节、Kernel 第 8 节 |
| R-W22 | 上限与失败处理只从固定的定义中读取（`limits`、`startUnitRefs`、`actions`、`failurePolicy`），不写死在代码里 | Workflow 第 2、8 节 |
| R-W23 | 工具参数按该工具的 `parametersContract` 经 `ProtocolRegistry` 校验，与 Kernel 使用同一份 Schema | Workflow 第 6 节 |

### 5.3 UserInteraction 与 CLI

| 编号 | 要求 | 出处 |
| --- | --- | --- |
| R-U1 | `analyze` 运行一个目标直到结束：`createRun` → 等待事件 → 展示 → 记录退出码 → `shutdown` → 返回退出码 | UserInteraction 第 3 节 |
| R-U2 | `createRun` 被拒时显示原因，退出码 4，仍请求 `shutdown` | UserInteraction 第 3 节 |
| R-U3 | AuthorizationRequest：显示仓库路径、排除规则、provider 与期限，启动询问任务后立即结束本条处理 | UserInteraction 第 3、4 节 |
| R-U4 | 询问任务在用户回答、到达 `expiresAt`、收到对应的 AuthorizationResolved 或 RunFinished 时结束；到期自行结束时不提交回答 | UserInteraction 第 4 节 |
| R-U5 | 回答得到 `QUESTION_NOT_PENDING` 时只关闭询问，不报错；TIMED_OUT、CANCELLED 时显示说明 | UserInteraction 第 3、4 节 |
| R-U6 | 第一次 Ctrl+C：运行中调用 `cancelRun`，之后照常等待 RunFinished；尚未创建运行或运行已结束时不做任何事；不自行退出进程 | UserInteraction 第 3 节、SystemFaultHandling 第 6 节 |
| R-U7 | 退出码按 `closeReason`；带 `finalizationError` 时至少为 1 且保留原有非零码；UserInteraction 不产生 64 与 70 | UserInteraction 第 3 节 |
| R-U8 | 有 `reportRef` 时经 `readArtifact` 读取，按 `workflow.AnalysisReport` 校验后展示结论、来源、未确认项、收尾原因与降级标记 | UserInteraction 第 5 节 |
| R-U9 | 没有 `reportRef` 时按 `closeReason` 展示；`failure.code` 查自有文案表，未收录的用通用说明；不展示 `failure.detail` | UserInteraction 第 5 节 |
| R-U10 | `unknownEffects` 不为空时附说明；`finalizationError` 时显示保存失败，且不读取摘要 | UserInteraction 第 5 节 |
| R-U11 | `--details` 且事件带合法 `runSummaryRef` 时读取并展示 RunSummary 的规定字段 | UserInteraction 第 5 节 |
| R-U12 | Inbox 处理器、询问任务、中断处理三处是捕获边界，捕获后只调用 `reportSystemFault`，不自行恢复 | UserInteraction 6.1 |
| R-U13 | 对终端的全部要求经 `TerminalPort` 表达；模块本身不接触 stdin、stdout 与进程信号 | UserInteraction 第 2 节 |
| R-U14 | CLI 只调用 UserInteraction 的公开入口；终端适配器只转发中断，不退出进程 | UserInteraction 第 3 节、SystemFaultHandling 第 6 节 |

## 6. 待决定的问题与已有决定

### 6.1 已确认的问题（T01）

2026-10-14 用户确认并更正：Q03 的用户文案使用中文（UTF-8），
面向开发者的报错与注释使用英文；其他问题按建议执行。协议标识保持原样；不得因此自动修改其他分支或共享接缝的代码。

本表的“已完成”表示问题已取得决定，具体实现阶段以第 7 节为准；
Q08、Q09 的授权已完成，不代表 T16、T17 的全部测试已完成。

| 编号 | 问题 | 建议 | 影响阶段 | 决定状态 |
| --- | --- | --- | --- | --- |
| Q01 | `FeedbackCode` 中有 `WRAP_UP_NOTICE`，但 Workflow 规范没有规定何时记录 | 在决定下一次 model-call 为 final-call 时记录一条不带 `toolCallId` 的 `FEEDBACK(WRAP_UP_NOTICE)`，说明 `wrapUpReason`；若认为 `status.wrapUpReason` 已足够，则明确规定 M1 不使用该反馈码 | T06 | 已完成 |
| Q02 | 重复调用检测中“规范化参数”的定义 | 对模型给出的 `arguments` 取 `canonicalJson`，不补缺省值；`{query:"a"}` 与 `{query:"a",mode:"AUTO"}` 视为不同调用 | T04 | 已完成 |
| Q03 | 用户可见文案的语言，以及 `InteractionMessages` 的内容 | 用户文案使用中文（UTF-8），面向开发者的报错与注释使用英文；用户文案集中在一个表中；为 M1Interface 3.4 中 `RunFailure` 可能出现的原因码各写一条，其余用通用说明 | T13 | 已完成 |
| Q04 | `readArtifact(reportRef)` 被拒，或报告未通过 `AnalysisReport` 校验时如何展示、退出码是多少 | 显示“报告无法读取”，退出码至少为 1，照常 `shutdown`；属于契约内结果，不上报系统故障 | T13 | 已完成 |
| Q05 | `--details` 读取或校验 RunSummary 失败时 | 显示“运行摘要无法读取”，不改变退出码 | T13 | 已完成 |
| Q06 | 同一来源范围被多次 file-read 覆盖时，`VerifiedSource` 记哪一次 | 记最早一次覆盖它的成功读取，使结果确定 | T09 | 已完成 |
| Q07 | Gateway 存根的调用抛错（传输层缺陷，而不是 SyscallRejected）时 Workflow 是否重发 | 不重发，按内部错误处理（R-W19）；M1 没有需要重发的场景，R-C4 的“重发沿用”只是保持幂等的写法 | T10 | 已完成 |
| Q08 | 系统级测试必须放在 `apps/control-plane`，它不属于本分支可直接修改的范围 | 作为单独的测试提交加入 `apps/control-plane/src/bootstrap/`（只新增测试文件，不改产品代码），按共享接缝的规则先进 `feature/M1/main` | T16 | 已完成 |
| Q09 | M1Interface 第 13 节要求每个 Port 有共享 contract test；`packages/testing/src/harnesses` 目前没有两个 Inbox Port 的 | 由本分支补一个同时运行 fake 与产品实现的 Inbox Port contract test，作为共享接缝提交 | T17 | 已完成 |
| Q10 | 展示格式（标题、缩进、来源的写法）规范没有规定 | 纯文本、无颜色、每条结论后列出 `路径:起始行-结束行`；格式由视图函数的快照测试固定，不写进规范 | T13 | 已完成 |

### 6.2 已有决定

| 编号 | 决定 | 日期 | 出处 |
| --- | --- | --- | --- |
| D01 | 运行的 `correlationId` 由 Gateway 写入，两个模块不会得到它，自己的记录以 `workflowRunId` 为键 | 2026-10-09 | M1Interface 2.4 |
| D02 | 条件必填字段在 Schema 中是联合的不同成员；读取前先用 `in` 或判别字段收窄 | 2026-10-09 | M1Interface 1.3、1.4 |
| D03 | `SystemFault` 与 `SystemFaultReporter` 在 contracts；两个依赖清单各有可选的 `reportSystemFault` | 2026-10-13 | M1Interface 第 10、14.2 节 |
| D04 | Workflow 先以 `closeRun(FAILED, WORKFLOW_INTERNAL)` 结束运行，做不到才上报；UserInteraction 直接上报 | 2026-10-13 | Workflow 11.1、UserInteraction 6.1 |
| D05 | 第一次 Ctrl+C 归 UserInteraction，第二次归组合根的最后防线；进程入口在 `apps/control-plane` | 2026-10-13 | SystemFaultHandling 第 6 节 |
| D06 | `RunClosed`、`RunFinished` 可能带 `finalizationError` 而没有 `runSummaryRef` | 2026-10-11 | M1Interface 5.2 |
| D07 | 本文不进入 `feature/M1/main`；PR 使用不含本文的导出分支 | 2026-10-13 | 本文第 9.3 节 |
| D08 | Q01、Q02、Q06 按第 6.3 节补充写入 Workflow.md | 2026-10-14 | 用户本轮决定 |
| D09 | Q03：用户文案中文（UTF-8），开发者报错与注释英文（用户已更正）；Q04、Q05 按建议写入 UserInteraction.md | 2026-10-14 | 用户本轮决定 |
| D10 | Q07 不重发 Gateway 抛错；Q10 使用无颜色纯文本与来源行范围 | 2026-10-14 | 用户本轮决定 |
| D11 | Q08、Q09 按建议实施，保持独立测试与共享接缝提交边界 | 2026-10-14 | 用户本轮决定 |
| D12 | 继续后续实现至下个必须用户决定的问题；所有问题记入本文；共享及其他分支代码变更须先询问 | 2026-10-14 | 用户本轮决定 |
| D13 | 用户更正 Q03：用户文案中文（UTF-8），开发者报错与注释英文；Q11 解除 | 2026-10-14 | 用户最新决定 |
| D14 | Q14：CodeViewer 的 handoff 为非法输出，按 INVALID 反馈并重新尝试；final-call 仍降级 | 2026-10-14 | 用户最新决定 |
| D15 | Q15：同一 UnitReport 先应用预算事实，再应用失败策略或模型动作与计数器，最后检查 Round 上限；已有原因保持不变 | 2026-10-14 | 用户最新决定 |
| D16 | Q16：普通调用 FATAL 与 EXHAUSTED 同时出现时仍以 FAILED 结束；降级报告必须说明最后失败；final-call 的既有降级例外保持不变 | 2026-10-14 | 历史决定；失败报告要求已被 D17 替代 |
| D17 | 用户最终决定：FAILED 按错误路径实现，不提交降级报告；替代 D16 的失败报告要求。FATAL 与 EXHAUSTED 同时出现仍为 FAILED，只传 failure；原有 COMPLETED 降级报告路径保留 | 2026-10-14 | 用户最新决定；Q17 解除，不修改共同契约 |
| D18 | 同意 Q18 建议：空文件读取留在内部记录，不列入报告行范围来源；摘要注明空文件数量，不能作为结论的有效行来源。沿用现有报告结构、发布方案与共同协议 | 2026-10-14 | 用户最新决定 |
| D19 | 用户要求补全 Workflow 故障闭环与 UserInteraction 调用组合根，完成后提交当前分支。实施故障后业务守卫、脱敏诊断及异常控制拒绝升级，不改共同契约或其他分支产品代码 | 2026-10-14 | 用户本轮明确授权 |
| D20 | Workflow 的 Gateway、Catalog、Persistence 每次等待返回 30 秒；超时升级、停止业务推进，忽略迟到结果，不把超时当作远端已经停止 | 2026-10-14 | 用户选择 30 秒；Q21 解除 |
| D21 | UserInteraction 五类 Gateway 调用也采用 30 秒返回期限；授权输入等待仍按 expiresAt，不套用端口期限 | 2026-10-14 | 用户明确同意；Q23 解除 |
| D22 | 继续完成本分支剩余实现并持续验证；用户离开期间遇到必须决定的事项先记录、跳过，继续其他独立工作；本轮只在本地修改，不提交或推送 | 2026-10-15 | 用户最新指令；替代上轮只对齐计划的工作范围，保留 Q08／Q09 既有授权 |
| D23 | 待决定的事项不构成结束全部工作的理由；继续本分支独立审计与实现，不等待用户回复，不自动提交 | 2026-10-15 | 用户再次要求持续工作；沿用既有修改边界 |
| D24 | 根 Readme 当前不修改，进入 feature/M1/main 后再同步；共享前缀哈希问题只记计划，暂不解决 | 2026-10-15 | 用户本轮决定；Q25、Q26 已决定后续处理方式 |
| D25 | 报告字段支持中文，用户语言至少兼容中文且可能随用户语言动态决定；Prompt 设计不属本分支，不修改 Prompt 或新增语言协议字段 | 2026-10-15 | 用户本轮语言与范围决定；Q27 转外部范围跟踪 |
| D26 | 展示层将具有控制作用的字符转成可见转义，保留正常中文、普通字符与必要换行，报告原文不变 | 2026-10-15 | 用户明确同意；Q34 实施依据 |
| D27 | 故障停止时结束尚在等待的本地控制请求并释放其期限；仍观察迟到拒绝，不将本地等待结束当成远端成功或停止确认 | 2026-10-15 | 用户选择 Q36 本地结束等待方案；不修改共同协议或其他分支产品 |
| D28 | 同意现在修复 fake Workflow／UserInteraction 的 deliver 校验与复制，并补齐共享边界测试；只改两个既有 fake 与对应共享测试，不改 Inbox、Fabric、Kernel 或共同协议 | 2026-10-15 | 用户明确同意建议并要求现在修改；解除 Q24 的修改范围阻塞，不包含提交或推送授权 |
| D29 | 整理本分支文档并按 Style.md 组织为三个有正文介绍的提交，推送当前远端工作分支，不创建 PR | 2026-10-15 | 用户最新明确授权，替代本轮此前只保留本地、不提交推送的限制；共享修改与分支计划仍各自独立，历史记录保留 |

### 6.3 已确认的规范补充

2026-10-14 用户已确认下列补充，并已写入对应模块规范。
Q07、Q10 按建议执行；Q08、Q09 仅授权所列测试范围，仍须独立提交，
不授权其他共享代码或其他分支产品代码的修改。

已写入 Workflow.md：

- Q01，第 8 节：确定下一次 model-call 为 final-call 后，在其 context-assemble 提交前，
  在当前 AgentRun 的 steps 中记录一条 `FEEDBACK(WRAP_UP_NOTICE)`。
  不带 `toolCallId`，`round = roundsUsed + 1`，message 说明已确定的 `wrapUpReason`。
  同一次 final-call 只记录一次；不发起 final-call 的降级路径不记录该反馈。
- Q02，第 6 节：重复调用比较使用同一 Unit 与 `canonicalJson(arguments)`；
  参数取模型给出的原始 JSON 对象，不补缺省值。对象键顺序不影响比较，数组顺序保留。
  `{ query: "a" }` 与 `{ query: "a", mode: "AUTO" }` 视为不同参数。
- Q06，第 10.1 节：同一来源范围被多次成功 file-read 覆盖时，选择 Workflow
  最早收到的、覆盖该来源的成功 UnitReport，记录其 requestId 与内容 SHA-256。
  不拼接多次读取的范围，不按 requestId 排序，也不依赖执行时间推断先后。

已写入 UserInteraction.md：

- Q03，第 5 节：用户可见文案使用中文（UTF-8），面向开发者的报错与源码注释使用英文；
  用户文案集中维护在 `InteractionMessages` 中。
  M1Interface 第 3.4 节的全部原因码均有对应说明；未收录的原因码使用通用说明。
  文案表还包含结束说明、授权超时与取消、未知效果、报告与摘要读取失败、摘要保存失败。
- Q04，第 5 节：报告读取得到 SyscallRejected 或报告未通过 AnalysisReport 校验时，
  显示“报告无法读取”，继续展示结束说明及其他可展示信息，最终退出码至少为 1，
  保留原有非零退出码，照常请求 shutdown。该结果不调用 reportSystemFault；
  读取调用本身抛错仍按第 6.1 节处理。
- Q05，第 5 节：`--details` 的摘要读取得到 SyscallRejected 或未通过 RunSummary 校验时，
  显示“运行摘要无法读取”，不改变退出码，照常请求 shutdown。
  该结果不调用 reportSystemFault；读取调用本身抛错仍按第 6.1 节处理。
  `finalizationError` 的保存失败说明与非零退出码规则保持适用，此时不读取摘要。

补充核对：Q09 的共享测试除第 7.17 节列出的投递与生命周期行为外，
还必须覆盖 M1Interface 第 13 节适用于 Inbox Port 的边界要求；不以四项行为测试代替全部契约要求。

## 7. 分步实施计划

每个阶段附带测试；退出条件成立并按第 8 节验证之后才标记完成。阶段按顺序进行，除非表中注明可以并行。
Workflow（T02–T10）与 UserInteraction（T11–T15）互不依赖，可以交替推进，但每个阶段内部要做完再切换。

| ID | 范围 | 退出条件 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T01 | 规范缺口的决定 | Q01–Q10 全部有用户决定；涉及规范的已写回 Workflow.md、UserInteraction.md | — | 已完成 |
| T02 | Workflow 骨架与测试替身 | `createWorkflow` 不再抛错；RunStart 后完成固定与 `registerAgentRun`；固定失败按 `PIN_FAILED` 结束 | T01 | 已完成 |
| T03 | 解释模型返回 | 第 5 节的全部分支有纯函数与测试 | T02 | 已完成 |
| T04 | Validation 与无进展检测 | 第 6 节五项检查、重复调用、`noProgressCount` 有测试 | T03 | 已完成 |
| T05 | 失败处理 | 第 7 节的两张表、最严重者规则、final-call 例外有测试 | T02 | 已完成 |
| T06 | Round、final-call 与额度状态 | 第 8 节的计数、触发条件、WRAP_UP 与 EXHAUSTED 的处理有测试 | T05 | 已完成 |
| T07 | 运行循环 | 启动 Unit、每一轮的组装与模型调用、工具轮的收齐在测试替身上跑通；UnitReport 先于 SyscallAck 的情况有测试 | T03–T06 | 已完成 |
| T08 | 交接 | Planner → CodeViewer 的完整顺序与 `BUDGET_WRAP_UP` 的继承有测试 | T07 | 已完成 |
| T09 | 报告 | 来源核验、正常报告、降级报告、发布与结束顺序有测试；产出的报告通过 Schema | T07 | 已完成 |
| T10 | 结束保证、运行记录与自身错误 | 第 11、11.1、13 节与 `stop()` 契约有测试；性质测试覆盖合法历史与关闭后不推进，故障守卫及调用期限有回归测试 | T08、T09 | 已完成 |
| T11 | UserInteraction 骨架与主流程 | `createUserInteraction` 不再抛错；`createRun` → RunFinished → 退出码 → `shutdown` 跑通；被拒时退出码 4 | T01 | 已完成 |
| T12 | 授权询问与中断 | 询问任务的四种结束方式、`QUESTION_NOT_PENDING`、第一次 Ctrl+C 有测试；Inbox 不被用户输入阻塞 | T11 | 已完成 |
| T13 | 结果展示 | 报告视图、文案表、未知效果、摘要保存失败、`--details` 有测试 | T11 | 已完成 |
| T14 | 自身错误与关闭 | 三处捕获边界与 `stop()` 契约有测试 | T12、T13 | 已完成 |
| T15 | CLI 适配 | 终端适配器的行为有测试；CLI 只经公开入口调用 | T12 | 已完成 |
| T16 | 系统级组合测试 | 真实的两个模块配合 fake Kernel 经 `composeSystem` 跑通全部结束方式与故障注入 | T10、T14、T15、Q08 | 已完成 |
| T17 | Inbox Port 的共享 contract test | fake 与产品实现通过同一组用例 | T10、T14、Q09 | 已完成 |
| T18 | 文档同步与首次合入 | 规范与实现一致；导出分支的 PR 合入 `feature/M1/main`；本分支完成同步 | T16、T17 | 进行中 |
| T19 | 真实链路联调与业务验收 | 真实 Kernel、真实 Executor 与真实模型下完成 M1Plan 5.2、5.3 中属于本分支的退出条件；第二次合入 | T18，以及第 4.2 节的三项 | 等待中 |

T18 是本分支第一次合入 `feature/M1/main`，不等待其他分支。T19 依赖其他分支的交付：它们没有进入
`feature/M1/main` 之前 T19 保持“等待中”，并在第 10.2 节记录等待的内容，不以 fake 通过代替。

T16 上轮只完成真实 UserInteraction、fake Workflow、fake Kernel 与真实组合根的 3 项故障测试；
本轮新增两个真实模块同时装配的业务、终态、记录与故障组合验收；最新验证见第 10.3 节。

### 7.1 T01 规范缺口的决定

- 把第 6.1 节的问题逐条向用户确认。可以一次提出全部问题。
- 需要写回规范的：Q01、Q02、Q06 写入 Workflow.md；Q03、Q04、Q05 写入 UserInteraction.md。Q07、Q10 只影响实现，
  决定记入第 6.2 节即可。Q08、Q09 是流程决定。
- 只改文档，不改代码。验证只做格式与链接检查。

### 7.2 T02 Workflow 骨架与测试替身

规范：Workflow 第 2、4、9.1 节；M1Interface 第 4、5、9.3、14.2 节。

- 建立目录（建议，见第 7.20 节）：`domain/` 放纯函数与类型，`application/` 放 Inbox 消费、syscall 发起与记录写入。
- 定义运行状态类型（Workflow 第 4 节列出的全部字段）、reducer 的输入与动作类型。先只实现 RunStart 一条路径。
- 实现工厂：构造 `Inbox`（`dedupeKey` 用 `eventId`，`onError` 接 `reportSystemFault`）、`inbox.deliver`、
  `start`、`stop`、`health`、`manifest`。
- 实现 RunStart → `pinAgent(entryAgentRef)` → 有 `handoffTargetRef` 时固定目标并核对 digest →
  `registerAgentRun`。
- 写模块内的测试替身：一个可脚本化的 `WorkflowGatewayPort`，记录每个请求，并能按脚本回 SyscallAck、
  SyscallRejected 与投递 UnitReport、RunClosed（包括先投递 UnitReport 再返回 Ack）；一个内存的 `PersistencePort`；
  一个由固定值构成的 `CatalogPort`。它们只在本模块的测试中使用。
- 测试：固定成功；入口固定失败；目标固定失败；目标 digest 不符；`registerAgentRun` 被拒；重复的 `eventId` 被丢弃。

### 7.3 T03 解释模型返回

规范：Workflow 第 5 节；M1Interface 6.4、6.6。

- 纯函数：`ModelCallOutput` 加上固定集合与“是否 final-call” → `AnalysisAction`。
- 覆盖：空 `toolCalls`（`LENGTH` 与其他）；控制工具与其他调用混合；finish 参数合法与不合法；
  handoff 在没有 `actions.handoff` 的 Agent 上、在 final-call 中、参数不合法；纯 UNIT 工具调用。
- 工具名以 `ToolDefinition.modelName` 匹配；`purpose` 区分 UNIT 与 CONTROL；参数校验经 `ProtocolRegistry`。
- `arguments` 为 null（`argumentsError`）的控制工具调用按参数不合法处理。

### 7.4 T04 Validation 与无进展检测

规范：Workflow 第 6 节。依赖 Q02。

- 纯函数：一组 TOOL_CALLS 加上当前状态 → 通过的调用（含对应的 Unit）与 FEEDBACK 列表。
- 五项检查按表中顺序；`TOO_MANY_TOOL_CALLS` 只计 UNIT 工具调用的序号。
- 重复调用：只与本 AgentRun 内成功执行过的调用比较；先前结果的 `requestId` 在最近一次 `elidedRequestIds` 中时不算重复。
- 无进展：一轮结束时没有任何新的 OK 结果则加 1（INVALID 轮同样计入），否则清零；达到 `noProgressRounds` 时设置 `NO_PROGRESS`。
- 边界：Planner 的 `maxToolCallsPerRound` 为 0，任何 UNIT 工具调用都不通过。

### 7.5 T05 失败处理

规范：Workflow 第 7 节；Kernel 第 10 节；AgentToolPool 4.2。

- 纯函数：原因码加 Unit 定义 → 四种处理之一，未列出的为 FATAL；一组处理 → 最严重者。
- final-call 的 model-call 失败不查表，一律 DEGRADED_REPORT。
- `FINAL_CALL` 处理设置的 `wrapUpReason`（`USER_DECLINED`、`BUDGET_WRAP_UP`）；工具 Unit 同时记录 TOOL_RESULT。
- SyscallRejected 的两种处理；`failure` 的三个必填字段，`category` 取 `REASON_CODE_CATEGORY`，
  `source` 恒为 `WORKFLOW`。
- 用目录中真实的六个 Unit 定义的 `failurePolicy` 做表驱动测试，防止实现与定义脱节（只读取，不修改定义）。

### 7.6 T06 Round、final-call 与额度状态

规范：Workflow 第 8 节；Kernel 第 8 节。依赖 Q01。

- `roundsUsed` 只在 model-call 的 UnitReport 为 OK 或 FAILED 时加 1；被 `BUDGET_WRAP_UP`、`BUDGET_EXHAUSTED`、
  `FINAL_CALL_USED` 拒绝的不计。
- 下一次是否为 final-call 的判断；多个原因保留最先设置的。
- WRAP_UP：设置 `BUDGET_WRAP_UP`，本轮已提交的工具 Unit 照常收齐。
- EXHAUSTED：合法 FINISH 照常进入正常报告；FATAL 只走 FAILED 错误路径；其余情况降级。
- final-call 的结果不是合法 FINISH（INVALID、失败）时生成降级报告，`wrapUp.reason` 为触发该 final-call 的原因。

### 7.7 T07 运行循环

规范：Workflow 第 4、9.1 节；Kernel 4.4。

- 把 T03–T06 的纯函数接入 reducer：启动 Unit 逐个提交；每一轮 `context-assemble` → `model-call` → 动作。
- `ContextAssembleInput`：`objective`、`final`、`orientPackRef`、`steps`
  （本 AgentRun 的全部 StepRecord，按发生顺序）、`status`。
- StepRecord 的记录：MODEL_TURN、每个工具结果的 TOOL_RESULT、每条 FEEDBACK；`round` 从 1 开始。
- 待收集合按 `requestId` 管理；UnitReport 先于 SyscallAck 到达时不得丢失或重复处理。
- 应用层只做三件事：从 Inbox 取事件交给 reducer、执行 reducer 给出的动作、把 syscall 的返回值再交给 reducer。
  业务判断不得出现在应用层。
- 测试：单个 Agent 的多轮（工具轮 → FINISH 之前的全部步骤）；启动 Unit 被拒（`USER_DECLINED` 使第一轮即 final-call）；
  Ack 与 Report 的两种到达顺序；一轮多个工具 Unit 的乱序返回。

### 7.8 T08 交接

规范：Workflow 9.2。

- HANDOFF → `endAgentRun(Planner)` → `registerAgentRun(CodeViewer)`
  （新的 `agentRunId`，`agentRef` 为已固定的目标）→
  CodeViewer 的启动 Unit → 第一轮的 `context-assemble` 携带 `handoff`。
- CodeViewer 的 `roundsUsed`、`steps`、计数器从零开始；Planner 的 AgentRun 不再恢复。
- 携带 HANDOFF 的 model-call 同时使 `budgetState` 变为 WRAP_UP 时，`BUDGET_WRAP_UP` 带入 CodeViewer，
  启动 Unit 之后直接 final-call；其他 `wrapUpReason` 不继承。
- 测试：正常交接；交接中任一 syscall 被拒；继承的情况；Planner 在 final-call 中不能交接（T03 已覆盖解释，这里覆盖流程）。

### 7.9 T09 报告

规范：Workflow 第 10 节；M1Interface 1.4、6.5、6.6。依赖 Q06。

- 来源核验为纯函数：草稿加上已读取的 `FileReadOutput` 列表 → 已核验结论与未确认项。
  覆盖指同一次读取的路径相同且 `[startLine, endLine]` 包含来源范围。
- 组装 AnalysisReport：`readSources` 为全部成功读取的非空行范围；空文件留在私有记录，
  summary 按唯一空文件路径数量注明，不作为结论来源（D18）；
  `wrapUp` 在设置了 `wrapUpReason` 时填写；
  `agentRounds` 每个 AgentRun 一项；`snapshotId` 在 orient 成功时填写。
- 降级报告：固定说明、两个列表为空、`degraded = true`、`wrapUp` 必填。
- 发布顺序见 R-W17；`report-publish` 失败按 FATAL。
- 测试：三种未确认原因；部分来源未覆盖的结论整体降为未确认；Planner 直接 FINISH（没有任何读取）；
  降级报告的两种触发；产出的每个报告都用 `AnalysisReportSchema` 校验。

### 7.10 T10 结束保证、运行记录与自身错误

规范：Workflow 第 11、11.1、13 节；SystemFaultHandling 2.2、第 4 节。依赖 Q07。

- RunClosed 的五种 `closeReason` 到业务终态的映射；`unknownEffects` 写入记录。
- `WorkflowRunRecord` 的两次写入与全部字段。
- 自身错误的两层处理（R-W19）：可由运行吸收的异常先写脱敏诊断，再尝试 `closeRun`；
  诊断或关闭失败、无可用运行状态、关闭后再出错时，由 Inbox 的失败观察者上报。
- Gateway、Catalog、Persistence 每次调用最多等待返回 30 秒，超时直接升级，不在同级重试；
  不把调用超时当作远端已停止，迟到结果不恢复业务。故障后只处理已有运行的终态与记录。
- `stop()`：等待 Inbox 排空；重复调用与未启动时调用安全。
- 性质测试（fast-check）：在替身提供对应返回与终态的条件下，以固定种子生成合法模型历史，
  核对有界循环、终态以及收到 RunClosed 后不再发起 syscall；挂起调用另用假定时器验收。
  不把有限随机样本当作真实 Kernel、全部事件排列或远端停止的证明。
- 测试：RunClosed 在任意阶段到达（包括有待收的 UnitReport 时）；记录写入失败；reducer 抛错；`closeRun` 也抛错。

### 7.11 T11 UserInteraction 骨架与主流程

规范：UserInteraction 第 2、3、6 节；M1Interface 第 4、5.3、14.2 节。

- 工厂、Inbox、生命周期同 T02 的做法。写模块内的测试替身：可脚本化的 `InteractionGatewayPort` 与记录输出的终端。
- `analyze`：`createRun`；被拒时显示原因并返回 4；成功后等待 RunFinished；记录退出码；`shutdown`；返回。
- 退出码：`EXIT_CODES[closeReason]`，带 `finalizationError` 时取它与 1 中的较大者。
- 本阶段最初接入结束说明；当前已由 T13 的完整中文视图替代，不直接向用户输出协议码。
- 测试：五种 `closeReason` 的退出码；`finalizationError` 与各 `closeReason` 的组合；`createRun` 被拒。

### 7.12 T12 授权询问与中断

规范：UserInteraction 第 3、4 节；Kernel 第 7 节。

- 询问任务独立于 Inbox 的处理：处理 AuthorizationRequest 时启动它并立即返回。
- 任务用 `AbortController` 结束 `askYesNo`；在 `expiresAt` 设置定时器，到期时结束且不提交回答。
- 回答经 `answerAuthorization` 提交；`QUESTION_NOT_PENDING` 只关闭询问。
- AuthorizationResolved 与 RunFinished 撤销仍在等待输入的任务；TIMED_OUT、CANCELLED 显示说明。
- 中断：`terminal.onInterrupt` 注册的处理在运行中调用 `cancelRun`；`analyze` 结束时移除处理。
- 测试必须证明 Inbox 不被阻塞：用户迟迟不回答时，后续的 AuthorizationResolved 与 RunFinished 仍被处理。
  定时器使用可注入的时钟或 vitest 的假定时器，测试不得依赖真实等待。

### 7.13 T13 结果展示

规范：UserInteraction 第 5 节；Kernel 第 9 节；M1Interface 6.6、第 11 节。依赖 Q03、Q04、Q05、Q10。

- 视图为纯函数：`AnalysisReport` → 文本；`RunSummary` → 文本；`RunFinished`（没有报告时）→ 文本。
- `InteractionMessages`：`closeReason` 的结束说明、`failure.code` 的说明与通用说明、未知效果、摘要保存失败、
  授权超时与取消的说明。
- 读取：`readArtifact(reportRef)` 后先按 `AnalysisReportSchema` 校验；`--details` 时读取并校验 RunSummary。
- 展示顺序：报告（如有）→ 结束说明 → 未知效果 → 摘要保存失败 → RunSummary（如要求且可读）。
- 测试：Kernel 第 9 节表中九种结束方式各一个；降级报告；带 `wrapUp` 的正常报告；`failure.detail` 不出现在输出中；
  未收录的原因码；视图的快照测试。

### 7.14 T14 自身错误与关闭

规范：UserInteraction 第 6、6.1 节；SystemFaultHandling 2.2。

- 三处捕获边界各自上报（R-U12），`source` 为 `user-interaction`，带 `workflowRunId`（已知时）。
- createRun 抛错或超时由组合根命令入口捕获；已记录结果后的 shutdown 抛错、超时或异常拒绝
  通过既有回调上报，并返回已记录退出码，以便组合根保留非零码；没有回调时抛错。
- 五类 Gateway 调用每次最多等待返回 30 秒；询问用户的期限仍为 expiresAt。
  合法控制请求的异常拒绝升级，QUESTION_NOT_PENDING 保持普通失效结果，不重试。
- 询问任务与中断处理是脱离 Inbox 的异步任务，必须自带捕获，不得产生未处理的 Promise 拒绝。
- `stop()` 先处理完 Inbox 中剩余的事件，保证 RunFinished 一定被展示；撤销仍在进行的询问任务与定时器。
- 测试：三处各注入一次抛错并断言上报内容；没有注入上报函数时 `stop()` 失败；`stop()` 的重复与提前调用。

### 7.15 T15 CLI 适配

规范：UserInteraction 第 3 节；M1TechStack 第 4 节；SystemFaultHandling 第 6 节。

- 核对 `createNodeTerminal`：`askYesNo` 在信号触发时结束并关闭 readline；`onInterrupt` 只转发 SIGINT，返回的函数能移除监听。
- 用可注入的输入输出流为终端适配器补测试（回答 y、n、无效输入后重问、被中止）。
- 不新增命令与选项；M1 只有 `analyze --repo <绝对路径> [--details] "<目标>"`。
- 进程入口与信号不在本分支：它们在 `apps/control-plane`，已经实现。

### 7.16 T16 系统级组合测试

规范：SystemFaultHandling 第 8 节；M1Plan 第 5.1 节的退出条件。依赖 Q08。

- 用 `composeSystem` 装配真实的 Workflow 与 UserInteraction，其余为 fake（Kernel、Executor），终端为 fake。
- 用 `FakeKernelOptions` 覆盖：正常完成（含交接）、用户拒绝授权、授权超时、`createRun` 被拒、运行超时、安全违规、
  用户中断、WRAP_UP 后 final-call、EXHAUSTED 后降级报告、摘要写入失败、未知效果。
- 每个用例断言三方面：Workflow 收到的事件与发出的 syscall 顺序；用户看到的文本与退出码；运行目录中的报告与运行记录。
- 故障注入：Workflow 的 reducer 抛错（运行以 `WORKFLOW_INTERNAL` 结束，退出码 1）；UserInteraction 的 Inbox 处理器抛错
  （故障关闭，退出码非零，全部模块停止）。
- fake Kernel 不校验 Unit 输入、没有 Lease 与额度账本，这里的通过不能证明 Kernel 行为，只证明两个模块与接缝。

### 7.17 T17 Inbox Port 的共享 contract test

规范：M1Interface 第 13 节。依赖 Q09。

- 在 `packages/testing/src/harnesses` 增加 `WorkflowInboxPort` 与 `InteractionInboxPort` 的共享用例，
  同时对 fake 与产品实现运行：`deliver` 即刻返回、重复 `eventId` 只处理一次、按到达顺序处理、
  `stop()` 之前排空。
- 这是共享接缝的修改，单独提交。

### 7.18 T18 文档同步与首次合入

- 对照第 5 节逐条核对实现与测试，结果记入第 10.3 节；发现的规范偏差要么修实现，要么经用户决定修规范。
- 更新 Workflow.md、UserInteraction.md 中与实现不一致的描述；检查 M1 README 与根 README 中关于“尚未实现”的说法。
- 把 `apps/control-plane` 中“产品部件未实现时快速失败”的测试是否仍然成立告知用户（Kernel 核心未实现时它仍成立）。
- 按第 9.3 节建立导出分支并提 PR；合并后本分支同步 `feature/M1/main`。
- PR 说明按 Style 第 6.2 节：目标与范围、主要变更、对其他分支的影响、验证、风险与回滚。

### 7.19 T19 真实链路联调与业务验收

前提：产品 Kernel 核心、真实的 Executor 已进入 `feature/M1/main`，本分支已同步；Prompt 与 Tool 描述已有可用版本。

- 先以真实 Kernel 与真实 Executor、但模型为确定性的替身运行 T16 的全部用例，修正只在真实 Kernel 下暴露的问题
  （Unit 输入校验、额度状态的真实时序、授权的真实时序）。
- 再用一个真实 provider 完成 M1Plan 5.2 的退出条件：对已知文件的分析引用来源；写入、命令与测试请求被拒绝。
- 然后完成 M1Plan 5.3 中属于 Workflow 的部分：首次证据不足后补充检索；来源一致性；工作区保持不变。
- 用固定任务集校准 `maxRounds`、`maxToolCallsPerRound`、`regenerationLimit`、`noProgressRounds`。
  前两个在 Agent 定义中，属于 meti 的范围，只提出建议；后两个在 `WorkflowConfig` 的缺省值中。
- 涉及真实模型的运行必须记录 provider、模型、配置、定义的 digest、commit、token、成本与耗时；
  质量门不得依赖真实模型或外部网络。密钥只从环境变量读取，不进入本文、日志或产物。
- 完成后第二次合入 `feature/M1/main`。固定任务集 F1–F5 的正式验收与发布属于整个 M1，不在本文范围。

### 7.20 建议的目录

目录是建议，不是规范；领域层为纯函数、应用层不含业务判断是要求（R-W1、M1TechStack 第 6 节）。

```text
packages/modules/workflow/src/
  domain/         state、analysis-action、validation、failure-policy、rounds、
                  source-verification、report、run-record、reducer
  application/    workflow-runner（Inbox 消费与动作执行）、run-record-store
  test-support/   可脚本化的 Gateway、内存 Persistence、固定的 Catalog
  index.ts        工厂与公开类型

packages/modules/user-interaction/src/
  domain/         exit-codes、interaction-messages、report-view、summary-view
  application/    interaction-runner（analyze 与 Inbox 消费）、question-task
  ports/          terminal-port
  test-support/   可脚本化的 Gateway、记录输出的终端
  index.ts        工厂与公开类型
```

## 8. 验证规则

- 每个阶段的实现都附带单元测试；修复缺陷先写可复现的测试。测试必须确定：不依赖真实时间、网络或真实模型。
- 提交前必须通过 `pnpm run build`、`pnpm run check`（格式、lint、类型、全部测试）与 `git diff --check`。
- 验收平台是 Ubuntu LTS。本机是 Windows，正式验证在 WSL 的 `Ubuntu-24.04` 中进行：
  1. 用当前分支 HEAD 的 `git archive` 在 WSL 临时目录生成隔离副本；
     如有尚未提交的本轮文件，只覆盖明确属于本轮且在授权范围内的路径。
     不为生成验证副本暂存、重置或切换当前工作区。
  2. 在隔离副本运行 `pnpm install --frozen-lockfile`、`pnpm run build`、`pnpm run check`；
     本地缓存完整时可以增加 `--offline`。不覆盖、切换或清理 `~/MultiAgentOS` 的其他分支工作。
  3. WSL 中使用它自己安装的 Node 与 pnpm（登录 shell 的 PATH 已设置），不要使用 `/mnt/c`、`/mnt/d` 下的 Windows 版本。
  4. 需要 `sudo` 的操作请用户执行。
- 原生 Windows 上有一个与本分支无关的已知失败（`agent-tool-pool` 的符号链接测试，`EPERM`），在 Ubuntu 上通过；
  不要为了它修改 `agent-tool-pool`。
- 验证记录写明命令、环境（Windows、WSL、CI）、通过、失败或未运行，以及限制；没有测试证据不标记完成。
- 只改文档时不新增业务测试；提交前仍按 Style.md 第 2.4 节运行完整质量门，
  另外核对文档格式、链接与差异，记录本次实际运行的结果。

## 9. 提交、推送与合入

### 9.1 提交

- 不自动 commit、push 或创建 PR；每次都等用户明确要求。用户要求提交时，按阶段或按逻辑变更提交，不把多个阶段压成一个。
- Conventional Commits，说明用中文；实现新能力并附带测试与文档时用 `feat:`，只改文档用 `docs:`，只加测试用 `test:`。
- 提交正文说明问题、实际变化、关键边界与验证，参考已有提交的条目格式；
  本次按用户要求整理为三个提交，不改写已经完成的提交历史，具体范围见第 10.9 节。
- 每个提交必须可构建、可测试。提交说明不使用本文的编号。
- 共享接缝的修改单独提交（第 2.2 节）。

### 9.2 同步

- 只从 `feature/M1/main` 同步，使用 merge，不 rebase；不直接合并其他工作分支。
- 本分支被其他分支合并之后不再改写历史。
- 每次同步之后在 Ubuntu 上运行一次完整的质量门。

### 9.3 合入 `feature/M1/main`

本文不进入 `feature/M1/main`，因此 PR 不能直接从本分支发出：

1. 确认本分支已同步 `feature/M1/main` 的最新提交。
2. 在 `feature/M1/main` 的最新提交之上，逐个重放本分支自上次导出以来的提交，每个提交的内容去掉本文；
   提交说明中提到本文或其编号的行一并去掉。得到的导出分支与本分支只差本文这一个文件。
3. 推送导出分支，向 `feature/M1/main` 提 PR，使用 merge commit 合并。
4. 合并后本分支同步一次 `feature/M1/main`（两边对其余文件的改动相同，会干净合并，本文保留在本分支）。
5. 删除已合并的导出分支。

2026-10-13 kernel 分支的首次合入（`CaryHe-maker/MultiAgentOS` 的 PR 23）用的就是这个做法。

## 10. 进度

### 10.1 当前继续点

- 当前完成：T01–T17，共 17 项；实现、测试与模块规范已提交，本文随第三个提交同步。
  当前三提交的范围、授权与验证见第 10.9 节；T18 的合入条件仍未满足。
- T15 修复 EOF 后询问不结束、流错误缺少观察和 CLI 英文提示；新增终端测试，保留既有命令与入口签名。
- T16 新增 27 项组合测试；两个真实模块配合 fake Core／Executor，另覆盖真实 CLI／终端与清理故障。
- T17 已完成：真实 Workflow、UserInteraction 与两个 fake 通过同一组 44 项 Inbox 契约测试。
  覆盖直接非法投递拒绝、事件复制、Unsupported 无副作用、合法 Schema 发错 Inbox、
  即时确认、去重、到达顺序、停止排空，以及 Fabric 的额外字段、未知 major 和消息复制。
- T18 正在逐条对照要求与已有测试；Q25 按用户要求留到集成后，首次合入仍需用户明确授权。
  T19 等待第 10.2 节的交付，不以替身测试代替真实联调。
- Q24 已按 D28 授权修复；Q25 集成后处理、Q26 暂缓、Q27 留给 Prompt 负责人。
  Q34、Q36 已按用户决定实现并验证；此前修复保留，见第 10.5 节。
  用户离开期间对待决定事项先记录、跳过，继续独立工作。
- 按 D23 持续审计：已补终端关闭状态的 5 项修复与真实 CLI／终端的 5 项组合测试；
  已修复长授权期限、清理失败与 undefined 拒绝的遗漏；补清理故障组合与 32 工具上限验收。
  不把待决定事项当成停止全部工作的条件，继续本分支审计与本地准备。
- 已提交：Workflow 为 `f586fc8`、UserInteraction 为 `b33a16e`、组合故障测试为 `b78139d`、
  上轮计划对齐为 `20fd7a3`；本轮从 `57dc85d` 继续，修复提交为 `c3d6a9a`、`be6e740`。
  用户已授权当前工作分支的三个提交与推送；没有 PR、导出或合并授权，本文不得进入集成分支。

### 10.2 等待其他分支的事项

| 事项 | 等待的内容 | 影响阶段 | 状态 |
| --- | --- | --- | --- |
| 产品 Kernel 核心与执行派发 | kernel 分支的后续阶段进入 `feature/M1/main` | T19 | 等待中 |
| 真实的五个 Executor | pool-executor 分支进入 `feature/M1/main` | T19 | 等待中 |
| Prompt 正文与 Tool 描述定稿 | Cary 与 meti | T19 | 等待中 |

### 10.3 完成与验证记录

每完成一个阶段追加一行；记录实际修改的文件、关键不变量与验证证据，不只写“完成”。
下表按发生顺序保留历史；当前状态以第 1.2、7、10.1 节为准，历史“下一步”不作为现行待办。

| 日期 | 阶段 | 实际变更 | 验证与环境 | 下一步 |
| --- | --- | --- | --- | --- |
| 2026-10-13 | 建立计划 | 创建本文；分支已同步到 `ac368ad` | 只有文档变更，未运行业务测试；基线提交已在 CI（Ubuntu 24.04）通过质量门 | T01 |
| 2026-10-14 | T01 进行中 | 完整阅读计划，核对模块规范、错误处理与 contracts；修正 HEAD 记录，准备第 6.3 节待审草案；未修改规范或代码 | Windows：`git diff --check` 通过；UTF-8 无 BOM、LF、行尾与草案行宽检查通过；10 个本地链接目标存在；仓库 Prettier 配置忽略 docs，未运行业务测试 | 等待 Q01–Q10 的用户决定 |
| 2026-10-14 | T01 已完成 | 完整重读 Style.md；记录 Q01–Q10 的用户决定；Q01、Q02、Q06 写回 Workflow.md，Q03、Q04、Q05 写回 UserInteraction.md；协议标识不改 | Windows：文档格式、链接与差异检查；模块规范修改纳入后续 Ubuntu 验证副本 | T02 |
| 2026-10-14 | T02 已完成 | 新增 domain/state.ts、domain/reducer.ts、application/workflow-runner.ts 及其测试，index.ts 接入工厂；新增固定 Catalog、内存 Persistence、可脚本化 Gateway 与合法定义 fixture；固定失败不登记，目标核对 digest；去重、投递只入队、停止排空；抛错先关闭，关闭也失败才升级 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、`pnpm run build`、`pnpm run check` 通过，36 文件/303 测试，其中新增 15 测试；Windows 全仓构建有既有类型错误，未改共享代码；`git diff --check` 通过 | T03（Q11 已因用户更正解除） |
| 2026-10-14 | 语言要求更正；T03 进行中 | 根据用户更正将本轮 Workflow 报错、诊断与源码注释恢复英文，用户内容保留中文（UTF-8）；同步两个模块规范和 Q03/D13，Q11 解除；核对实际 Planner/CodeViewer 定义与 PinnedDefinitionSet.tools，发现 Q14；未按未定规则编写解释器 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、`pnpm run build`、`pnpm run check` 再次通过，36 文件/303 测试；Windows：`git diff --check`、文档 UTF-8 无 BOM/LF/空白检查与 24 个本地链接检查通过；未修改共享及其他分支代码 | 用户决定 Q14 后继续 T03 |
| 2026-10-14 | T03 已完成 | 新增 domain/analysis-action.ts 与测试，补 Workflow 第 5 节；依据固定 modelName/purpose 与当前 actions 解释返回，按 ProtocolRegistry 校验控制参数；覆盖五种 INVALID、混合调用、无 handoff 权限、final-call、参数解析失败与 UNIT 调用 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、全仓 build、Workflow lint 与模块测试通过；新增 21 测试，模块共 36 测试 | T04 |
| 2026-10-14 | T04 已完成 | 新增 domain/validation.ts、domain/progress.ts 及测试；五项检查按顺序，UNIT 限额只计当前已知 UNIT；重复比较原始参数 canonicalJson 与固定 Unit 身份，忽略已裁剪结果；计数器更新保留最先收尾原因 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、全仓 build、Workflow lint 与模块 54 测试通过，其中新增 18 测试 | T05 |
| 2026-10-14 | T05 已完成 | 新增 domain/failure-policy.ts 与测试，reducer 复用 syscall 拒绝处理与 RunFailure 构造；四级严重度、未列原因按 FATAL、final model-call 一律降级；只读加载六个真实 Unit 的策略字段并拒绝未支持的 fixture 语法 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、全仓 build、Workflow lint 与模块 81 测试通过；失败策略新增 14 测试，未修改定义文件 | T06 |
| 2026-10-14 | T06 进行中 | 新增 domain/rounds.ts 与 13 测试，覆盖 Round 计数、最后一轮 final-call、已有原因保留、WRAP_UP 指令、EXHAUSTED 下合法 FINISH 与降级、final-call 不合法即降级；组合顺序待 Q15，尚未接入运行循环，未标记阶段完成 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、`pnpm run build`、`pnpm run check` 全部通过，41 文件/369 测试，其中 Workflow 6 文件/81 测试；Windows：文档编码/链接/空白、源码行宽及分支计划引用隔离检查与 `git diff --check` 通过 | 用户决定 Q15 |
| 2026-10-14 | T06 进行中（预算优先已实现） | Workflow 第 8 节补 Q15 的处理顺序；rounds.ts 新增 applyBudgetFacts 与 prepareRound，保留已有原因、final-call 只预留一次、上下文组装前记录单条 WRAP_UP_NOTICE，EXHAUSTED 不记 notice；新增同条预算/计数器竞争、已设原因、单次预留与协议允许的 FATAL+EXHAUSTED 证据测试；发现 Q16，未自行选择冲突终态 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、`pnpm run build`、`pnpm run check` 全部通过，41 文件/374 测试，其中 Workflow 6 文件/86 测试；Windows：文档编码/链接/空白、源码行宽与分支计划隔离检查、`git diff --check` 通过 | 用户决定 Q16 |
| 2026-10-14 | T06 进行中（失败报告交付待授权） | 按 D16 补失败与额度组合判定、中文降级报告纯函数及 8 项测试；报告明确最终失败，不包含内部 detail 或虚构结论；修订 Workflow 规范。为本次决定提前准备 T09 的纯报告构造，不代表 T09 完成。发现 Q17，共享协议不允许失败报告引用；未修改共享或 Kernel 代码，未接入运行循环与报告交付 | Ubuntu-24.04 隔离副本：build 与完整 check 通过，43 文件/382 测试，Workflow 8 文件/94 测试；只读 Schema 校验确认失败携带报告被拒。Windows 文档编码/链接/空白、源码行宽与计划引用隔离、git diff --check 通过 | 用户授权 Q17 的最小共享接缝变更 |
| 2026-10-14 | T06 已完成；T07 进行中 | 按 D17 移除 FAILED 的报告原因与终态失败报告构造分支，保留原有降级路径；规范明确 FATAL 优先只传 failure。新增 Unit 循环纯状态机与 12 测试，覆盖顺序启动、上下文与模型、多轮工具乱序收齐、重复反馈、预算先于计数器、FATAL+EXHAUSTED 只返回错误、final-call 例外。尚未接入工厂或 syscall 回流，不标 T07 完成；发现并记录 Q18 空文件来源不兼容，未自定业务例外 | Ubuntu-24.04 隔离副本：锁定依赖离线安装、build 与完整 check 通过，44 文件/394 测试，其中 Workflow 9 文件/106 测试；Windows：文档 UTF-8/LF/链接、源码行宽与计划引用隔离、git diff --check 通过。最终检查后只缩短测试标题与更新计划，无行为变化 | 用户决定 Q18；继续 T07 工厂接入与 Ack/Report 次序测试 |
| 2026-10-14 | T07–T10 已完成 | 工厂接入分析循环、交接、来源核验、空文件映射、报告发布与终态记录；覆盖 Ack/Report 次序、工具乱序结果与固定种子合法历史 | Ubuntu-24.04 隔离副本 build 与完整 check 通过：47 文件／421 测试，Workflow 12 文件／133 测试；后续审计缺口由下一行记录的修复补齐 | T11 |
| 2026-10-14 | T10 故障补全；T11–T14 已完成；T16 进行中 | `f586fc8` 完成 Workflow 故障守卫、调用期限及脱敏诊断；`b33a16e` 接入交互工厂、授权、中文视图、退出码与故障升级；`b78139d` 新增 3 项真实交互配合 fake Workflow/Kernel 的组合根故障测试 | Ubuntu-24.04 隔离副本 build 与完整 check 通过：50 文件／462 测试；Workflow 138、UserInteraction 33、新增组合故障测试 3 项。尚无真实 Kernel/Executor 联合验收证据 | T15，之后补齐 T16、T17 |
| 2026-10-14 | 本分支计划对齐 | 只更新本文：统一 14 项完成与 5 项未完成、Q19–Q23 当前处理状态、历史记录标签、完成证据和已提交信息；修正 T18/T19 依赖与隔离验证流程，不新增实现或 Issue 方案 | 本次重新运行 Ubuntu-24.04 隔离副本 build 与完整 check，50 文件／462 测试通过；Windows 文档 UTF-8 无 BOM、LF、行宽、10 个本地链接及 git diff --check 通过 | 按用户授权作带正文的独立 docs 提交；后续实现继续点为 T15 |
| 2026-10-15 | 新基线核对 | 只读查看远端本分支最新提交；远端与本地 HEAD 均为 57dc85d，已含共享排除规则、上下文前缀及历史配对约定。继续使用当前 checkout，不修改其他分支 | 检查 git status、最近提交与 gh API；初始工作树干净。没有 fetch／merge／push 或新增依赖 | 按 D22 继续本地实现 |
| 2026-10-15 | T15 已完成 | 新增 Node 终端 14 项测试，补 CLI 中文帮助与错误回归，解析器共 11 项；修复 EOF、输入／输出错误与同步提示失败的资源清理。未改 CLI 公开签名、选项或进程退出职责 | 先新增复现测试并观察失败，再修复；最终 Ubuntu-24.04 全仓 build／check 通过，54 文件／542 测试，CLI 25 项通过 | 本地保留，不提交 |
| 2026-10-15 | T16 已完成 | 只新增组合测试文件，19 项两个真实模块场景覆盖交接、搜索／读取与来源、非法 handoff、工具反馈、授权拒绝／超时、创建拒绝、全部终态、预算收尾、final-call 失败、未知效果、私有运行记录、脱敏诊断与双层故障关闭 | 同一完整质量门通过；新组合 19 项，既有交互故障组合 3 项继续通过。每次上下文提交均检查工具调用有结果或反馈；真实 Core／Executor 尚未验收 | T17 的 Q24，继续 T18 本地准备 |
| 2026-10-15 | T17 待决定 | 只新增 harness 与测试文件，四个实现各 6 项，共 24 项通过；补产品自身直接拒绝非法输入与发布后复制的 4 项测试。临时实验证明两个 fake 接受缺少合法 event 的输入，随后 stop 失败，产品则在入队前拒绝 | Ubuntu 全仓质量门通过；未用 skip／预期失败隐藏差异，未改既有 fake、testing/index.ts 或 Fabric 产品代码 | 用户决定 Q24 后补完整 Unsupported 共享验收 |
| 2026-10-15 | T14 追加故障审计修复 | 按原 30 秒规则跟踪在途授权回答和取消请求，在正常命令返回前观察；终态先到仍不能把故障留到停止后。无回调时保留 analyze／stop 的错误可见性；不等待用户输入、不更改组合根 | 两项新增回归先失败，修复后四项控制收尾回归通过；最终 Workflow 140、UserInteraction 39、CLI 25、共享 Inbox 24、新旧组合 22 项，共 250 项定向测试通过；全仓 54 文件／542 项通过 | 本地保留；Q28、Q29 已处理 |
| 2026-10-15 | T18 本地准备 | 同步 UserInteraction 的 CLI 文案、EOF、流异常与控制请求关闭说明；第 10.7 节逐条核对共同、Workflow 与交互要求。记录 Q24–Q27 的证据、边界、建议和未修改文件 | Ubuntu-24.04 锁定依赖离线安装、pnpm run build、pnpm run check 通过；Windows 对 13 个改动文件的 UTF-8／LF／行宽／空白／计划引用隔离、18 个文档本地链接及 git diff --check 通过 | Q24–Q27 待决定；本轮无 commit／push／PR／合并，T19 等待其他分支 |
| 2026-10-15 | 持续审计与本地修复 | 补终端既有关闭状态、长授权期限、清理失败、非 Error 拒绝与本地／Core 超时提示竞态的复现修复；追加真实 CLI 组合与 32 工具乱序验收。Q30–Q33、Q35 已处理；Q34 的控制字符显示政策保留待决定 | Ubuntu-24.04 隔离副本 build 与完整 check 通过，55 文件／566 测试；定向 274 项，其中真实双模块组合 27 项。实际编译 CLI 冒烟已通过；没有调用真实 provider | 继续本地核对；不提交、不推送、不修改其他模块产品或既有共享 fake |
| 2026-10-15 | 按用户决定补齐展示与故障停止 | 已实现 Q34 视图控制字符转义和 Q36 本地控制等待释放；共同协议、共享 Inbox、既有 fake、根 Readme、Prompt 与 canned fixture 均未修改。同步本模块规范，记录 Q25 集成后处理、Q26 暂缓、Q27 外部范围，Q24 仍待授权 | 7 项新回归先失败后通过；Ubuntu-24.04 隔离副本 build 与完整 check 通过：55 文件／573 测试，定向 281 项；Windows 检查 19 个变动文件的编码、换行、行宽、18 个本地链接及 git diff --check 通过 | 仍为 16／19；不提交、不推送；T17 等待 Q24，T18 首次合入待授权，T19 等待真实链路 |
| 2026-10-15 | T17 已完成 | 按 D28 仅修改两个既有 fake 的 deliver，先校验再复制入队；新增直接额外字段／缺失事件／未知事件拒绝、消息复制与合法 Schema 发错 Inbox 的共享用例。真实模块与 fake 运行相同套件，其他共享组件及 fixture 不改 | 新增 20 项中先复现 10 项 fake 失败；修复后共享 44 项、定向 301 项通过；Ubuntu-24.04 隔离副本 build 与完整 check 通过，55 文件／593 测试；21 个变动文件的编码、换行、行宽、18 个链接及 git diff --check 通过 | 17／19；剩余 T18 首次合入待授权，T19 等待真实链路；不 commit／push |

### 10.4 更新本文的规则

- 每完成一个可独立验证的阶段，或作出重要决定、发现阻塞，就更新第 6、7、10 节。
- 状态只用：未开始、进行中、待决定、等待中、已完成。
- 更新第 1.2 节的日期与基线；第 10.1 节必须始终反映仓库的真实状态。
- 不记录密钥、完整 Prompt、源码正文或未经脱敏的模型输出。
- 不覆盖用户或其他负责人未提交的改动；每次开始先检查 `git status` 与 diff。

### 10.5 实现中发现的问题

下表统一记录当前处理状态。之后的解释、撤回草案与修复前审计均为讨论历史，
其中的“当前”“尚未实现”“待决定”指记录当时，不覆盖本表和第 10.1 节。

| 编号 | 问题与证据 | 影响与建议 | 状态 |
| --- | --- | --- | --- |
| Q11 | 上轮因用户笔误提出全系统开发者诊断中文化，发现会涉及共享及其他分支代码 | 2026-10-14 用户更正：用户文案中文（UTF-8），开发者报错与注释英文。原问题解除，本分支恢复英文报错与注释；不需修改其他分支或共享代码 | 已完成 |
| Q12 | Windows 全仓 tsc 构建在既有测试中出现 TS2339：Vitest 的 Assertion 类型缺少 not，涉及 contracts、Fabric、AgentToolPool、kernel；pnpm 在沙箱中另有 EPERM | Ubuntu 隔离副本按锁定依赖安装后构建与全仓质量门通过，证明不需要改共享类型或根配置；记录 Windows 环境限制，正式证据以 Ubuntu 为准 | 已完成 |
| Q13 | WSL 的 ~/MultiAgentOS 位于 a650175，且包含 kernel 与组合根等未提交改动 | 未覆盖、切换或清理该副本；以本分支 HEAD 的 git archive 加本轮文件创建 Ubuntu 临时隔离副本验证；未修改任何其他分支代码 | 已完成 |
| Q14 | CodeViewer 没有 handoff 动作与该工具，但计划要求覆盖其 handoff 返回的处理 | 2026-10-14 用户决定：并非所有 Agent 都有 handoff；CodeViewer 的 handoff 作为非法输出，要求重新尝试。已补 Workflow 第 5 节：用运行内已固定集合识别控制工具，权限只看当前 actions；不允许的返回 INVALID(CONTROL_NOT_ALLOWED)，混合返回 CONTROL_MIXED，final-call 按既有规则降级；不查询目录、不硬编码模型名、不修改其他分支 | 已完成 |
| Q15 | 同一 UnitReport 内预算事实、失败策略、计数器与 Round 上限的处理顺序未规定 | 2026-10-14 用户决定：预算事实优先，再失败策略/模型动作与计数器，最后 Round 上限；已有原因保持不变。已写入 Workflow 第 8 节，并补充纯函数组合测试。该决定解决收尾原因的先后，不改变第 7、8 节各自的终态规则；两者交叉场景见 Q16 | 已完成 |
| Q16 | Schema 允许普通 model-call 同时失败且 EXHAUSTED；原 Workflow 规则未规定该交叉场景的终态优先级 | 按最终 D17：FATAL 优先，以 FAILED 只携带 failure 收尾，不生成或发布降级报告；final-call 的既有例外与非 FATAL 降级路径保留 | 已完成 |
| Q17 | 现有 FAILED 终态不能携带实际报告引用；自动交付失败报告需要共享变更 | 用户最终决定 FAILED 只按错误路径实现，不提交降级报告；撤回共同契约变更建议，不再需要授权。下文草案与核对仅保留讨论历史，不是待实施任务 | 已完成 |
| Q18 | 成功读取空文件合法返回 1..0，但报告来源不接受该范围；原规范未规定映射例外 | 按 D18 在本分支处理：空文件完整事实内部保存，不作为有效行来源；正常与降级报告摘要按路径去重注明数量，预留既有 4000 字符上限，必要时截短原摘要并加省略号。报告结构和共同协议不变；纯函数与工厂流程已通过模块测试 | 已完成 |
| Q19 | 合法交互控制请求被异常拒绝时，原规范未完整规定本模块处理 | 按 D19 已实现：合法取消及授权回答的异常拒绝由独立任务上报，QUESTION_NOT_PENDING 普通处理；已记录结果后的 shutdown 异常通过回调升级并返回原退出码，没有回调时抛错。沿用组合根关闭机制，不伪造成功、不重试、不改共同协议 | 已完成 |
| Q20 | Workflow 故障上报后原先仍能推进后续业务 | 已补独立业务守卫，故障后不再固定定义或提交业务请求；已有运行的 RunClosed 仍可处理并保存终态；有无故障回调均有相应停止与错误观察规则 | 已完成 |
| Q21 | Workflow 直接等待 Gateway、Catalog、Persistence，挂起时阻塞 Inbox 与 stop | 按 D20 全部端口调用等待返回至多 30 秒；超时直接升级，迟到响应或拒绝不恢复业务。Gateway、Catalog、终态记录挂起均有假定时器回归测试；远端停止仍由 Kernel 与组合根确认 | 已完成 |
| Q22 | Workflow 异常被业务失败吸收时缺诊断，收尾再失败时丢失首个异常 | 已写 workflow 私有脱敏诊断；诊断或关闭再失败时以进程内 AggregateError 关联首个与后续异常。不持久保存异常原文、堆栈、源码或凭据，不改 RunFailure 与用户输出 | 已完成 |
| Q23 | UserInteraction 五类 Gateway 调用挂起时，没有异常触发故障关闭 | 按 D21 均采用 30 秒返回期限，按所属捕获边界升级并观察迟到拒绝。输入询问仍按 expiresAt；shutdown 失败保留已记录的非零退出码。五类挂起调用均有测试 | 已完成 |
| Q24 | 两个 fake 的直接 deliver 原先不校验、不复制消息，与真实模块不一致；已确认问题在模块入口，不是共享 Inbox 队列算法 | 用户经解释后授权现在修改。两个 fake 已在入队前按各自 Schema 校验并复制；四个实现通过同一组 44 项测试。新增 20 项中修复前 10 项 fake 用例失败，修复后全通过；非法消息不占 eventId、不污染后续合法投递，Unsupported 无业务副作用。不改 Inbox、Fabric、Kernel、共同协议、其他 fake 或 testing/index.ts | 已完成 |
| Q25 | 根 Readme 仍将 Workflow、UserInteraction 描述为未实现，状态陈旧 | 用户决定当前不改；进入 feature/M1/main 后再更新，集成时依据实际模块交付状态修正文档。不据此改产品或快速失败测试；本分支 T18 本地准备不再等待该文档修改 | 等待中 |
| Q26 | 现行规范要求 prefixSha256 按 canonicalJson({ instructions, toolSpecs }) 计算，共享 canned.ts 仍使用 sha256Hex('canned-prefix') | 用户决定只在本文记录，暂不解决；未改共享 fixture、协议或依赖。已有组合测试只证明其覆盖的流程，不能认证前缀语义或缓存正确性；后续共享验收仍需处理 | 等待中 |
| Q27 | 固定 Prompt 尚未明确报告正文语言，UserInteraction 原样展示模型文本 | 用户明确报告字段应支持中文，面对用户的语言至少兼容中文，可能按用户语言动态决定；Prompt 设计不在本分支范围。保留当前固定中文界面、正常 Unicode 和模型原文，不自行翻译、不新增 locale 共同字段、不修改 Prompt；由 Prompt 负责人定稿，T19 核验语言行为 | 等待中 |
| Q28 | 时序实验发现 RunFinished 先于取消请求返回时，analyze 可先返回 0 并 stop，取消请求的 30 秒期限随后才触发系统故障；授权回答有同类窗口 | 按已有 D19／D21 补齐实现：跟踪已发控制请求，正常 shutdown 前等待其返回处理，仍受原 30 秒期限约束；发生故障交给组合根，返回已记录码，没有回调时抛错。用户输入不纳入等待。先以两项失败测试复现，再修复并补 Ack 及无回调回归；不改协议、Kernel 或组合根 | 已完成 |
| Q29 | 终端适配器 EOF 后不结束询问，输入／输出错误缺少观察，同步写提示抛错还会残留监听；CLI 默认帮助与参数错误包含英文用户文案 | 按既有终端与语言要求补清理、异常观察和中文 CLI 文案；先写复现测试再修复。首批终端 14 项测试覆盖 Y/N、无效输入、取消、EOF、流异常、同步抛错、信号解绑与 UTF-8；解析器 11 项测试保持公开入口及退出码规则；后续终端边界见 Q30 | 已完成 |
| Q30 | 终端在提问前已结束、直接关闭输入、或提问前已发生输入错误时，仍可能创建不能结束的 reader；输出提前或中途关闭也可能留待询问超时 | 先增加 5 项失败回归，再在适配器检查既有流状态、观察输入 close 与输出 close／finish，并按原规则清理。输入正常结束无回答；输入错误或无法展示询问则交给既有故障边界。真实 CLI 组合另增 5 项，未改公共 API 或其他分支产品代码 | 已完成 |
| Q31 | AuthorizationRequest 和 KernelConfig 允许较长期限，Node 的单次 setTimeout 超过 2147483647 毫秒会改为 1 毫秒，旧实现会把合法询问立即视为过期 | 先以长 expiresAt 回归复现，再在交互内部按运行时上限分段等待，用单调时钟计算剩余时长；取消可清除重设定时器，延迟唤醒时只到期一次。没有修改配置上限、Schema、Kernel、30 秒端口返回期限或授权规则；新增 1 项交互和 3 项定时器回归 | 已完成 |
| Q32 | 终端监听的释放抛错会阻止 stop 排空 Inbox、重复执行释放，或覆盖已有命令错误；命令已有非零结果时还可能丢失该结果 | 先以 3 项失败回归复现，再改为取出并注销释放动作、观察清理失败、排空后聚合错误；成功结果后的清理故障走既有回调，保留已记录码。新增真实组合根下 COMPLETED／RUN_TIMEOUT／CANCELLED 的 3 项故障用例，允许故障模块账本如实为 STOP_FAILED，其他模块必须 STOPPED | 已完成 |
| Q33 | 未注入故障回调时，独立任务以 undefined 拒绝会与“尚无错误”哨兵混淆，导致 stop 成功 | 先写失败回归，再把已捕获的非 Error 原因包装为英文 Error 并保留 cause；原 analyze 拒绝值不变，stop 保持可观察。未改 SystemFault 结构或错误传输协议 | 已完成 |
| Q34 | 合法报告字符串可含 ESC、回车、退格等终端控制字符，原样展示可能清屏或覆盖文字 | 用户同意展示层可见转义；已实现 C0、DEL、C1 控制字符转为 \uXXXX，保留 LF 换行、中文与其他正常 Unicode。报告、授权信息和摘要统一走视图转义；不修改报告原文、Schema、来源或 Prompt。两项回归先失败、修复后通过，正常文字与原文不可变断言通过 | 已完成 |
| Q35 | 本地授权到期计时先触发、随后收到 Core 的 TIMED_OUT 通知时，同一询问重复显示超时说明；已过期询问投递后也有同类情况 | 两项失败回归复现后，在交互内部按 questionId 去重超时提示。写入成功才记录已显示，不吞终端错误；仍以 Core 的授权结果为准，不发送默认回答，不改变 expiresAt、共同协议或 Kernel | 已完成 |
| Q36 | 控制请求挂起时发生独立故障，旧 stop 返回后本地 30 秒计时器仍存活，之后重复追加故障 | 用户决定故障停止时结束本地等待。已仅为 answerAuthorization、cancelRun 接入本模块停止信号，清除期限、观察迟到拒绝；不伪造 Ack，不向远端发送取消信号，不中断报告读取或 Inbox 排空，不改 Kernel。四项迟到返回／拒绝及一项外部停止回归先失败、修复后通过；正常 30 秒期限和 Inbox 排空回归继续通过 | 已完成 |

2026-10-15 边界核对说明：

- Q24 的直接投递实验只使用临时隔离副本与缺少合法 `event` 的输入，不涉及真实运行或外部网络。
  修复前产品在入队前拒绝，fake 却先接收并在消费时失败；修复后四个实现都在入口拒绝。
  这属于测试替身的接缝差异，不是健康 Core 会正常发出这种事件的证据。
- 共享套件现为 44 项，不使用 skip／预期失败；原差异以 10 项失败回归复现后修复。
  直接入口与真实 Fabric 接缝均通过；不把这些结果扩展为全部共享 Port 或真实 Kernel 已通过。
- 本轮检查发现 WSL 后续独立命令不再保留前一调用的 `/tmp` 验证目录，
  因此复现实验与质量门在同一个隔离副本、同一个 WSL 脚本进程内完成。
  不为复用目录而改写或清理用户的 `~/MultiAgentOS` 工作区。

历史记录：Q16 的解释阶段核对（2026-10-14；最终执行 D17，已实现）：

- 额度指本次 WorkflowRun 的 token 额度；EXHAUSTED 表示不能再发起任何 model-call，
  不要求剩余恰为零。提醒进入最后一次收尾调用的是 WRAP_UP。
- 模型调用成功但输出不合格是 `AnalysisAction.INVALID`，不是 UnitReport 的 FAILED。
  是否继续调用由反馈、计数器、Round 与额度共同约束。
- UnitReport 的 FAILED 不自动等于 FATAL；失败策略区分 RETURN_TO_MODEL、FINAL_CALL、
  DEGRADED_REPORT 与 FATAL，final-call 的 model-call 失败另有降级例外。
- 前文的 PROVIDER_AUTH + EXHAUSTED 是 Schema 容许的边界输入证据，
  尚未证明它在健康的真实链路中可达。ExecutorSet 第 4.5 节规定 HTTP 401/403 为
  `NOT_SENT`、`retryable = false`；Monitor 第 3.4 节会全额释放该次预留。
  因此 PROVIDER_AUTH 本身不会使正常额度进入 EXHAUSTED。
- 正常普通调用的预留保留 finalReserve；Monitor 第 3.3、3.4 节说明，
  估算上界成立时收尾额度保持完整，异常的实际用量超估可能占用该额度。
  Schema 通过不能代替跨字段语义与真实链路可达性的验证。
- Q16 要决定的是交叉边界输入的终态（FAILED 或发布降级报告后 COMPLETED），
  不是额度耗尽后是否还继续重试；EXHAUSTED 时两种方案均不再调用模型。
- 用户在解释阶段继续询问降级报告的生成与 FATAL 的关系。
  Workflow 第 10.2 节规定降级报告由程序按收尾原因填写固定说明与已确认的运行事实，
  不需要合法 FINISH，也不再调用模型；conclusions 与 unconfirmed 必须为空。
  readSources 只保留成功读取范围与 provenance，可以为空；没有合法分析结果不妨碍
  构造这种协议合法的收尾说明，但不能因此声称生成了有效分析结论。
- FATAL 是策略要求结束运行，不自动表示所有既有材料无效或报告序列化能力损坏。
  provider 授权失败时，已有成功读取事实可能仍然有效；存储、report-publish 或状态不变量
  本身损坏时，降级报告的可信构造或持久发布则可能失败。
  当前策略对 FATAL 直接 closeRun(FAILED)，final-call 的模型失败有既定降级例外；
  降级报告发布本身失败仍按 FATAL 处理，不能伪造发布成功。

历史记录：Q17 的共享变更草案（已撤回，按 D17 不实施）：

1. `CloseRunRequest` 的 FAILED 分支保留必填 `failure`，增加可选 `reportRef`；
   COMPLETED 的约束保持不变。FAILED 没有报告时仍使用原来的合法形态。
2. `runOutcomeVariants` 同步增加 FAILED 的可选报告引用，使 RunSummary、RunClosed、
   RunFinished 保留同一份失败与报告。不得以有报告为由改变 FAILED 或退出码 1。
3. Kernel 传递失败报告引用；接收失败收尾请求时必须校验报告已经发布、属于当前运行，
   保留产物引用与内容完整性校验。当前尚未实现的产品 Core 也须同步该验收要求。
4. fake-kernel 同步处理并验证该路径；测试覆盖失败无报告、失败有报告、非法或其他运行的引用、
   终态传递与 RunSummary 写入失败。Workflow 与 UserInteraction 接入后覆盖用户展示。
5. 同步 M1Interface、SharedContracts 与 Kernel 规范的兼容说明；旧消费者会拒绝新增字段，
   必须协调升级，不能将其视为所有旧消费者都可接受的变更。

当时草案预计的共享及其他分支变更范围（已撤回）：

- `packages/libraries/contracts/src/kernel-unit/workflow-syscalls.ts`
- `packages/libraries/contracts/src/kernel-control/run-outcome.ts` 及对应契约测试。
- `packages/modules/kernel/src/core/finalize-run.ts` 及对应测试。
- `packages/testing/src/fakes/fake-kernel.ts` 及相关 fixture、契约测试。
- `docs/M1/M1Interface.md`、`docs/M1/Library/SharedContracts.md`、`docs/M1/Module/Kernel.md`。

这组共享接缝变更按第 2.2 节单独组织并先进入集成分支，不自动切换或修改其他工作分支，
不改 ExecutorSet、额度计算、其他 Unit 的失败策略或 AnalysisReport Schema。
最后失败的中文说明写入已有 summary，保留原始结构化 failure；不得把内部 detail 或凭据写入报告。

证据：本地对现有 Schema 运行只读校验，FAILED 不带 reportRef 三项均通过，
带 reportRef 的 CloseRunRequest、RunClosed、RunFinished 三项均被拒绝。
当时实现只完成模块内纯函数，未接入发布和终态交付，T06 尚未完成；后续状态见第 10.1 节。

历史记录：Q17 的方案与取舍（2026-10-14，解释时尚未授权，之后由 D17 取代）：

- 必要性取决于报告是否必须通过现有 CLI 自动展示。仅要求保持 FAILED、生成并保存包含最后失败
  说明的降级报告，不必扩展共享契约：Workflow 可发布报告并在内部 WorkflowRunRecord 保存引用，
  closeRun 仍只传 failure；UserInteraction 根据失败码显示中文说明，退出码仍为 1。
  该方案下 CLI 无法自动发现和读取这份降级报告，报告保留用于内部审计。
- 如果要求用户自动收到并看到这份实际 AnalysisReport，则现有链路缺少引用传递，必须扩展
  CloseRunRequest、RunClosed、RunFinished、RunSummary 的 FAILED 分支，或另行设计新的发现接口。
  新发现接口同样涉及共享协议与 Kernel，不是无需共享变更的替代方案。
- UserInteraction 可以用已有 failure.code 自行显示失败说明，但这种提示不是 Workflow 生成的
  AnalysisReport，也没有其中的读取来源与代理轮次；不得把它当作完整报告交付。
- 不通过 failure.detail 偷渡报告引用；该字段明确不用于决策或用户文案。UserInteraction 不直接
  读取 Workflow 的私有持久化记录，也不绕过 Gateway 访问产物；不得改为 COMPLETED 来传报告。
- AnalysisReport、RunFailure、ArtifactRef、readArtifact 请求响应与 Port 方法签名无需修改。
  需协调的是 FAILED 可携带报告的语义和终态载荷，而非模型输出、额度或 ExecutorSet 的协议。

历史记录：降级报告的来源与展示核对（2026-10-14，早于 D17 与交互工厂实现）：

- 降级报告是既有设计：祖先提交 `3a36347`（2026-10-08）的 Workflow 第 10.2 节已规定
  EXHAUSTED、final-call 不合法或失败时生成确定性降级报告；UserInteraction 第 5 节已规定展示。
  该提交早于三分支并行接缝提交 `9cf8c9c`（2026-10-13），不是本次实现新加的机制。
- 原设计将成功发布的降级报告按 COMPLETED 收尾；FATAL 按 FAILED 收尾，只展示失败说明。
  本次新增的是 FATAL 与 EXHAUSTED 交叉场景仍为 FAILED，同时报告描述最后失败；失败报告
  是否必须自动展示尚待用户确认，不能把“生成”自行等同于“自动交付”。
- 展示降级报告的设计作用是说明分析为什么停止与不能给出结论，避免把空结论当成没有问题。
  这是既有产品设计的解释，不代表所有故障均必须生成报告或新增展示要求已获批准。
- 默认展示按 UserInteraction 第 5 节和 Kernel 第 9 节：正常报告展示结论、来源、未确认项；
  降级报告标明降级并附收尾原因；FAILED 展示运行失败与原因码对应的中文说明；
  只有 --details 才额外展示轮次、调用次数、token、耗时等 RunSummary 内容。
- 以上是当时的规范默认行为，当时产品 UserInteraction 工厂仍抛 NOT_IMPLEMENTED，完整展示链路尚未
  实现。不得把规范行为描述成当前系统已经能实际完成的输出。

历史记录：协议断点核对（2026-10-14，未修改共同契约，最终按 D17 执行）：

- 不是三个分支各自实现出不同协议；现有共享 Schema、Kernel 收尾辅助与 fake 对 FAILED
  只携带 failure 的设计一致。问题来自原 Workflow 第 7.2 节与第 8 节在同一输入同时触发时
  没有规定优先级，以及新增的“保留 FAILED 并生成失败降级报告”不属于原终态交付组合。
- 失败信息本身可经 failure → RunFinished → 原因码中文说明正常交付。受阻的是实际
  AnalysisReport 的引用：closeRun 的 FAILED 分支不接受它，后续终态也不承载它；
  UserInteraction 无法发现报告，不是 report-publish 必然失败或 readArtifact 不支持读报告。
- 保持协议不变可完成 D16 的 FAILED 判定、中文失败提示、退出码 1，以及在发布能力可用时
  生成并保存包含最后失败说明的降级报告、内部记录报告引用；还可保持原有非 FATAL 降级报告
  的 COMPLETED 交付与展示。唯独不能自动向用户交付 FAILED 下的实际 AnalysisReport。
- 解释阶段尚未决定是否采用“FAILED 只显示失败说明，报告内部保存”；随后 D17 明确改为
  FAILED 只走错误路径，不提交降级报告。Q17 已解除，不改其他分支，不改共同契约。

历史记录：Q18 的解释阶段核对（2026-10-14，解释时尚未选择，之后由 D18 确认）：

- 空文件指没有可返回的文本行，读取成功不等于必须返回至少一行。FileReadOutput 明确定义
  1..0、totalLines=0 为合法空文件结果；这不是读取失败、权限失败或模型失败。
- 报告 readSources 和每条结论的 sources 使用 VerifiedSource，表示实际读取过的非空行范围，
  起止行均至少为 1，结束行不得小于开始行。空文件没有第 1 行，不能伪造 1..1 作为来源。
- 两份 Schema 各有明确用途；缺口是 Workflow 规范要求把“全部成功读取范围”放入报告时，
  未规定空文件例外。只读校验已证明该读取结果合法，对应报告来源不合法；这是边界设计缺口，
  不是已发生的生产运行失败，也不是三个分支已被证明实现了互不兼容的版本。
- 不改共同契约的建议方案只调整本分支映射：非空读取按原规则成为报告来源；空文件路径、
  requestId、哈希与空文件状态保留在 Workflow 私有记录，报告 summary 注明空文件数量。
  不会把整次运行标为 FAILED 或强制生成降级报告；正常与原有降级报告均可采用该映射。
- 空文件不能覆盖合法的非空来源范围；模型引用不存在的第 1 行时，该结论按既有
  SOURCE_NOT_READ 规则降为未确认。其他已读取非空文件的结论不受影响。
- 若需要在报告结构化字段中列出空文件，则须扩展来源类型或增加独立字段，涉及共享协议、
  校验、消费者协调，不在未授权时实施。只在 summary 提示不等价于新增结构化来源能力。
- 当时工厂未接入完整报告流程，因此不是已经出现报告发布失败；此核对是在实现前发现
  直接映射会被拒绝。当时 Q18 尚待决定，之后已按 D18 实现并通过工厂流程测试。

历史记录：T07–T10 完成证据（2026-10-14，早于故障审计补全）：
工厂接入、交接、来源核验、空文件映射、发布顺序与
业务记录已实现；新增全部终态、关闭后不再发请求、20 组固定种子的随机合法模型历史测试。
Ubuntu-24.04 隔离副本 build 与完整 check 通过：47 文件/421 测试，其中 Workflow 12 文件/133 测试。
随后只缩短测试标题、更新本计划，无行为变化；共同协议、Kernel、ExecutorSet 未修改。
进入 T11 时发现 Q19，用户要求先解释，不把问题回复视为对新规则的授权。

历史记录：Q19 的责任边界建议（2026-10-14，当时尚未授权，之后按 D19 实现）：

- Kernel 必须兑现既有规范：合法 cancelRun 走控制通道，RUNNING 进入取消收敛，
  CONVERGING/CLOSED 返回 Ack；shutdown 完成收敛后关闭；收敛机制自身失败走已有故障升级。
  这是 kernel 分支原有实现与验收责任，不需要为了本次问题新增取消权限或共同协议。
- 当前分支的 createKernelCore 仍为 NOT_IMPLEMENTED，不能把规范承诺或 fake 测试结果
  描述成真实 Kernel 已具备完整中止能力；也不能据此断言其他分支已有实现存在具体缺陷。
- Gateway 当前只对新工作实施 RUN_BLOCKED，cancelRun 与 shutdown 不在该封锁名单。
  格式、调用者身份和运行引用校验仍须保留，不因为取消优先级高而放弃边界检查。
- UserInteraction 可通过已注入的 reportSystemFault 上报“正常控制请求被异常拒绝”所揭示的
  内部控制不变量缺陷；不伪造取消成功，不循环重试，不直接访问 Kernel 内部或退出进程。
  已失效授权询问仍为正常结果，不和控制失效混为一类。该建议的故障判定尚待用户确认。
- 组合根已把同一故障上报函数注入两个模块与 Kernel，并实现 abortAllRuns 的期限、
  Supervisor 停止与 ModuleHost 兜底、残留子进程清理、故障退出码非零；可复用已有路径。
  UserInteraction 只负责触发升级，真正停止由 Kernel、Supervisor 与组合根执行。
- 如果联合验收发现 Kernel 拒绝合法控制请求、丢失取消或吞掉收敛错误，再由 kernel 分支
  修复对应实现，属于恢复既有规范，未必需要改共同契约。当前未证明这种产品缺陷。
- 建议新增的联合验收：取消在 RUNNING/CONVERGING/CLOSED 下的处理；中止请求异常拒绝
  后故障关闭；Gateway 调用抛错；Core 不收敛的期限兜底；重复故障只执行一次关闭。
  不未经授权修改 Kernel、Gateway、组合根产品代码或其他分支。

历史记录：多进程故障处理核对（2026-10-14，仅为长期迁移建议，不改变 M1 范围）：

- 当前按生产依赖与组合根接线统计，共 3 个组件有 reportSystemFault：Workflow、
  UserInteraction、Kernel Core。三者注入同一组合根回调；不是三套监管系统。
  Supervisor 没有该注入项，其启动、停止与 whenStopped 失败由现有监管链路观察。
  当时 UserInteraction 与 Kernel Core 工厂仍未实现；之后本分支已实现交互捕获边界，
  产品 Core 与真实执行链路仍未在本分支完成联合验收。
- Architecture/Evolution 第 2 节已规划 Supervisor 独立成进程，Workflow 与交互按需拆分；
  Core、Monitor、Scheduler、Execution 仍同处一个 Kernel 核心进程，通讯主体不等于进程。
- 多进程时不能跨地址空间直接调用当前函数或传递 Error/AbortController 等内部句柄；
  可保留模块内上报入口，通过适配器发送经校验、认证、脱敏的可序列化故障事件。
  当前 SystemFault 是明确的进程内类型，不是已有的网络故障协议。
- 组合根继续负责每个进程的装配、接线和本地清理，跨进程的长期生命周期职责交给独立
  Supervisor；同时监测主动故障上报、进程退出、通道断开与有期限的存活检测。
  失联只能说明未能确认状态，不能等同于执行已经停止或尚未产生效果。
- Supervisor 自身需部署层兜底，例如 systemd 或容器管理器；本地 Linux 多进程可用服务的
  cgroup 生命周期控制覆盖子进程，不能仅依赖父进程退出。Linux 的父进程退出通常会使孩子
  被重新托管，不天然杀死孩子；Architecture/Module/Kernel 关于 Supervisor 失效后孩子随之
  退出的承诺，未来必须通过具体机制与故障注入兑现，当前不改长期规范。
- 未来控制请求均需期限、幂等和停止确认；RPC 超时不代表远端工作已经停止。按运行或实例
  范围处置故障，重启前核对旧执行与未知效果；不默认每个模块故障都关闭所有实例。
- 上述属于未来拆分阶段的独立协议与部署设计，不为此修改当前共同协议、Kernel 或组合根。

历史记录：故障调用闭环的修复前审计（2026-10-14；当时只读，后续修复已提交）：

- Workflow 已有真实调用点：内部错误先 closeRun(FAILED, WORKFLOW_INTERNAL)，收尾再抛错、
  没有可用状态、已在 CLOSING 时再出内部错误，或终态记录写入失败，才由 Inbox 观察者上报。
  UnitReport 失败、非法模型输出、普通 SyscallRejected 不直接上报；closeRun 返回拒绝按
  现有规范等待 RunClosed，不等于抛错，也不立即调用 reportSystemFault。
- 当时 Core 与 UserInteraction 工厂仍未实现，只能评估规范承诺。Core 的运行 actor 错误先走
  KERNEL_FAULT；收敛再失败及 actor 外系统错误才上报。UserInteraction 的 Inbox、询问任务、
  中断处理抛错直接上报；analyze 自身抛错由命令入口捕获。Q19 的异常拒绝升级尚未实施。
- 分级与组合根兜底方向合理，但不能宣称全部实际链路闭环。原 T10 完成证据只覆盖会返回
  的依赖与正常终态，以下问题需要补充；不以先前 421 项测试通过代替新增边界验证。

| 编号 | 修复前审计问题与证据 | 当前处理 | 状态 |
| --- | --- | --- | --- |
| Q20 | 修复前 hasFault 仅用于 health。合法 Schema 的错误顺序输入触发上报后，后续 RunStart 仍出现 REGISTER、SUBMIT；替身回调只记录，证明模块依赖外部封锁 | 已加入故障后业务守卫与测试，见本节当前问题表；未改其他分支产品代码 | 已完成 |
| Q21 | 修复前持有 SUBMIT 返回并投递 RunClosed：故障数 0、终态写入 0、stop 未完成；释放返回后写入 1、stop 完成。10ms 是观察窗口，不是建议期限 | 按 D20 加入 30 秒返回期限；所有相应端口及终态写入均受期限保护，见本节当前问题表 | 已完成 |
| Q22 | 修复前内部异常成功转为 WORKFLOW_INTERNAL 时无持久诊断；收尾又失败时只上报第二个异常 | 已补脱敏诊断与进程内因果关联，见本节当前问题表；未改 RunFailure 共同契约 | 已完成 |

审计使用 Windows 原有 tsx 加载本分支源文件与模块内替身，未新增共享测试或修改共同协议。
真实组合根在已触发关闭之后有各步期限，但这不自动为每一个挂起调用提供截止机制。

已提交的实施与决定（2026-10-14，与本节当前问题表一致）：

- 用户明确要求完成故障补全与 UserInteraction 调用组合根，并提交当前分支；D19 记录授权。
  Q19：合法 cancelRun、shutdown 的异常拒绝升级为控制不变量故障，禁止重试或伪造成功。
  合法授权回答的异常拒绝同样升级，QUESTION_NOT_PENDING 保持普通失效结果。
- Q20 已补业务守卫：系统故障后不再固定定义、登记代理或提交 Unit；已有运行仍接收 RunClosed
  并尝试保存终态记录。未注入上报函数时也停止业务，并由 stop 保留未观察错误。
- Q21 按用户明确选择采用 30 秒：全部 Workflow Gateway、Catalog、Persistence 调用均有期限。
  超时直接上报，不再发起 closeRun 等业务动作；迟到响应与拒绝不会恢复 reducer。
  已排队终态可以继续处理；挂起的终态写入也在期限后升级，不重新开启运行。
- Q22 已补 workflow 私有脱敏审计，保存操作、阶段、诊断标识、运行标识、固定码与时间。
  原异常文案、堆栈、源码与凭据不写入持久记录或用户输出；恢复成功时提供定位元数据，
  不宣称保存了完整原始堆栈。诊断或关闭再次失败时，AggregateError 在进程内保留两个异常。
- 实现 UserInteraction 后发现 Q23：五类 Gateway 调用若挂起，原规范捕获边界不会得到异常。
  用户明确同意也采用 30 秒；已在本模块私有 helper 中实施，不跨模块导入或扩展共同配置。
  用户输入仍按 expiresAt 到期，迟到返回或拒绝仅被观察，不恢复业务。
- 实现中还发现：已结束运行的 shutdown 若直接抛给命令入口，组合根拿不到已记录的非零码。
  为兑现原规范，已记录结果后的 shutdown 超时、抛错或异常拒绝通过既有回调上报并返回原码；
  组合根保留原非零码，原码为 0 时返回 70。没有回调时仍抛错，不假装关闭成功。

本轮文件与验证范围：

- Workflow 的 application/domain、模块内替身与测试，以及 Workflow 自有规范。
- UserInteraction 的工厂、application/domain、中文 InteractionMessages、纯视图与模块内测试，
  以及 UserInteraction 自有规范。开发者报错与源码注释均为英文。
- 按既有 Q08/D11 授权，只新增 apps/control-plane/src/bootstrap/interaction-fault.test.ts，
  真实 UserInteraction 配合 fake Kernel、fake Workflow 与真实组合根，验证取消／关闭异常拒绝、
  全部模块停止，以及故障时仍保留 RUN_TIMEOUT 的退出码 2；该文件单独测试提交。
- 共同契约、公开依赖及工厂签名、Kernel、Fabric、ExecutorSet、ToolPool、组合根产品实现均未改。
  模块调用期限不等于远端停止保证；真实 Kernel 的迟到控制操作与停止确认仍须后续联合验收。
- T11–T14 本分支实现完成；T15 未开始，T16 仅完成上述故障组合子集，T17 未开始。
  本次请求完成并提交后结束，不自动推进其他分支、push、PR 或合并。

提交组织：Workflow 功能及规范、UserInteraction 功能及规范、组合故障测试各独立提交；
本分支计划单独 docs 提交，并保留不进入集成分支的导出规则。

最终验证证据（2026-10-14）：

- Ubuntu-24.04 的隔离副本按当前 HEAD 加本轮允许的源文件覆盖构建；
  锁定依赖离线安装、pnpm run build 与 pnpm run check 全部通过。
  完整结果为 50 文件／462 测试，其中 Workflow 12 文件／138 测试，
  UserInteraction 2 文件／33 测试，新增组合故障测试 1 文件／3 测试。
- 先新增复现用例，再修复 Workflow 的故障后推进、挂起调用与原异常丢失问题。
  假定时器验证期限；迟到拒绝已被观察，不产生未处理 Promise 拒绝。
- UserInteraction 的调用期限增加了确认时序：调用 createRun 不代表运行已创建。
  两个旧中断测试曾过早触发中断，被正确忽略；已修正替身就绪点，等待确认后的事件循环，
  不更改“创建前中断忽略”的产品规则，不以延长测试超时掩盖时序错误。
- Windows 只运行文件和差异核对：UTF-8 无 BOM、LF、末尾换行、无行尾空白、
  源码 100 字符行宽、分支计划引用隔离与 git diff --check 均通过。
- 最终质量门之后仅补充本文验证记录和本分支模块规范的正文换行，不改变产品行为。
  未执行真实 Kernel／Executor 联合验收，不以 fake 结果宣称其他分支功能已完成。

已完成的实现提交（均在 feature/M1/workflow-UserInteraction）：

- f586fc8：feat: implement workflow analysis and fault closure。
- b33a16e：feat: implement user interaction and system fault escalation。
- b78139d：test: verify interaction faults close the composed system。

本文另作独立 docs 提交；该提交不得进入集成分支。未 push、未创建 PR、未切换其他分支。

### 10.6 历史计划对齐（2026-10-14）

2026-10-14 用户只要求对齐本文并提交。修改范围只有本文，不实施或采纳 GitHub Issue 的方案。
主进度、当前继续点与问题表均以已提交实现为准：14 项已完成，5 项未完成；
Q19–Q23 已处理。历史解释、草案及修复前审计保留历史标签，不作为当前待办。
T18 不等待其他分支真实实现，T19 才进行真实链路联调。

本次对齐前 HEAD 为 `eaba89e`；实现及测试提交不改写，本次另作带中文正文的 docs 提交。

本次验证：Ubuntu-24.04 隔离副本的 pnpm run build、pnpm run check 均通过，
结果为 50 文件／462 测试；文档编码、换行、行宽、10 个本地链接与 git diff --check 通过。
这次重新执行了已有质量门，没有新增业务测试，也没有运行真实模型或跨分支业务验收。

### 10.7 本轮验收核对（2026-10-15）

本节只记录本分支代码与确定性替身验证，不认证真实 Kernel、Executor 或 provider。
测试目录简称：Workflow、UserInteraction 指各自 `packages/modules/<module>/src`；
组合指 `apps/control-plane/src/bootstrap/workflow-interaction.test.ts`。

| 要求 | 实现与核对证据 | 结论与限制 |
| --- | --- | --- |
| R-C1、R-C3–R-C5 | 两个 runner 仅经各自 GatewayPort；requestId、关联上下文与端口返回在模块测试和真实 Fabric 组合中校验 | 已核对；不直接访问其他模块私有实现 |
| R-C2、R-C6 | 新增 Inbox 共享 harness；原模块 stop／故障测试；两个真实模块的组合关闭与记录断言 | 四个实现同组 44 项通过；Q24 已修复，未扩大到其他 Port 或真实 Core 验收 |
| R-C7–R-C8 | Workflow 内部失败吸收、关闭再失败升级；交互询问／中断／Inbox 故障测试与既有组合故障用例 | 已核对；30 秒端口期限由模块假定时器测试验证 |
| R-C9 | 工厂只构造、manifest、启动前投递与可重复 stop 的模块测试 | 已核对；未改公共工厂签名 |
| R-W1–R-W4 | reducer、运行循环与固定定义测试；组合中的 context-assemble → model-call 顺序和 final 输入 | 已核对；无共享实现替代 |
| R-W5 | 工具 UnitReport 先于 Ack、乱序收齐的模块测试；组合逐次校验历史工具调用均有 TOOL_RESULT／FEEDBACK | 已核对；真实 Core 调度时序仍待 T19 |
| R-W6–R-W8 | analysis-action、validation、progress 的纯函数测试；组合非法 CodeViewer handoff 与未知工具反馈 | 已核对；只用当前 Agent 权限执行 |
| R-W9–R-W10 | syscall 拒绝与 failure-policy 测试；组合普通 FATAL＋EXHAUSTED、final-call 失败降级 | 已核对；FAILED 不发布任何报告 |
| R-W11–R-W14 | rounds、循环与交接测试；组合 WRAP_UP 随 HANDOFF 传递、单次 final-call、EXHAUSTED 不再调用模型 | 已核对；不以 fake 的固定预算摘要证明真实账本 |
| R-W15–R-W17 | normal-report、degraded-report、空文件测试；组合读取来源、产物 Schema、发布／end／close 顺序 | 已核对；不会把未读来源列为确认结论 |
| R-W18–R-W20 | closure 固定种子性质测试；组合全部终态的私有运行记录、失败审计脱敏与全部模块停止 | 已核对；没有新增持久化格式或跨模块报告字段 |
| R-W21–R-W23 | 源码审计：预算只看 budgetState；限制／策略取固定定义；参数取 registry.resolveContract | 已核对；不读取 token 配置，不修改定义 |
| R-U1–R-U7 | interaction-runner 测试；组合授权拒绝／超时、createRun 拒绝、中断、各终态与退出码 | 已核对；unknownEffects 仅显示说明，按既有规则不自行改变退出码 |
| R-U8–R-U11 | 视图快照与产物读取测试；组合报告、降级说明、details、摘要写入失败和未知效果 | 已核对；固定文案中文，模型正文要求见 Q27 |
| R-U12–R-U14 | 三处故障边界与 Node 终端测试；CLI 经公开 analyze 入口；中文帮助与参数错误回归 | 已核对；不自行退出进程、不修改组合根产品代码 |

补充：R-U12 与关闭规则新增 Q28 的四项回归。已发控制请求不能越过正常关闭边界，
迟到 Ack 可以继续正常 shutdown；挂起请求超时仍上报，并保留已经记录的非零码。
没有故障回调时 analyze 与 stop 均保留错误可观察性，不把独立错误吞掉。

T18 的本地准备和待办：

- 已对照上述要求、Workflow 与 UserInteraction 规范；补 UserInteraction 中 CLI 中文提示、
  EOF 无回答与流错误清理说明，均沿用用户既有语言与故障处理决定。
- 根说明文档按 Q25 留到集成分支更新；M1 文档索引未发现必须修改的实现状态描述。
- `apps/control-plane` 的产品部件快速失败测试仍应保留：本轮两个模块已有实现，
  但真实 Kernel 与 ExecutorSet 工厂仍未完成；完整质量门负责确认该测试继续成立。
- 本轮按用户指定的三个提交组织：交互／终端修复及模块、组合验收；共享 fake／harness；分支计划。
  `packages/testing/src/index.ts` 未改；新 harness 当前仅由该包内测试直接引用。
- 用户本轮已授权三个提交与当前工作分支的推送；未授权导出分支、PR 或合并，不自动执行。
  分支计划保留在本分支，未来导出时必须排除。
- T19 等待真实实现与 Prompt 定稿；届时先跑确定性模型替身，再跑真实 provider、
  来源一致性、补充检索与工作区不变验收，不把当前 27 项组合测试当成该阶段证据。

持续审计补充证据：

- 最新定向用例为 301 项：Workflow 141、UserInteraction 56、CLI 30、共享 Inbox 44、
  新组合 27 与既有组合 3；新增的 32 工具上限用例通过，覆盖 Ack 前返回与成对乱序结果。
- 终端释放故障的组合账本按实际情况允许 UserInteraction 为 STOP_FAILED；
  其余模块必须 STOPPED。该用例不会把清理失败伪装成正常停止。
- 已运行一次 V8 覆盖率审计，用于定位遗漏；统计包含模块内测试替身，不作为产品完成率。
  它引出了清理失败及非 Error 拒绝的复现与修复，不增加覆盖率阈值或根配置。
- 隔离副本实际运行已编译的命令：--help 返回 0 并显示中文帮助；
  相对仓库路径返回 64 并显示中文说明；合法 analyze 仍因产品 Kernel 未实现返回 70。
  这证明 CLI 入口行为，未调用真实模型或外部 provider。
- 再次只读核对 GitHub：本分支仍为 57dc85d，集成分支仍为已包含的 b44380a，
  没有新合入的真实 Core／Executor 可用于 T19；未 fetch、切换或合并任何分支。

### 10.8 首次合入的说明草稿

以下仅供未来合入评审使用；本轮不创建 PR 或导出分支。
共享 Inbox 边界已按用户授权修复；本轮三个提交的整理与验证见第 10.9 节。
依赖产品工厂的组合与共享测试需要连同对应产品实现验收，不能单独套到仍是空工厂的基线上。

建议标题：`feat: 实现 Workflow 与 UserInteraction 分析闭环`

建议正文：

> 接入 Workflow 与 UserInteraction 产品工厂，完成固定定义、分析循环、工具验收、
> Planner 交接、来源核验、报告发布、运行记录，以及授权、中文结果展示和关闭。
> CLI 的帮助和参数错误使用中文；终端结束、流错误与中断都有清理和故障处理。
>
> 两个模块通过公开 Port 接入既有组合根；补齐调用返回期限、独立任务观察、
> 终态先到时的控制请求收尾，以及清理失败时的错误保留和非零退出码处理。
> 共同 Schema、工厂签名、Kernel、ExecutorSet 与组合根产品实现均未改变。
>
> 验证：Ubuntu 24.04 隔离副本执行锁定依赖安装、build 与完整 check，
> 55 个测试文件、593 项测试通过；定向测试 301 项，实际 CLI 二进制冒烟通过。
> git diff --check 与 UTF-8、LF、行宽、本地链接检查通过。
>
> 限制：真实 Core／Executor 联调和真实 provider 验收仍待其他分支交付；
> Prompt 定稿与输出语言由其负责人落实；共享 Inbox 四个实现同组 44 项通过，前缀 fixture 按用户决定暂缓。
> 根说明文档留到集成后更新；不将 Inbox 验收扩展为其他 Port、前缀语义或 M1 发布验收。
>
> 回滚：按提交边界撤回本次模块实现、CLI 修复及新增测试；没有共同协议迁移。

分支计划及本段草稿不得进入导出分支；最终 PR 不得引用本文或阶段／问题编号。

### 10.9 本次三提交整理与推送授权（2026-10-15）

用户明确要求整理文档、作为三个提交推送当前分支，并参考已有 Claude 与 cary 的说明格式。
采用 Conventional Commits 中文标题、正文条目、关键边界与验证记录，沿用本地已配置的提交身份。
历史表中的“仅本地”“不提交／推送”是当时约束，本次由 D29 明确替代，不改写历史记录。

本次提交范围：

| 顺序 | 提交 | 文件与逻辑边界 | 准确暂存快照的验证 |
| --- | --- | --- | --- |
| 1 | c3d6a9a：fix: 补齐分析交互与终端关闭边界 | CLI、UserInteraction 修复及对应规范；模块边界、32 工具与完整组合验收；不含共享测试包或本文 | Ubuntu 24.04，离线锁定依赖安装、build、完整 check 通过：54 文件／549 测试 |
| 2 | be6e740：test: 对齐共享 Inbox 替身与产品入口契约 | 只含两个既有 fake 与两份新增共享 harness 文件，保持接缝独立；不改 fixture、testing/index.ts 或产品组件 | Ubuntu 24.04，同样验证通过：55 文件／593 测试 |
| 3 | 本文所在提交：docs: 整理分析交互分支进度与交付记录 | 只整理本文的当前进度、用户决定、历史边界、验收证据与本次交付记录；提交哈希以 git log 为准 | 提交前按本文准确暂存快照执行 build 与完整 check；产品测试基线为 55 文件／593 测试 |

按用户指定的三个提交，本次模块与组合测试作为修复的验收内容随第一个提交，
共享 fake 与 harness 单独成为第二个提交，分支计划单独成为第三个提交。
只推送 origin 的 feature/M1/workflow-UserInteraction；不 force push、不创建 PR、不更新集成分支。
推送是否完成以命令结果与远端分支哈希等于本地 HEAD 为准，不在推送前宣称成功。

当前任务仍为 17／19：提交与推送不等于 T18 已合入，T19 也仍等待真实链路。
根 Readme 留到集成后、前缀 fixture 暂缓、Prompt 留给对应负责人；不随文档整理扩大实施范围。
本文仍不得进入导出或集成分支，未来合入必须按第 9.3 节排除。
