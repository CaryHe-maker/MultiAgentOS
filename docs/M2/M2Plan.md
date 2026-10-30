# MultiAgentOS M2 计划

> 本文组织 M2 的交付：阶段、工作流、任务与依赖、分支、各阶段的门与退出条件。
> 范围与设计以 [M2Design](M2Design.md) 为准，本文不重新定义机制。本文只按阶段划分，不设日期。

## 1. 权威与范围

- M2 交付什么、怎样设计，以 M2Design 为准；本文只规定按什么顺序、分成哪些任务交付。
- 本文与 M2Design 冲突时以 M2Design 为准，并修正本文。
- 本文决定了 M2Design 第 14.2 节交给本文的两项待决事项（第 8 节）。
- 全部任务由同一位负责人（Cary）承担。任务拆分的首要目标是**让尽可能多的任务同时进行**：
  每个任务有明确的目录归属、只依赖已经合入的契约、有自己能独立运行的测试。

## 2. 组织原则

### 2.1 阶段

阶段与 M2Design 第 15 节一致：0 实测，1 Session 与对话骨架，2 写入与回退，3 命令与沙盒，
4 并行，5 人类在环控制，6 Web，7 Orchestration，8 上下文压缩；最后是发布准备。
阶段 8 的编号只表示它是后加入的阶段：它只依赖阶段 1。
每个阶段结束时系统都可以运行，并通过此前全部阶段的验收。

### 2.2 每个阶段的四道工序

```text
文档门 → 契约门 → 并行实现 → 集成与退出
```

1. **文档门**：本阶段涉及的组件文档章节与 `Interface/` 章节写完并评审，状态改为"已评审"。
   下一阶段的文档门可以在本阶段并行实现期间同时编写。
2. **契约门**：只修改共享接缝（第 4.2 节）：新 major（v1）的 Schema、Port、`packages/testing` 中的 fake
   与契约测试。单独一个 PR，合入后才开始本阶段的并行实现。
3. **并行实现**：本阶段的任务按工作流（第 3 节）同时进行。每个任务只改自己工作流的目录，
   只依赖已合入的契约，用 fake 替代其他组件，不等待其他任务的实现。
4. **集成与退出**：组合根接线、跨组件集成测试、本阶段的验收用例；全部通过后进入下一阶段。

### 2.3 提前任务

不依赖任何跨模块接口的纯函数与独立算法（例如编辑匹配、HTML 转 Markdown、命令拆分、
就绪集合的计算），不必等到所属阶段，可以从阶段 0 起开始，带着自己的单元测试与属性测试完成；
到所属阶段时只需按契约接入。提前任务列在第 7 节。

## 3. 工作流与目录归属

| 工作流 | 代号 | 可以直接修改的目录 |
|---|---|---|
| 契约 | CT | `packages/libraries/contracts`、`packages/testing`、`docs/M2/Interface/` |
| Workflow | WF | `packages/modules/workflow` |
| UserInteraction 与 CLI | UI | `packages/modules/user-interaction`、`apps/cli` |
| Kernel 控制面 | KC | `packages/modules/kernel/src/` 下的 `core`、`gateway`、`monitor`、`scheduler`、Session actor（由 `run-actor` 改写） |
| Kernel 执行面 | KX | `packages/modules/kernel/src/` 下的 `execution`、`supervisor` |
| ExecutorSet | EX | `packages/libraries/executor-set`；每个 Executor 一个子目录，不同子目录的任务可以同时进行 |
| AgentToolPool | PL | `packages/libraries/agent-tool-pool` 及其定义文件 |
| 基础设施 | IF | `packages/infrastructure/**` |
| 集成 | IN | `apps/control-plane`（组合根与验收测试）、`packages/modules/kernel/src/kernel-core.ts` 与 `index.ts` |

- 一个任务只属于一个工作流，只修改该工作流的目录；需要其他目录变化时，拆成另一个任务。
- Kernel 拆成控制面与执行面两个工作流，二者之间经 `packages/modules/kernel/src/interfaces`
  中的内部接口协作；这个目录属于共享接缝，只在契约门中修改。

## 4. 分支与共享接缝

### 4.1 分支

按 [Style](../Style.md) 第 4 节：

- `feat/M2`：M2 的集成分支，从 `main` 创建；M2 发布时经 PR 合入 `main`。
- 工作分支 `<type>/M2/<scope>`，从 `feat/M2` 创建，经 PR 合回。`<scope>` 以任务编号开头，
  例如 `feature/M2/s1-wf-session-log`、`docs/M2/s2-doc-gate`、`chore/M2/s1-contracts`。
- 每个工作分支可以在自己的 git worktree 中开发，互不影响；同一阶段内不同工作流的分支可以同时打开。
- 合入 `feat/M2` 使用 merge commit；分支被其他分支合并之后不再改写历史。

### 4.2 共享接缝

以下内容是各工作流共用的接缝，只在契约门（CT）或集成（IN）任务中修改，不得夹在其他任务的提交里：

| 共享内容 | 说明 |
|---|---|
| `packages/libraries/contracts` | v1 Schema、Port 与跨模块类型；M1 的 v0 Schema 保持冻结 |
| `packages/testing` | fake、fixture 与共享契约测试；fake 只跟随 `Interface/`，不重新定义被替代方的行为 |
| `packages/modules/kernel/src/interfaces` | Kernel 控制面与执行面之间的内部接口 |
| 各包的 `XxxDeps` 与工厂签名 | 定义在 `Interface/` 中 |
| 根目录的构建与检查配置 | `package.json`、`tsconfig*.json`、`eslint.config.js`、`vitest.config.ts`、`pnpm-lock.yaml` |

修改规则：

1. 先合入 `feat/M2`，其他任务分支同步之后再依赖它；不在任务分支之间互相合并未进入 `feat/M2` 的接缝修改。
2. 任务发现接缝缺口时，先用本地 fake 或 Adapter 继续，同时提出一个 CT 任务补齐，不在本任务中修改接缝。
3. 每次从 `feat/M2` 同步之后，在 Ubuntu 24.04 LTS 上运行 `pnpm run check`。

## 5. 依赖总览

```text
阶段 0 ─▶ 阶段 1 ─▶ 阶段 2 ─▶ 阶段 3 ─▶ 阶段 4 ─┬─▶ 阶段 5
                │                               └─▶ 阶段 7
                ├─▶ 阶段 6（只依赖阶段 1，可与阶段 2–5 同时进行）
                └─▶ 阶段 8（只依赖阶段 1，可与阶段 2–7 同时进行）
第 7 节的提前任务从阶段 0 起即可开始
阶段 N+1 的文档门可以在阶段 N 并行实现期间编写
```

阶段 5 与阶段 7 都只依赖阶段 4，二者可以同时进行。
阶段 8 与阶段 2 的交集只有"回退使压缩失效"（验收 L7），由两者中较晚完成的一个实现。

## 6. 各阶段

每个阶段列出：文档门、契约门、可以同时进行的任务、集成与退出条件。
任务编号为 `S<阶段>-<工作流>-<序号>`；"依赖"一栏只列本阶段内的依赖，契约门是所有任务的共同前提。

### 6.1 阶段 0：实测

| 任务 | 内容 | 依赖 |
|---|---|---|
| S0-T-1 | bwrap 实测：在 Ubuntu 24.04 与 WSL 上，以非特权用户运行 M2Design 第 6.1 节的完整 profile，覆盖第 14.1 节列出的各项（挂载顺序、`/dev/null` 覆盖、受保护路径重新挂载不留文件）；记录 AppArmor 限制与修复方法 | — |
| S0-T-2 | DeepSeek 实测：思考内容回传、历史轮缺少思考内容、收尾调用三种组合；四档思考强度是否支持及映射；提示词缓存与摘要请求（M2TechStack 第 3.2 节第 8 项） | — |
| S0-D-1 | 阶段 1 的文档门（第 6.2 节） | — |

三项可以同时进行，提前任务（第 7 节）也可以同时开始。

退出：结果写入 `M2TechStack.md`。实测结果与 M2Design 不符时，先发布 M2Design 新版本，再进入阶段 1。

### 6.2 阶段 1：Session 与对话骨架

**文档门**：

- `Interface/`：README（版本规则与 Schema 清单）、WorkflowKernel（Session、Turn、HUMAN、`readProjectFile`、Session 列表查询）、
  InteractionKernel（Session 请求、人类请求与答复、Session 级与系统级事件）、Persistence（目录、日志记录、引用、实例锁）、
  Definitions（Agent 额度参数与思考强度、`analyze` 模板；`chat` 是代码中的生长规则，不是定义）；
- `Module/` 三篇；`Kernel/` 的 Interaction（Session actor）、Core、Gateway、Execution、Monitor；
- `Library/` 三篇的阶段 1 部分；`Infrastructure/` 的 Persistence、ArtifactStore、ModuleHost、Fabric；
- `M2Security.md` 中 `AGENTS.md` 信任的部分。

**契约门** S1-CT-1：上述接口的 v1 Schema 与 Port；fake Kernel 能产生 Session、Turn、HUMAN 相关的全部事件（运行级、Session 级、系统级三个序列），
fake Workflow 能回答 Session 列表查询与删除；对应的契约测试。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S1-WF-1 | SessionLogStore 的客户端：追加与 fsync、尾部修复、打开时的遗留修复、Session 列表 | — |
| S1-WF-2 | TaskGraph 与 `chat` 生长规则、HUMAN 节点、依据事件记录 Turn | 提前任务 E-WF-1 |
| S1-WF-3 | 上下文投影（跨 Turn、跨 WorkflowRun）：只在末尾追加、`PINNED` 与 `NORMAL` 标注、运行时上下文条目、`AGENTS.md` 的放置、思考内容回传（`replayable`）、超出窗口时的收尾 | 阶段 0 的 S0-T-2 |
| S1-WF-4 | 在新引擎上运行内置模板 `analyze`（plan → view 为条件边），使用第 8.1 节的 M1 额度档案 | S1-WF-2 |
| S1-KC-1 | Session actor 与 Session 管理（由运行 actor 改写）、系统级状态（Session 引用、信任记录）、Session 级与系统级事件、在当前 Session 中继续 | — |
| S1-KC-2 | Turn 的开启与结束、开放输入的静止检查、AWAITING_INPUT、人类请求的转发、`project.instructions` 询问 | — |
| S1-KC-3 | Gateway 的新 syscall 与来源检查 | — |
| S1-KC-4 | Monitor：运行级与 Turn 账本、main 使用 Turn 账本、每个 Agent 的额度参数与启动检查、`analyze` 的 M1 额度档案、工具次数与墙钟上限 | — |
| S1-KX-1 | Execution：按 Session 登记产物归属与保留类别、预览与完整输出的存储（完整输出的上限 `maxFullOutputBytes`）、按 ACTIVE 的 Session 标记保留（启动时一次、之后每小时一次，Session 管理的定时器触发）、删除与新建失败时的清理、按登记时间判断的 `ARTIFACT_EXPIRED`、`message-publish`、`readProjectFile`；ArtifactStore 对已存在正文的写入时间更新与 `put`、`sweep` 的互斥 | — |
| S1-IF-1 | Persistence：只追加的 JSONL 存储、`sessions/` 目录结构、`kernel-execution` 命名空间、实例锁与 Session 锁 | — |
| S1-IF-2 | ArtifactStore：全局内容寻址存储；`sweep` 按保留标记删除 | — |
| S1-EX-1 | `retention/` 共用模块与 M1 三个工具的预览；`repository-list`（`list_files`）；`context-assemble` 不按调用裁剪、收尾调用的保险 | 提前任务 E-EX-4 |
| S1-PL-1 | 定义：main（阶段 1 的只读工具）、`analyze` 模板、带思考强度的 Model 定义、Prompt（`chat` 的生长规则属于 S1-WF-2） | — |
| S1-UI-1 | 终端界面：记录区、活动区、输入区；授权与人类请求的队列；`/new`、`/resume`、`/sessions`、`/delete`、`/status`、`/help`、`/exit`；额度结束后的继续确认；工具结果截断的提示与完整输出的查看；不保存任何 Session 信息 | — |

**集成** S1-IN-1：组合根接线（实例锁在 Supervisor 清理临时数据之前取得）、端到端运行。

**退出**：R（经 `analyze` 回归）、S1–S3、S5–S6、L5（没有压缩的部分）、L6。

### 6.3 阶段 2：写入与回退

**文档门**：Core（能力上限与授权条目、判定顺序、询问合并、超时）、Execution（快照、改动检测、回退步骤）、
Supervisor（影子 git 子进程）、ExecutorSet（`file-write`、`file-edit`、`output-read`）、Workflow（`baseSha`、`expectAbsent`、Fork、
`WORKSPACE_*` 记录、`read_output` 的编号翻译）、UserInteraction（授权选项、回退确认）、`M2Security.md`（写入范围与受保护路径、完整输出的读取隔离）、相应的 `Interface/` 章节。

**契约门** S2-CT-1：AgentRun 登记中的能力上限字段、授权答复的选项、`undoTurns`、`confirmUndo`、`diffTurns`、Fork 请求、
`executor.OutputReadInput` 与 `OutputReadOutput`、`ArtifactOwnerLine.fullOutput`，以及对应的 fake 与契约测试。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S2-KC-1 | Core：能力上限与授权条目、判定顺序 ①–⑤、相同询问合并、`AGENTS.md` 的极危险写入 | — |
| S2-KX-1 | Execution：影子 git 快照（经 Supervisor 的 git 子进程）、快照索引、改动检测 | — |
| S2-KX-2 | Execution：`/undo`、`/undo all`、`/diff` 的六个步骤、兜底快照、写入前复查；打开 Session 时的工作区差异 | S2-KX-1 |
| S2-EX-1 | `file-write`、`file-edit` 与共用的 `isWritable`，属性测试证明三处判定一致 | 提前任务 E-EX-1 |
| S2-EX-2 | `output-read`：按行截取、字面过滤、行号、经 `retention/` 限制结果 | 提前任务 E-EX-4 |
| S2-KX-3 | Execution：`read_output` 的输入检查（归属、`fullOutput` 标记、按登记时间判断过期）与正文解析 | — |
| S2-WF-1 | `baseSha` 与 `expectAbsent` 的填写、Fork（复制日志并列出产物引用）、`WORKSPACE_*` 记录与投影替换 | — |
| S2-WF-2 | `read_output` 的编号翻译：按日志计算发起者的范围（包括已被压缩取代的调用、Fork 继承的历史）、编号重复取最近、找不到时的反馈 | — |
| S2-UI-1 | 授权询问的各级选项、回退确认、`/fork`、`/undo`、`/diff` 的展示 | — |
| S2-PL-1 | main 增加写入工具与 `read_output`；`file-write`、`file-edit`、`output-read` 的 Unit 定义与受保护能力，Tool `read-output` | — |

**集成** S2-IN-1。**退出**：A 组的写入部分、H5、H8–H10、S4、L8（读取已被压缩取代的调用除外）、L7（阶段 8 已完成时）。

### 6.4 阶段 3：命令与沙盒

**文档门**：`M2Security.md` 全文、Supervisor（bwrap、遮蔽、进程组、停止升级、`cancelExecution`）、
SystemFaultHandling（`STOP_UNCONFIRMED` 停机）、Core（命令的级别与资源键、`approvalDigest`、名单、前缀、联网）、
ExecutorSet（`run-command`、`git-inspect`）、`Interface/KernelSupervisor.md`。

**契约门** S3-CT-1：SandboxProfile、按执行取消、执行事实的新字段，以及 fake Supervisor。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S3-KX-1 | Supervisor：以 bwrap 施加 SandboxProfile、遮蔽、环境变量白名单、可用性探测、进程组、SIGKILL 升级、上报 `STOP_UNCONFIRMED` | 阶段 0 的 S0-T-1 |
| S3-KX-2 | Execution：敏感文件列表、受保护路径的新建检查与隔离、EXEC 互斥 | — |
| S3-KC-1 | Core：计算 SandboxProfile、命令的资源键与询问选项、`approvalDigest`、`command.network`、`ask-unisolated` | — |
| S3-KC-2 | `STOP_UNCONFIRMED` 经 `reportSystemFault` 停机 | — |
| S3-EX-1 | `run-command` | 提前任务 E-EX-3 |
| S3-EX-2 | `git-inspect` | — |
| S3-PL-1 | main 增加 `run_command`、`git_inspect` 的定义 | — |
| S3-UI-1 | 命令询问的四个选项、警示样式、"未隔离"提示、停机提示 | — |

**集成** S3-IN-1。**退出**：C1–C5、H6–H7、A 组的命令部分。

### 6.5 阶段 4：并行

**文档门**：Execution（按 AgentRun 分队列、并发类别、等待调用机会）、Scheduler、Monitor（逐级委派）、
Core（写入占用、委派、多个 ACTIVE 的 AgentRun、`agent.spawn`）、Workflow（`run_subagents`、汇合、结果契约、业务熔断）、
AgentToolPool（explorer、worker、额度参数）、相应的 `Interface/` 章节。

**契约门** S4-CT-1：`reserveDelegation`、`releaseDelegation`、登记中的父子关系与视图、`WAIT_CAPACITY`、`QUOTA_EXHAUSTED`。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S4-KX-1 | Execution：按 AgentRun 分队列、并发类别与屏障、全局上限、`serialExecution`、改动归属 | — |
| S4-KC-1 | Scheduler：`WAIT_CAPACITY` 与等待列表、`providerCapacity` | — |
| S4-KC-2 | Monitor：AgentRun 级账本与逐级委派、`minShare` 的派生检查、等待子任务时墙钟暂停 | — |
| S4-KC-3 | Core：写入占用、委派保留、多个 ACTIVE 的 AgentRun、`agent.spawn` 只给顶层 | — |
| S4-WF-1 | `run_subagents` 的校验与图扩展、汇合顺序、结果契约与改动对账、完成检查、业务熔断 | — |
| S4-PL-1 | explorer、worker 的定义与额度参数；main 的派生准则 Prompt | — |
| S4-UI-1 | 活动区的 SubAgent 树、`/timeline` | — |

**集成** S4-IN-1。**退出**：P1–P6、B、D。

### 6.6 阶段 5：人类在环控制

**文档门**：Core（PAUSING、PAUSED、INTERRUPTING、计时冻结、交付条件）、Execution 与 Supervisor（按并发类别处理暂停、
`cancelExecution`）、Workflow（`steer`、`ask_user`、重新提交 READ、中止后的收敛）、UserInteraction（Ctrl+C、`/continue`）。

**契约门** S5-CT-1：`pauseRun`、`resumeRun`、`interruptRun`、`HumanCancelled`、`INTERRUPTED` 报告。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S5-KC-1 | 控制状态与转移、询问计时的冻结、`maxPauseSeconds`；Turn 超时（阶段 5 之前，Turn 的时长由每次执行的截止时间间接约束） | — |
| S5-KX-1 | 按并发类别处理暂停、`cancelExecution`、中止时排队中的尝试也交付 | — |
| S5-WF-1 | `steer` 节点、`ask_user`、重新提交被取消的 READ、中止后的收敛 | — |
| S5-UI-1 | 按键与 `/continue`、待处理请求的队列 | — |

**集成** S5-IN-1。**退出**：H1–H4。

### 6.7 阶段 6：Web

只依赖阶段 1，可以与阶段 2–5 同时进行。

**文档门**：ExecutorSet（`web-search`、`web-fetch`）、Core（`web.search`、`web.fetch` 的资源键与地址拒绝）、
`M2Security.md` 的网络部分、`M2TechStack.md` 中的 Tavily。

**契约门** S6-CT-1：两个 Unit 的输入输出与本地网页 fixture 服务器。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S6-EX-1 | `web-search` 与 Tavily 适配器；本地固定内容服务器 | — |
| S6-EX-2 | `web-fetch`：地址检查、重定向逐跳检查、HTML 转 Markdown | 提前任务 E-EX-2 |
| S6-KC-1 | Core：网络能力的资源键与询问 | — |
| S6-PL-1 | main 增加网页工具；explorer 已存在时同时为它加上 | — |

**集成** S6-IN-1。**退出**：W。

### 6.8 阶段 7：Orchestration

可以与阶段 5 同时进行。

**文档门**：Workflow（模板编译、条件边、有界循环、`all_done`、额度触顶时的确定性报告）、AgentToolPool（模板格式、`research`）、
`Interface/Definitions.md`、Monitor（模板节点从 Turn 账本划出份额）、UserInteraction（`mas run`、`/run`）。

**契约门** S7-CT-1：模板的 Schema 与 `GraphValidationError`。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S7-WF-1 | 使用者模板的读取、编译与校验（含并行可写节点的 `writeScope` 检查） | 提前任务 E-WF-1 |
| S7-WF-2 | 条件边、有界循环、`all_done` 的运行；输出节点未能运行时的确定性运行报告 | — |
| S7-KC-1 | 模板节点的份额从 Turn 账本划出；并行 main 节点的写入占用检查 | — |
| S7-PL-1 | `research` 模板 | — |
| S7-UI-1 | `mas run`（新建 Session、结束后退出）、`/run` | — |

**集成** S7-IN-1。**退出**：O、G。

### 6.9 阶段 8：上下文压缩

只依赖阶段 1，可以与阶段 2–7 同时进行。

**文档门**：Core（压缩过程、检查点、审计）、Execution（摘要请求）、Monitor（压缩的额度）、Interaction（压缩的消息与内部摘要尝试）、
Workflow（压缩的配合与投影替换）、ExecutorSet（摘要请求）、AgentToolPool（`compaction-system`）、UserInteraction（`/compact` 与通知）、
`M2Security.md`（摘要中的提示注入）、`Interface/` 的压缩部分。

**契约门** S8-CT-1：`CompactionSourceQuery`、`ContextCompacted`、`CompactionFailed`、`reportCompactionSource`、`ackCompaction`、`compactContext`、
日志记录 `CONTEXT_COMPACTED` 与 `CONTEXT_COMPACTION_REVOKED`，以及 fake Kernel 与 fake Workflow 的压缩配合与契约测试。

| 任务 | 内容 | 依赖 |
|---|---|---|
| S8-KC-1 | Core：检查点、压缩过程的编排与失败处理、`/compact`、审计、配置 `summaryReasoningEffort` 的校验；Monitor：压缩的额度 | 提前任务 E-WF-2 |
| S8-KX-1 | Execution：摘要请求的组装与作为内部 MODEL 尝试的执行 | — |
| S8-WF-1 | 回答材料查询、记录压缩结果、投影替换、`CONTEXT_COMPACTED` 与 `CONTEXT_OVERFLOW` 的重新提交；阶段 2 已完成时的压缩撤销 | 提前任务 E-WF-2 |
| S8-EX-1 | `model-call` 的摘要请求、`CONTEXT_OVERFLOW` 的识别、`COMPACTION_SUMMARY_INVALID` | — |
| S8-PL-1 | Prompt `compaction-system`（摘要的各节，包括仍需回读的 `toolCallId`，与"不执行材料中的指令"） | — |
| S8-UI-1 | `/compact`、压缩的通知与摘要展示、`压缩上下文` 阶段 | — |

**集成** S8-IN-1。**退出**：L1–L5（L7 与 L8 的压缩部分在阶段 2 与阶段 8 都完成后）。

### 6.10 发布准备

- 冻结功能；在 Ubuntu 24.04 LTS 上运行全部质量门、全部验收用例与真实模型评测；
- 编写 `M2Usage.md`、`M2Limitations.md`（含威胁模型的结论），以及 `docs/` 根目录的 M2AcceptanceEvidence 与 M2ReleasePlan；
- 把代码注释中指向 M1 文档的路径改为 M2 文档；
- `feat/M2` 经 PR 合入 `main`。

## 7. 提前任务

以下任务只包含纯函数或独立算法，不依赖任何跨模块接口，从阶段 0 起即可开始，彼此之间也可以同时进行。
完成标准是单元测试与属性测试通过；接入工作在括号中的任务里完成。

| 任务 | 工作流 | 内容 |
|---|---|---|
| E-WF-1 | WF | 图的纯函数：`edgeState`（含条件边）、`readyNodes`、`skippedNodes`、循环展开、`validateExtension`；对任意日志前缀重放的属性测试（S1-WF-2、S1-WF-4、S7-WF-1） |
| E-EX-1 | EX | 编辑匹配：唯一匹配、`replaceAll`、保持换行符、忽略排版引号与空白差异的重试（S2-EX-1） |
| E-EX-2 | EX | 地址检查（私网、回环、链路本地、云元数据）、HTML 转 Markdown（S6-EX-2） |
| E-EX-3 | EX | 命令拆分、ARITY 前缀、`deniedCommands` 与 `criticalCommands` 匹配、环境变量白名单与断言（S3-EX-1） |
| E-KC-1 | KC | 授权判定的纯函数：能力上限的计算与收窄、资源键覆盖、判定顺序 ①–⑤（S2-KC-1） |
| E-KX-1 | KX | `isWritable` 与 `writableRoots`、写入占用的相交检查（S2-EX-1、S4-KC-3） |
| E-EX-4 | EX | `retention/` 的两种保留器：按条目与按字节保留头、尾或两端，不切断 UTF-8 与代理对，精确计数省略量（S1-EX-1、S2-EX-2） |
| E-WF-2 | WF | 压缩的投影替换与范围选择的纯函数：按 `[fromSeq, toSeq]` 以摘要取代 `NORMAL` 条目、撤销压缩、在完整模型轮边界选定范围（S8-WF-1、S8-KC-1） |

E-KX-1 的函数由 EX 与 KC 共用，完成后在 S2-CT-1 中移入共享接缝；E-WF-2 中范围选择的函数由 KC 使用，完成后在 S8-CT-1 中移入共享接缝。

## 8. 验收标准的补充规定

### 8.1 `analyze` 回归（M2Design 第 14.2 节 #1）

`analyze` 模板固定使用一套 M1 额度档案：运行级 300,000 token；planner 与 code-viewer 共用一份账本，
整个运行只有一次 final-call；关闭思考模式。在这套档案下运行 M1 固定任务集 F1–F5，
成功率与来源完整性不得低于 M1 的验收基线（[M1AcceptanceEvidence](../History/M1/M1AcceptanceEvidence.md)）。

### 8.2 量化标准（M2Design 第 14.2 节 #3）

| 组 | 判定方式 |
|---|---|
| D | 使用固定的判定表：每个任务事先写明"是否适合派生"与可接受的派生方式；运行结果按判定表自动比对，再由负责人逐项复核 |
| P3 | 完工时间不超过关键路径的 1.3 倍；关键路径按同一次运行中各节点的实际耗时计算 |
| O、成本、延迟 | 在各相关阶段退出时，按 M1 的基线方式在固定任务上实测取值，写入验收证据；此后作为回归门槛，后续阶段与发布时的结果不得劣于已记录的值 |

### 8.3 固定任务与 fixture

| 组 | fixture |
|---|---|
| R | M1 的 F1–F5，原样使用 |
| C1–C4 | 各一个固定的 fixture 仓库，测试由测试工具在运行前准备；每个任务写明预期改动范围与通过的测试 |
| C5 | 确定性用例，每一项拦截一个独立的 fixture 或测试 |
| P、B、D、G、O | 各自的固定任务与判定表，在对应阶段的文档门中给出 |
| W | 本地固定内容服务器，包括提示注入页面与指向内网的重定向 |
| S、H、A | 确定性用例，使用 fake 模型 |
| L | 确定性用例，使用记录请求的 fake provider（比对前缀、注入溢出与摘要失败）；L1 另用真实模型跑一段固定的长对话，缓存命中率写入验收证据；L6 与 L8 的过期以假时钟驱动（覆盖启动时与定期回收），L8 的完整输出由产生超长输出的 fixture 命令或文件得到 |

## 9. 完成定义

M2 完成必须同时满足：

- M2Design 第 13 节的全部验收用例通过，第 8 节的量化标准满足；
- M2Design 第 12 节的每条不变量都有对应的测试；
- 每个阶段的文档均为"已实现"，文档与实现一致；
- 在 Ubuntu 24.04 LTS 上，`pnpm run check`、端到端测试与全部验收用例通过；
- M2Usage、M2Limitations、验收证据与 README、索引一致。

## 10. 发布阻断项

M2Design 第 13 节列出的发布阻断项全部适用。此外，以下任一情况也阻断 M2：
不变量缺少测试；`Interface/`、SharedContracts 与 AgentToolPool 不一致；接缝修改未经契约门进入 `feat/M2`；
文档状态与实现不一致。

## 11. 范围控制

范围不足时，可以减少各组 fixture 的数量，或推迟非安全相关的界面功能（如 `/timeline`、`/thinking`），
但不得削减授权两步判定、沙盒、写入占用、额度收尾与必有报告、停机、日志的可重建性与安全验收。
任何范围变化必须先发布 M2Design 新版本，再修改本文。
