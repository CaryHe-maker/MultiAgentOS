# M1 Workflow 与 UserInteraction 实现计划

## 1. 用途与当前状态

### 1.1 本文的地位

- 本文是 `feature/M1/workflow-UserInteraction` 分支的工作文档，有三个用途：按步骤规划 Workflow、
  UserInteraction 与 CLI 的实现；记录进度与验证证据；作为后续对话（AI agent）接手这项工作的上下文入口。
- 本文不是规范。规范是 `docs/M1/` 下的文档；本文第 5 节只是把它们对本分支的要求整理成核对清单，
  两者不一致时以规范为准，并修正本文。
- 本文不进入 `feature/M1/main`、`feat/M1` 与 `main`。向 `feature/M1/main` 提 PR 时使用不含本文的导出分支（第 9.3 节）。
- 进入 `main` 的任何文件都不得依赖本文：规范、源码注释、错误信息与测试不链接本文，
  也不使用本文的阶段编号（T01–T19）、问题编号（Q01–Q10）和决定编号（D01 起）。只有本文可以引用规范。
  下面的命令除本文外应当没有结果：

  ```bash
  git grep -nE "workflow-User-plan|\bT(0[1-9]|1[0-9])\b|\bQ(0[1-9]|10)\b" -- . ':!docs/M1-workflow-User-plan.md' ':!pnpm-lock.yaml'
  ```

- 文件名是文档 PascalCase 命名惯例的例外，由用户指定，保留该名称。

### 1.2 当前状态

- 更新日期：2026-10-13。
- 基线：分支与 `feature/M1/main` 同为 `ac368ad`，没有自己的提交。该提交已在 CI（Ubuntu 24.04）通过质量门。
- 尚未开始任何实现：`createWorkflow` 与 `createUserInteraction` 抛出 `NOT_IMPLEMENTED`。
- 当前继续点见第 10.1 节。下一步是 T01（规范缺口的决定），其中的问题需要用户回答。

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

以下内容三个分支共用。本分支需要改动它们时，必须作为单独的提交，只包含接缝本身及其规范、fake 与测试的同步修改，
先合入 `feature/M1/main`，再由各分支同步（M1Plan 4.1 的五条规则）。不得夹在功能提交里。

- `packages/libraries/contracts/**`（Schema、Port、跨模块类型）
- `packages/testing/**`（fake、fixture、共享 contract test）
- `WorkflowDeps`、`UserInteractionDeps`、`TerminalPort`、`AnalyzeCommand` 与两个工厂的签名（M1Interface 第 14.2 节）
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

- `apps/control-plane/src/bootstrap/perspectives.test.ts`：其中的 `referenceWorkflow` 与 `referenceInteraction`
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
| 产品 Kernel 核心与 Supervisor 的执行派发 | kernel 分支 | T01–T17 全部用 fake Kernel 或模块内的测试替身完成，不等待；T18 需要它 |
| 真实的五个 Executor（`createExecutorRegistry` 仍抛 `NOT_IMPLEMENTED`） | pool-executor 分支 | 同上 |
| Prompt 正文与 Tool 的 `modelDescription` 定稿 | Cary 与 meti | 影响 T18、T19 的真实模型表现，不影响确定性测试 |

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

### 6.1 待决定（T01 处理）

这些是规范没有写明、实现时必须有答案的地方。每一项给出建议；未取得用户决定之前不得按建议实现后当作既成事实，
涉及规范的决定要写回对应文档。

| 编号 | 问题 | 建议 | 影响阶段 | 状态 |
| --- | --- | --- | --- | --- |
| Q01 | `FeedbackCode` 中有 `WRAP_UP_NOTICE`，但 Workflow 规范没有规定何时记录 | 在决定下一次 model-call 为 final-call 时记录一条不带 `toolCallId` 的 `FEEDBACK(WRAP_UP_NOTICE)`，说明 `wrapUpReason`；若认为 `status.wrapUpReason` 已足够，则明确规定 M1 不使用该反馈码 | T06 | 待决定 |
| Q02 | 重复调用检测中“规范化参数”的定义 | 对模型给出的 `arguments` 取 `canonicalJson`，不补缺省值；`{query:"a"}` 与 `{query:"a",mode:"AUTO"}` 视为不同调用 | T04 | 待决定 |
| Q03 | 用户可见文案的语言，以及 `InteractionMessages` 的内容 | 使用中文（规范中的示例文案即中文）；全部文案集中在一个表中；为 M1Interface 3.4 中 `RunFailure` 可能出现的原因码各写一条，其余用通用说明 | T13 | 待决定 |
| Q04 | `readArtifact(reportRef)` 被拒，或报告未通过 `AnalysisReport` 校验时如何展示、退出码是多少 | 显示“报告无法读取”，退出码至少为 1，照常 `shutdown`；属于契约内结果，不上报系统故障 | T13 | 待决定 |
| Q05 | `--details` 读取或校验 RunSummary 失败时 | 显示“运行摘要无法读取”，不改变退出码 | T13 | 待决定 |
| Q06 | 同一来源范围被多次 file-read 覆盖时，`VerifiedSource` 记哪一次 | 记最早一次覆盖它的成功读取，使结果确定 | T09 | 待决定 |
| Q07 | Gateway 存根的调用抛错（传输层缺陷，而不是 SyscallRejected）时 Workflow 是否重发 | 不重发，按内部错误处理（R-W19）；M1 没有需要重发的场景，R-C4 的“重发沿用”只是保持幂等的写法 | T10 | 待决定 |
| Q08 | 系统级测试必须放在 `apps/control-plane`，它不属于本分支可直接修改的范围 | 作为单独的测试提交加入 `apps/control-plane/src/bootstrap/`（只新增测试文件，不改产品代码），按共享接缝的规则先进 `feature/M1/main` | T16 | 待决定 |
| Q09 | M1Interface 第 13 节要求每个 Port 有共享 contract test；`packages/testing/src/harnesses` 目前没有两个 Inbox Port 的 | 由本分支补一个同时运行 fake 与产品实现的 Inbox Port contract test，作为共享接缝提交 | T17 | 待决定 |
| Q10 | 展示格式（标题、缩进、来源的写法）规范没有规定 | 纯文本、无颜色、每条结论后列出 `路径:起始行-结束行`；格式由视图函数的快照测试固定，不写进规范 | T13 | 待决定 |

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

## 7. 分步实施计划

每个阶段附带测试；退出条件成立并按第 8 节验证之后才标记完成。阶段按顺序进行，除非表中注明可以并行。
Workflow（T02–T10）与 UserInteraction（T11–T15）互不依赖，可以交替推进，但每个阶段内部要做完再切换。

| ID | 范围 | 退出条件 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T01 | 规范缺口的决定 | Q01–Q10 全部有用户决定；涉及规范的已写回 Workflow.md、UserInteraction.md | — | 未开始 |
| T02 | Workflow 骨架与测试替身 | `createWorkflow` 不再抛错；RunStart 后完成固定与 `registerAgentRun`；固定失败按 `PIN_FAILED` 结束 | T01 | 未开始 |
| T03 | 解释模型返回 | 第 5 节的全部分支有纯函数与测试 | T02 | 未开始 |
| T04 | Validation 与无进展检测 | 第 6 节五项检查、重复调用、`noProgressCount` 有测试 | T03 | 未开始 |
| T05 | 失败处理 | 第 7 节的两张表、最严重者规则、final-call 例外有测试 | T02 | 未开始 |
| T06 | Round、final-call 与额度状态 | 第 8 节的计数、触发条件、WRAP_UP 与 EXHAUSTED 的处理有测试 | T05 | 未开始 |
| T07 | 运行循环 | 启动 Unit、每一轮的组装与模型调用、工具轮的收齐在测试替身上跑通；UnitReport 先于 SyscallAck 的情况有测试 | T03–T06 | 未开始 |
| T08 | 交接 | Planner → CodeViewer 的完整顺序与 `BUDGET_WRAP_UP` 的继承有测试 | T07 | 未开始 |
| T09 | 报告 | 来源核验、正常报告、降级报告、发布与结束顺序有测试；产出的报告通过 Schema | T07 | 未开始 |
| T10 | 结束保证、运行记录与自身错误 | 第 11、11.1、13 节与 `stop()` 契约有测试；性质测试证明任意输入序列都不会停在中间状态 | T08、T09 | 未开始 |
| T11 | UserInteraction 骨架与主流程 | `createUserInteraction` 不再抛错；`createRun` → RunFinished → 退出码 → `shutdown` 跑通；被拒时退出码 4 | T01 | 未开始 |
| T12 | 授权询问与中断 | 询问任务的四种结束方式、`QUESTION_NOT_PENDING`、第一次 Ctrl+C 有测试；Inbox 不被用户输入阻塞 | T11 | 未开始 |
| T13 | 结果展示 | 报告视图、文案表、未知效果、摘要保存失败、`--details` 有测试 | T11 | 未开始 |
| T14 | 自身错误与关闭 | 三处捕获边界与 `stop()` 契约有测试 | T12、T13 | 未开始 |
| T15 | CLI 适配 | 终端适配器的行为有测试；CLI 只经公开入口调用 | T12 | 未开始 |
| T16 | 系统级组合测试 | 真实的两个模块配合 fake Kernel 经 `composeSystem` 跑通全部结束方式与故障注入 | T10、T14、T15、Q08 | 未开始 |
| T17 | Inbox Port 的共享 contract test | fake 与产品实现通过同一组用例 | T10、T14、Q09 | 未开始 |
| T18 | 文档同步与首次合入 | 规范与实现一致；导出分支的 PR 合入 `feature/M1/main`；本分支完成同步 | T16、T17 | 未开始 |
| T19 | 真实链路联调与业务验收 | 真实 Kernel、真实 Executor 与真实模型下完成 M1Plan 5.2、5.3 中属于本分支的退出条件；第二次合入 | T18，以及第 4.2 节的三项 | 未开始 |

T18 是本分支第一次合入 `feature/M1/main`，不等待其他分支。T19 依赖其他分支的交付：它们没有进入
`feature/M1/main` 之前 T19 保持“未开始”，并在第 10.2 节记录等待的内容，不以 fake 通过代替。

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
- 实现 RunStart → `pinAgent(entryAgentRef)` → 有 `handoffTargetRef` 时固定目标并核对 digest → `registerAgentRun`。
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
- SyscallRejected 的两种处理；`failure` 的三个必填字段，`category` 取 `REASON_CODE_CATEGORY`，`source` 恒为 `WORKFLOW`。
- 用目录中真实的六个 Unit 定义的 `failurePolicy` 做表驱动测试，防止实现与定义脱节（只读取，不修改定义）。

### 7.6 T06 Round、final-call 与额度状态

规范：Workflow 第 8 节；Kernel 第 8 节。依赖 Q01。

- `roundsUsed` 只在 model-call 的 UnitReport 为 OK 或 FAILED 时加 1；被 `BUDGET_WRAP_UP`、`BUDGET_EXHAUSTED`、
  `FINAL_CALL_USED` 拒绝的不计。
- 下一次是否为 final-call 的判断；多个原因保留最先设置的。
- WRAP_UP：设置 `BUDGET_WRAP_UP`，本轮已提交的工具 Unit 照常收齐。
- EXHAUSTED：携带它的是返回 FINISH 的 model-call 时照常进入正常报告；否则生成降级报告（`BUDGET_EXHAUSTED`）。
- final-call 的结果不是合法 FINISH（INVALID、失败）时生成降级报告，`wrapUp.reason` 为触发该 final-call 的原因。

### 7.7 T07 运行循环

规范：Workflow 第 4、9.1 节；Kernel 4.4。

- 把 T03–T06 的纯函数接入 reducer：启动 Unit 逐个提交；每一轮 `context-assemble` → `model-call` → 动作。
- `ContextAssembleInput`：`objective`、`final`、`orientPackRef`、`steps`（本 AgentRun 的全部 StepRecord，按发生顺序）、`status`。
- StepRecord 的记录：MODEL_TURN、每个工具结果的 TOOL_RESULT、每条 FEEDBACK；`round` 从 1 开始。
- 待收集合按 `requestId` 管理；UnitReport 先于 SyscallAck 到达时不得丢失或重复处理。
- 应用层只做三件事：从 Inbox 取事件交给 reducer、执行 reducer 给出的动作、把 syscall 的返回值再交给 reducer。
  业务判断不得出现在应用层。
- 测试：单个 Agent 的多轮（工具轮 → FINISH 之前的全部步骤）；启动 Unit 被拒（`USER_DECLINED` 使第一轮即 final-call）；
  Ack 与 Report 的两种到达顺序；一轮多个工具 Unit 的乱序返回。

### 7.8 T08 交接

规范：Workflow 9.2。

- HANDOFF → `endAgentRun(Planner)` → `registerAgentRun(CodeViewer)`（新的 `agentRunId`，`agentRef` 为已固定的目标）→
  CodeViewer 的启动 Unit → 第一轮的 `context-assemble` 携带 `handoff`。
- CodeViewer 的 `roundsUsed`、`steps`、计数器从零开始；Planner 的 AgentRun 不再恢复。
- 携带 HANDOFF 的 model-call 同时使 `budgetState` 变为 WRAP_UP 时，`BUDGET_WRAP_UP` 带入 CodeViewer，
  启动 Unit 之后直接 final-call；其他 `wrapUpReason` 不继承。
- 测试：正常交接；交接中任一 syscall 被拒；继承的情况；Planner 在 final-call 中不能交接（T03 已覆盖解释，这里覆盖流程）。

### 7.9 T09 报告

规范：Workflow 第 10 节；M1Interface 1.4、6.5、6.6。依赖 Q06。

- 来源核验为纯函数：草稿加上已读取的 `FileReadOutput` 列表 → 已核验结论与未确认项。
  覆盖指同一次读取的路径相同且 `[startLine, endLine]` 包含来源范围。
- 组装 AnalysisReport：`readSources` 为全部成功读取的范围；`wrapUp` 在设置了 `wrapUpReason` 时填写；
  `agentRounds` 每个 AgentRun 一项；`snapshotId` 在 orient 成功时填写。
- 降级报告：固定说明、两个列表为空、`degraded = true`、`wrapUp` 必填。
- 发布顺序见 R-W17；`report-publish` 失败按 FATAL。
- 测试：三种未确认原因；部分来源未覆盖的结论整体降为未确认；Planner 直接 FINISH（没有任何读取）；
  降级报告的两种触发；产出的每个报告都用 `AnalysisReportSchema` 校验。

### 7.10 T10 结束保证、运行记录与自身错误

规范：Workflow 第 11、11.1、13 节；SystemFaultHandling 2.2、第 4 节。依赖 Q07。

- RunClosed 的五种 `closeReason` 到业务终态的映射；`unknownEffects` 写入记录。
- `WorkflowRunRecord` 的两次写入与全部字段。
- 自身错误的两层处理（R-W19）：应用层在调用 reducer 与执行动作的外围设置捕获边界，先尝试 `closeRun`；
  这一步也失败时让错误离开处理函数，由 Inbox 的失败观察者上报。
- `stop()`：等待 Inbox 排空；重复调用与未启动时调用安全。
- 性质测试（fast-check）：对任意合法的事件与返回值序列，状态最终必然处于“等待 RunClosed”或“已结束”，
  且不会在收到 RunClosed 之后再发起 syscall。
- 测试：RunClosed 在任意阶段到达（包括有待收的 UnitReport 时）；记录写入失败；reducer 抛错；`closeRun` 也抛错。

### 7.11 T11 UserInteraction 骨架与主流程

规范：UserInteraction 第 2、3、6 节；M1Interface 第 4、5.3、14.2 节。

- 工厂、Inbox、生命周期同 T02 的做法。写模块内的测试替身：可脚本化的 `InteractionGatewayPort` 与记录输出的终端。
- `analyze`：`createRun`；被拒时显示原因并返回 4；成功后等待 RunFinished；记录退出码；`shutdown`；返回。
- 退出码：`EXIT_CODES[closeReason]`，带 `finalizationError` 时取它与 1 中的较大者。
- 此阶段的展示只输出 `closeReason`，完整展示在 T13。
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
  1. 在 Windows 上：`git add -A && git diff --cached HEAD --binary > <补丁文件> && git reset -q`。
  2. 在 WSL 的独立工作副本 `~/MultiAgentOS` 中：`git fetch origin`，检出 `origin/<当前分支>`，`git apply <补丁文件>`，
     然后 `pnpm install --frozen-lockfile`、`pnpm run build`、`pnpm run lint`、`pnpm run format:check`、`pnpm run test`。
  3. WSL 中使用它自己安装的 Node 与 pnpm（登录 shell 的 PATH 已设置），不要使用 `/mnt/c`、`/mnt/d` 下的 Windows 版本。
  4. 需要 `sudo` 的操作请用户执行。
- 原生 Windows 上有一个与本分支无关的已知失败（`agent-tool-pool` 的符号链接测试，`EPERM`），在 Ubuntu 上通过；
  不要为了它修改 `agent-tool-pool`。
- 验证记录写明命令、环境（Windows、WSL、CI）、通过、失败或未运行，以及限制；没有测试证据不标记完成。
- 只改文档时只做格式、链接与差异检查，不宣称业务测试已经执行。

## 9. 提交、推送与合入

### 9.1 提交

- 不自动 commit、push 或创建 PR；每次都等用户明确要求。用户要求提交时，按阶段或按逻辑变更提交，不把多个阶段压成一个。
- Conventional Commits，说明用中文；实现新能力并附带测试与文档时用 `feat:`，只改文档用 `docs:`，只加测试用 `test:`。
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

- 当前阶段：T01，未开始。
- 下一步：向用户确认 Q01–Q10；把需要写回规范的决定写入 Workflow.md 与 UserInteraction.md。
- 阻塞：无。T02 与 T11 都要等 T01 中与其相关的决定，但骨架本身不依赖任何一个问题，
  用户暂时无法回答时可以先做 T02、T11，把问题留到用到它们的阶段之前。
- 工作区：干净；分支没有自己的提交。

### 10.2 等待其他分支的事项

| 事项 | 等待的内容 | 影响阶段 | 状态 |
| --- | --- | --- | --- |
| 产品 Kernel 核心与执行派发 | kernel 分支的后续阶段进入 `feature/M1/main` | T19 | 等待中 |
| 真实的五个 Executor | pool-executor 分支进入 `feature/M1/main` | T19 | 等待中 |
| Prompt 正文与 Tool 描述定稿 | Cary 与 meti | T19 | 等待中 |

### 10.3 完成与验证记录

每完成一个阶段追加一行；记录实际修改的文件、关键不变量与验证证据，不只写“完成”。

| 日期 | 阶段 | 实际变更 | 验证与环境 | 下一步 |
| --- | --- | --- | --- | --- |
| 2026-10-13 | 建立计划 | 创建本文；分支已同步到 `ac368ad` | 只有文档变更，未运行业务测试；基线提交已在 CI（Ubuntu 24.04）通过质量门 | T01 |

### 10.4 更新本文的规则

- 每完成一个可独立验证的阶段，或作出重要决定、发现阻塞，就更新第 6、7、10 节。
- 状态只用：未开始、进行中、待决定、等待中、已完成。
- 更新第 1.2 节的日期与基线；第 10.1 节必须始终反映仓库的真实状态。
- 不记录密钥、完整 Prompt、源码正文或未经脱敏的模型输出。
- 不覆盖用户或其他负责人未提交的改动；每次开始先检查 `git status` 与 diff。
