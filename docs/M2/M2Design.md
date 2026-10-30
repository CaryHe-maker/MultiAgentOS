# MultiAgentOS M2 设计

> 状态：草案（2026-10-28）。作者：CaryHe-maker。
> 本文是 M2 的总体设计：说明 M2 相比 M1 增加的全部能力、每项能力的机制与 Owner、它们之间的关系，以及验收与交付顺序。
> 字段级接口、Schema 清单与定义实例在实现阶段写入 M2 的接口文档与 Library 文档，本文只给出语义与约束。
> 长期概念与安全边界以 [Architecture](../Architecture/README.md) 为准；M1 已交付的机制以 [docs/M1](../M1/README.md) 为准，
> 本文只写 M2 的变化。本文未提到的 M1 机制在 M2 中保持不变。

## 1. 目标与范围

### 1.1 定位

M1 证明了"由内核治理的 Agent 运行"这条闭环：模型输出只是提案，所有执行经 Kernel 准入、授权、调度、记账与收敛。
但 M1 只读、串行、单次交接、一次运行即结束。

M2 要在**同一个内核**之下同时运行多个 Agent、多个工具，并让它们改代码、跑命令、查网页，
同时保证：

1. **安全**：一切外部副作用只能由 Kernel 产生；写入、命令、联网都经过分级授权，命令在 OS 沙盒中运行；
2. **系统性**：并行的工具与并行的 SubAgent 由同一个 Kernel 统一授权、调度、记账、暂停与中止；
3. **可解释**：模型看到的每一份上下文都能由会话日志重建，任何中断都留下明确的记录。

M2 以工作流为中心：无论是开发者预设的对话（Turn-chat），还是使用者自己编排的流程（Orchestration），
都表达为同一种任务图，由同一条推进规则推进，交给同一个 Kernel 执行。

### 1.2 目标

| 编号 | 目标 | 本文位置 |
|---|---|---|
| G1 | Coding：在仓库内读、写、编辑文件，执行项目命令与测试 | 第 6、8 节 |
| G2 | Web：网页检索与网页读取 | 第 8 节 |
| G3 | 工具并行：一次模型返回中的多个工具调用按并发类别并行执行 | 第 7.1 节 |
| G4 | Agent 并行：主 Agent 在运行时派生带依赖的 SubAgent，依赖满足即启动 | 第 3.5–3.7 节 |
| G5 | 两种模式：Turn-chat 与 Orchestration，共用同一个任务图引擎 | 第 2.2、3 节 |
| G6 | 人类在环：随时暂停、继续（可附加说明）、中止；Agent 主动询问；回退 | 第 4 节 |
| G7 | 分级授权与沙盒：四级能力、两层 Lease、bubblewrap | 第 5、6 节 |
| G8 | Session：多轮对话持续，重开 Session 后对话可以继续 | 第 2.3、10 节 |
| G9 | 终端界面：参照 Claude Code CLI，显示阶段、工具、计时与 SubAgent 树 | 第 11 节 |

### 1.3 非目标

下列能力不属于 M2。遇到相关请求时，系统给出结构化的 Unsupported 结果，而不是静默忽略。

- **跨进程续跑**：进程退出后，正在运行的 WorkflowRun 不能原地恢复。重开 Session 时对话可以继续，但开启的是新的 WorkflowRun（第 2.3 节）。
- **任务图能力**：SubAgent 再派生 SubAgent（嵌套派生）、条件边与循环边、Agent 之间的直接消息传递。
- **无人值守**：无人值守运行（unattended）、定时任务、自动审批。
- **Orchestration 的 Turn**：Orchestration 不设 Turn，因此没有按 Turn 计的额度、快照、`/undo`、`/diff` 与 Fork（第 2.1 节）。
- **脱离操作的权限申请**：不对应任何具体操作、只用来申请权限的工具（第 5.5 节）。
- **扩展与接入**：MCP；使用者自定义 Agent 定义（M2 的模板只能引用内置 Agent）。
- **隔离方式**：Linux 以外平台的沙盒、Landlock 退路、容器与虚拟机级隔离。
- **调度与运行形态**：同一系统内多个 Session 并行运行、调度优先级、多用户、远程执行。
- **显示与上下文**：思考内容与回复的流式显示、由模型生成的上下文摘要（压缩）。

### 1.4 从 M1 到 M2 的变化

| 方面 | M1 | M2 | 位置 |
|---|---|---|---|
| 运行组织 | 一次进程一个运行，运行结束即退出 | 一个进程对应一个 Session 的活动期；Turn-chat 中一个 WorkflowRun 承接多个 Turn | 2.1、2.3 |
| Agent | Planner 单向交接给 CodeViewer，同一时刻一个 ACTIVE | main、explorer、worker；多个 AgentRun 同时 ACTIVE；M1 的两个 Agent 作为内置模板保留 | 3.8、3.9 |
| 任务图 | 无，固定两步 | TaskGraph：AGENT 与 HUMAN 节点、依赖边、不可变的 GraphRevision；就绪即推进 | 3 |
| 模式 | 单次只读分析 | Turn-chat（内置模板 `chat`）与 Orchestration（内置或使用者模板） | 2.2、3.8 |
| 工具 | 概览、检索、读文件 | 增加列目录、只读 git 查看、写文件、编辑文件、执行命令、网页检索、网页读取 | 8 |
| 执行 | 全部 Unit 按 FIFO 串行 | 按 AgentRun 分队列；READ、WRITE、EXEC、MODEL 四类并发类别；运行级并发上限；按 provider 容量分配模型调用 | 7.1 |
| 授权 | `repo.read` 一种能力，每个运行问一次 | 安全、不确定、危险、极危险四级能力；WorkflowRun 级 Lease 由人类签发，AgentRun 级 Lease 由 Kernel 收窄派生；按资源键判定 | 5 |
| 沙盒 | 无（只读） | bubblewrap：可写路径、网络、遮蔽目录由 AgentRun 的 Lease 计算；`.git/`、`.multiagentos/`、`AGENTS.md` 只读 | 6 |
| 额度 | 按 WorkflowRun 一份账本，一次 final-call | WorkflowRun、Turn（仅 Turn-chat）、AgentRun 三级额度；每个 AgentRun 一份收尾保留与一次 final-call；工具次数、墙钟、重复与连续出错熔断 | 7.3 |
| 人类在环 | 开始时一次 Y/N；可以取消 | 分为两个层次：业务输入一律记为 TaskGraph 上的 HUMAN 节点（含 `ask_user`）；授权只由 Kernel 在准入时被动发起。另有暂停、继续、中止、回退等控制操作 | 4 |
| 控制状态 | RUNNING、CONVERGING、CLOSED | 增加 PAUSING、PAUSED、INTERRUPTING、AWAITING_INPUT | 4.3 |
| 持久化 | 运行结束时写一条运行记录 | SessionLogStore：以 Session 为单位的只追加会话日志（归 Workflow）；ArtifactStore 仍归 Execution，改为跨 Session 共享内容、按 Session 登记归属；Kernel 的快照索引；工作区快照、Session 锁、格式版本；Session 延迟创建与 Fork | 10 |
| 上下文 | 按 Round 组装，一次运行内有效 | 由会话日志投影，跨 Turn、跨 WorkflowRun；思考内容回传；确定性裁剪 | 9 |
| 模型 | 关闭思考模式，收尾强制工具选择 | 按 Agent 与任务选择思考强度；回传 `reasoning_content`；收尾调用的新规则 | 9.4 |
| 界面 | 一次输入、一次输出 | 记录区、活动区、输入区；Ctrl+C 暂停与中止；斜杠指令 | 11 |
| 子进程 | 只有 `rg` | `rg`、命令（bwrap + sh）、git（只用于工作区快照） | 2.5 |
| 协议 | v1 冻结 | 变化的 Schema 发布新 major；M1 固定任务集经内置模板 `analyze` 回归 | 7.5、13 |

## 2. 运行模型

### 2.1 概念层次

`{}` 表示抽象对象（定义或持久的身份），`[]` 表示运行实体。

```text
{System}  → [SystemRuntime]                    一个 CLI 窗口 = 一个进程 = 一个 SystemRuntime = 唯一的 Kernel 实例
{Session} → [WorkflowRun] → [TaskGraph]         Session 内的 WorkflowRun 依次进行，同一时刻至多一个活动
            └ [Turn]（仅 Turn-chat）            一条用户主动消息引出的全部工作；Orchestration 中没有 Turn
{Template} → [TaskGraph]                        每个 WorkflowRun 以一个模板开启；模板由 Workflow 编译为 TaskGraph 的初始 GraphRevision
{Agent}   → [AgentRun]                          AgentRun 是 TaskGraph 上的 AGENT 节点
{Unit}    → [UnitRun] → [UnitAttempt]           UnitRun 归 Workflow（业务拓扑中的位置），UnitAttempt 归 Kernel（一次实际执行尝试）
```

| 层 | 定义 | 生命周期 | Owner |
|---|---|---|---|
| SystemRuntime | 一个进程中的整个系统 | 进程启动到退出 | 组合根；Kernel 是唯一的运行决策者 |
| Session | 一个仓库上的持续工作档案：会话日志、产物、工作区快照 | 创建后持久存在，直到用户删除 | Workflow 持久化内容；生命周期指令只由 Kernel 下达 |
| Template | TaskGraph 的定义：节点、依赖、生长规则；有版本，不可变 | 定义层，不是运行实体 | 内置模板在 AgentToolPool，使用者模板在仓库中；由 Workflow 编译。模板不携带任何权限（第 3.8 节） |
| WorkflowRun | 一次受治理的执行期：一张 TaskGraph、一份 Lease 集合、一份运行级额度 | 开启到收敛；不跨进程 | 业务状态归 Workflow，控制状态归 Kernel |
| Turn（仅 Turn-chat） | 一条用户主动消息（`HUMAN(prompt)`）引出的全部工作 | Workflow 以 `beginTurn` 开启、`endTurn` 结束；保存本 Turn 的额度、超时、开始与结束快照、用量与结束原因 | 何时开启与结束由 Workflow 决定（`chat` 模板的规则）；Kernel 把 Turn 当作计量与快照范围维护，不需要知道模板（第 2.3 节） |
| AgentRun | 一个 Agent 在 TaskGraph 上的一次执行 | 登记到结束 | Workflow 持有实例，Kernel 登记身份、Lease 与额度 |
| UnitRun | Workflow 决定要执行的一个 Unit：拓扑中的位置与确定性 ID | 提交到得到结果 | Workflow |
| UnitAttempt | Kernel 为 UnitRun 建立的一次执行尝试；技术重试产生新的 UnitAttempt，UnitRun 不变 | 建立到结果检查 | Kernel.Execution |

**Turn 只属于 Turn-chat。** 在 `chat` 模板的 WorkflowRun 中，每条用户主动消息开启一个 Turn。Turn 是有 ID 的实体，
以下信息都按 Turn 保存与计量：额度、超时、开始与结束快照、`/undo` 与 `/diff`、上下文裁剪的单位、Fork 点、派生上限。
Orchestration 暂不设置同类概念：它的额度、超时与派生上限按整个 WorkflowRun 计，不拍快照，不支持 `/undo`、`/diff` 与 Fork（第 4.6、10.4 节）。

**Turn 的边界是静止点**：Turn 结束时没有 ACTIVE 的 AgentRun、没有在途 UnitAttempt，工作区不会再被改动（由 Kernel 强制，第 2.3 节）。
只有在静止点拍快照，回退才能回到一致的状态；也只有在静止点结算额度，才不会把一个任务的消耗切成两半。
`ask`、`confirm`、`review`、`steer` 发生在工作进行之中，只阻塞相关的 AgentRun，其他 SubAgent 可能仍在写文件、跑命令（第 4.3 节"全局与局部"），
所以它们不是 Turn 的边界。Orchestration 中的询问同样可能与其他分支并行，这也是 Orchestration 暂不设 Turn 的原因。

### 2.2 两种模式

两种模式使用同一种 TaskGraph、同一条推进规则、同一个 Kernel，区别只在图的来源：

| | Turn-chat | Orchestration |
|---|---|---|
| 图的来源 | 内置模板 `chat`：`HUMAN(prompt) → main → HUMAN(prompt) → main → …`，每次 main 回复后追加下一对节点 | 模板文件（内置或使用者编写，第 3.8 节）编译出初始图 |
| 运行中扩展 | main 调用 `run_subagents` 派生子图 | 引用 main 的 AGENT 节点调用 `run_subagents`（派生能力由 Kernel 维护，第 5.2 节） |
| 与用户对话 | 默认在每次 main 回复之后；运行中只在必要时（`ask_user`、授权询问） | 只在模板中的 HUMAN 节点、`ask_user` 与授权询问时 |
| WorkflowRun 何时结束 | 新的 Session 真正创建时（第 2.3 节）、`/exit`、切换 Session、运行级额度耗尽、进程退出 | 图收敛（没有可以就绪的节点）、中止、额度耗尽、进程退出 |
| 在对方之中使用 | — | 在 Turn-chat 中执行 `/run <模板> <目标>`，当前 Turn 的主体换成该模板的实例，结果回到对话中；模板实例属于这个 Turn，照常受 Turn 的额度、超时与回退约束 |

Turn-chat 是 Orchestration 的子集：`chat` 模板只用到 AGENT 与 HUMAN 两种节点，并按固定规则追加。
M2Design 草稿中的 "pre-Orchestration" 在本文中称为 Orchestration。

### 2.3 生命周期规则

**Session**

1. **打开已有 Session**（`/resume`、启动时选择）：UserInteraction 把选择交给 Kernel，由 Kernel 向 Workflow 发出 `SessionOpen` 事件。
   Workflow 收到后取得 Session 锁、校验并修复日志、重建投影（第 10.3 节）。
2. **新建与 Fork 都延迟到第一条提示词提交时才创建**：
   - 用户执行 `/new` 或 `/fork` 只让界面进入"草稿"状态，显示新对话或 Fork 点，不创建任何文件，当前 Session 与 WorkflowRun 也保持不变；
   - 用户在草稿中提交第一条提示词时，UserInteraction 发出 `startSession({ new | fork, prompt })`。Kernel 依次收敛当前 WorkflowRun、释放旧锁，
     再由 Workflow 在 SessionLogStore 中创建新 Session（Fork 时复制日志前缀），由 Kernel 登记产物归属与快照（第 10.4 节），
     然后开启 WorkflowRun，把这条提示词记为第一个 `HUMAN(prompt)`；
   - 用户放弃草稿（`Esc`、`/resume` 回到原对话、退出）时什么都不留下。

   因此每个 Session 至少有一个 `HUMAN(prompt)`，不会出现空的或重复的 Session 副本。
3. 删除 Session、切换 Session 只能由 Kernel 下达：先收敛当前 WorkflowRun，再释放锁，再打开目标 Session。
   删除时由 Workflow 删除 SessionLogStore 中的日志；由 Kernel 删除审计、快照与快照索引，并由 Execution 解除该 Session 对产物的归属（第 10.1 节）。
4. 同一个 Session 同一时刻只能被一个进程打开（`session.lock`）。

**WorkflowRun**

1. WorkflowRun 的开启由 Kernel 下达：打开 Session 之后、`/run`、额度耗尽后用户确认继续时。
   Workflow 追加 `WORKFLOW_RUN_STARTED`，用 `readProjectFile` 读取 `AGENTS.md`（使用者模板也在此时读取），编译模板，再启动第一个节点。
2. WorkflowRun 结束的发起方有两类：
   - Kernel 发起：外部触发的结束，包括用户指令、中止、超时、额度耗尽与安全停止，由 Kernel 进入收敛；
   - Workflow 报告：图自然收敛，以及 Workflow 判定无法继续，由 Workflow 以 `closeRun` 报告（与 M1 相同）。

   两种情况下，最终都由 Kernel 完成收敛并发出 `RunClosed`。
3. **WorkflowRun 不跨进程。** Kernel 的运行状态（Lease、额度账本、在途尝试）只在内存中。进程退出等于 WorkflowRun 结束；
   重开 Session 时 Workflow 先结算遗留记录（第 10.3 节），再由 Kernel 开启新的 WorkflowRun。
   因此 Lease 必然重新签发，额度必然重新计算，不会出现恢复旧授权的问题。
4. 对话的连续性由 Session 保证，而不是由 WorkflowRun 保证：Turn-chat 中 main 的上下文来自整个 Session 的日志投影（第 9.1 节），
   新的 WorkflowRun 中 main 仍然能看到之前的对话。

**Turn（仅 Turn-chat）**

Turn 的开启与结束由 Workflow 显式发起；Kernel 只把 Turn 当作一个计量与快照范围，不需要知道 `chat` 模板。

| syscall | Kernel 检查 | Kernel 动作 | 返回 |
|---|---|---|---|
| `beginTurn({ promptNodeId })` | 本运行没有开启中的 Turn，没有 ACTIVE 的 AgentRun | 1. 分配 `turnId` 与序号；<br>2. 拍摄开始快照，快照完成之前保留本 Turn 的 Unit，不派发；<br>3. 建立 Turn 额度账本（挂在运行级账本之下）与计时；<br>4. 更新 Session 索引 | `turnId` |
| `endTurn({ turnId, reason })` | 本 Turn 没有 ACTIVE 的 AgentRun，也没有在途 UnitAttempt，否则返回 `AGENT_RUN_ACTIVE` | 1. 拍摄结束快照；<br>2. 结算并关闭 Turn 账本；<br>3. 把 `turnId`、序号与两个快照写入快照索引（第 4.6 节） | 用量摘要、两个快照的引用 |

1. **开启**：`chat` 运行中，Workflow 收到 `prompt` 的答复后调用 `beginTurn`，追加 `TURN_STARTED`，再登记本 Turn 的 main。
   这条规则对所有 `prompt` 一律适用，包括用 `/run` 运行模板时输入的那条消息。独立的 Orchestration 运行（`mas run`）不调用 `beginTurn`。
2. **登记**：`registerAgentRun` 带上 `turnId`，Kernel 检查该 Turn 处于开启状态，并把这个 AgentRun 的额度挂在 Turn 账本之下。
3. **结束**：main 回复（或中止、超时、额度耗尽导致本 Turn 收敛）后，Workflow 结束全部 AgentRun，调用 `endTurn`，追加 `TURN_ENDED`
   （结束原因、用量摘要、两个快照的引用），然后请求下一个 `HUMAN(prompt)`。
4. **由 Kernel 发起的结束**：Turn 超时或 Turn 账本耗尽时，Kernel 只发信号（`TurnTimedOut`，或额度状态），由 Workflow 收敛本 Turn 的节点后调用 `endTurn(TIMEOUT | BUDGET)`。
5. **静止保证**：`endTurn` 的检查保证每个 Turn 结束时所有工作都已停止；`requestHuman(prompt)` 只能在没有开启中的 Turn 与 ACTIVE AgentRun 时发起。

| 数据 | 维护者 | 内容 |
|---|---|---|
| `TurnRecord` | Kernel.Core | `turnId`、`workflowRunId`、序号、`OPEN` / `CLOSED`、开启时间、结束原因、用量 |
| Turn 账本 | Kernel.Monitor | 嵌套账本：运行 → Turn → AgentRun |
| 快照索引 | Kernel.Execution | `{ turnId, seqNo, startSnapshot, endSnapshot }`，持久化在 Kernel 命名空间 |
| `TurnProjection` | Workflow | `turnId`、序号、提示节点、本 Turn 的节点集合、回复引用、结束原因；由 `TURN_STARTED`、`TURN_ENDED` 投影得到，不另存 |

**Workflow 负责**：按 `chat` 规则决定开启与结束；把 `prompt` 节点与 Turn 对应起来；登记时带 `turnId`；写 `TURN_*` 记录；
按 Turn 标注上下文裁剪、在回退后替换历史；收到 Kernel 的超时与额度信号后收敛节点再 `endTurn`。
**Kernel 负责**：`endTurn` 时的静止检查、Turn 额度、计时、快照与快照索引。
将来 Orchestration 若需要回退，可以在整个运行外层调用一次 `beginTurn`，不需要修改 Kernel。

### 2.4 所有权

| 数据或决定 | Owner | 其他组件能做的 |
|---|---|---|
| TaskGraph、节点状态、推进、上下文组装输入、会话日志（SessionLogStore） | Workflow | Kernel 只看到 AgentRun 登记与 UnitIntent |
| 人类请求（HUMAN 节点）的业务含义；Turn 的开启与结束 | Workflow | Kernel 转发请求与答复；Turn 由 Workflow 以 `beginTurn` / `endTurn` 开启与结束，Kernel 维护它的额度、计时与快照 |
| 授权询问、Lease、SandboxProfile | Kernel.Core | Workflow 只得到裁决与原因码 |
| 运行控制状态（第 4.3 节） | Kernel.Core | Workflow 与 UserInteraction 经事件得知 |
| 额度账本、熔断计数 | Kernel.Monitor | Workflow 只得到 `budgetState` 与触顶项，不持有 token 数值 |
| 执行机会 | Kernel.Scheduler | — |
| UnitAttempt、产物（ArtifactStore，包括用户输入的正文）、工作区快照与快照索引 | Kernel.Execution | Workflow 只持有 ArtifactRef |
| 子进程、沙盒施加 | Kernel.Supervisor | — |
| 终端界面、输入解析 | UserInteraction | 只经 Gateway 发出请求 |

只有 Kernel 能让 Agent 的行为产生外部副作用。Workflow 与 UserInteraction 只能持久化自身数据，以及系统数据目录中属于自己命名空间的数据。

### 2.5 进程模型

M2 仍是单进程。Workflow、UserInteraction、Kernel 的全部组件与 Executor 在同一个进程中，经 Fabric 以可序列化消息协作（与 M1 相同）。
只有以下执行以子进程运行，并统一由 Supervisor 启动、计时、终止与回收：

| 子进程 | 用途 | 隔离 |
|---|---|---|
| `rg` | 仓库检索（M1） | 无写入 |
| `bwrap … sh -c <命令>` | `run_command` | 第 6 节的沙盒 |
| `git`（使用独立的 `GIT_DIR`） | 工作区快照与恢复（第 4.6 节） | 只读写快照目录与工作区 |
| `git`（只读子命令） | `git_inspect`（第 8.1 节） | 沙盒中只读运行，不联网，禁用外部 diff、textconv、hooks 与 fsmonitor |

子进程放在独立的进程组中，终端的 Ctrl+C 不会直接送达子进程；停止子进程只能由 Supervisor 完成。
模型调用与网页请求在进程内完成。凭据只在执行时交给对应的 Executor，不进入任何子进程的环境。

## 3. Workflow：任务图与推进

### 3.1 节点与边

| 节点种类 | 含义 | 完成条件 |
|---|---|---|
| `AGENT` | 一个 AgentRun：引用一个内置 Agent 定义，带目标、可写范围、额度份额与思考强度 | 该 AgentRun 调用结束控制工具（`reply`、`finish_subagent`、M1 的 `finish`），或以失败结束 |
| `HUMAN` | 一次业务层的用户输入，种类见第 4.2 节：`prompt`、`steer`、`ask`、`confirm`、`review` | 收到符合答复 Schema 的答复，或询问超时；初始 `prompt` 与 `steer` 在创建时就已带有用户输入，创建即完成 |

| 关系 | 含义 |
|---|---|
| `dependsOn`（边） | 前驱全部 SUCCEEDED 后，后继才可以就绪；多个前驱即为汇合 |
| `attachedTo`（附属） | HUMAN 节点附属于一个 AGENT 节点：由该 AgentRun 发起的 `ask_user`，或投递给该 AgentRun 的 `steer`。附属关系不参与就绪判定，只决定答复交给谁 |

M2 只有 `dependsOn` 一种边。`Edge` 保留 `kind` 字段，供 M3 增加条件边与循环边。

**TaskGraph 上的每一次用户输入都记为一个 HUMAN 节点**，没有例外：Turn-chat 的第一条提示词、之后的每条消息、
`mas run` 给出的目标、暂停后继续时附加的说明、对 `ask_user` 与模板询问的回答。
HUMAN 节点只表达业务输入，不是 Unit（Unit 是 Kernel 执行的操作，而人类输入不是执行），也不是授权（第 4.1 节）。
这一区分保证了不变式"等待人类时没有在途 UnitAttempt"（第 12 节）。

节点状态：`PENDING → READY → RUNNING → SUCCEEDED | FAILED | SKIPPED | INTERRUPTED`。状态只由日志记录投影得到。

### 3.2 GraphRevision

- TaskGraph 是一串只追加的 GraphRevision。每个 Revision 是不可变的规格：节点、边、可写范围、额度份额、思考强度。
- Revision 有两个来源，经过同一个校验函数 `validateExtension(当前图, 提议) → GraphRevision | GraphValidationError[]`：
  - 模板编译：初始 Revision；`chat` 模板按它的生长规则在每次 main 完成后追加一对节点（第 3.8 节）；
  - `run_subagents`：运行时扩展。
- 节点 ID 由 Workflow 确定性生成：`<workflowRunId>/<revision>/<名称>`。模型给的名称只在一次调用内唯一；ID 由 Workflow 生成，所以模型在不同调用中重复使用同一个名称也不会冲突。
- UnitRun ID 为 `<agentRunId>/round-<n>/<序号>`。重放日志得到相同的 ID，Kernel 按 `requestId` 去重，因此重复提交是幂等的。

### 3.3 推进规则

推进是日志投影的纯函数：

```text
readyNodes(revisions, status) =
  { n | status(n) = PENDING 且 n 的所有 dependsOn 前驱为 SUCCEEDED }
skippedNodes(revisions, status) =
  { n | status(n) = PENDING 且某个前驱为 FAILED、SKIPPED 或 INTERRUPTED }
```

Workflow 处理每条 Inbox 事件的顺序固定为：

1. 追加日志；
2. 更新投影；
3. 把 `skippedNodes` 记为 `SKIPPED(DEPENDENCY_FAILED)`；
4. 对 `readyNodes` 中的每个节点追加 `NODE_STARTED`，再启动它：AGENT 节点登记 AgentRun，HUMAN 节点发起人类请求。

- **就绪即推进**：任一节点完成后立即计算新的就绪节点，没有超步屏障。M2 借鉴 MAF 的是拓扑模型（节点、有类型的结果、扇出与汇合），推进方式不采用超步。
- **结果逐个记录**：每个节点一结束就追加 `NODE_ENDED`，不等同批的其他节点。
- 属性测试：对任意日志前缀，重放得到的就绪集合与运行时一致。

### 3.4 AgentRun 内部的推进

AgentRun 内部沿用 M1 的 Round：context-assemble → model-call → 该次返回要求的全部工具 Unit 结束。M2 的变化：

1. 一轮的工具 Unit 一次全部提交，由 Kernel 按并发类别执行（第 7.1 节）。下一轮的 context-assemble 在本轮全部工具 Unit 得到结果后才提交；
   等待授权询问的 Unit 仍算"未结束"。
2. 模型返回中，控制工具与普通工具不得混用（M1 的 `CONTROL_MIXED` 规则保留）。
3. M1 的 Validation、`failurePolicy`、无进展检测、重新生成上限照常适用，作用于每个 AgentRun。
4. 收到 `INTERRUPTED` 的 UnitReport 时按第 4.4 节处理，不计 Round。

### 3.5 控制工具

控制工具由 Workflow 解释，不是 Unit，不进入 Kernel。

| 控制工具 | 谁可用 | 效果 |
|---|---|---|
| `reply` | main | 以文字结果完成本节点，结束该 AgentRun。是否把结果发布给用户（内建 Unit `message-publish`）、之后追加什么节点，由模板决定：`chat` 模板发布回复并追加下一个 `HUMAN(prompt)`；其他模板只发布 `output: true` 节点的结果 |
| `run_subagents` | AgentRun Lease 中含 `agent.spawn` 的 AgentRun（M2 中只有顶层的 main） | 扩展 TaskGraph（第 3.6 节）；调用方进入"等待子任务"，所有子任务结束后，它收到汇合结果作为这次调用的工具结果 |
| `finish_subagent` | explorer、worker | 以结构化结果结束本 AgentRun（第 3.7 节） |
| `ask_user` | main、worker（explorer 不可用） | 在 TaskGraph 上追加一个附属于调用方的 `HUMAN(ask / confirm / review)` 节点：向用户提问、请用户确认，或向用户展示一个产物并请求审阅；答复作为这次调用的工具结果 |
| `finish`、`handoff-to-code-viewer` | M1 的 planner、code-viewer | 只在 `analyze` 模板中使用，语义见第 3.8 节 |

`ask_user` 与 `run_subagents`、`handoff` 一样，是 Agent 主动改变任务图的控制工具：
它只阻塞调用它的 AgentRun，其他 AgentRun 照常推进。参数为种类、问题文本、可选的结构化字段（字段类型只有文本、多行文本、单选、多选、确认五种，
其他类型降级为文本）与 `review` 时要展示的 ArtifactRef。

**M2 不提供单独申请授权的控制工具。** 授权只在 Agent 调用一个具体工具、由 Kernel 准入判定时发生；`ask_user` 的答复也不能产生授权（第 5.5 节）。

### 3.6 `run_subagents`

```ts
run_subagents({
  tasks: {
    name: string;            // 本次调用内唯一
    agent: 'explorer' | 'worker';
    goal: string;
    dependsOn?: string[];    // 本次调用内其他任务的 name
    writeScope?: string[];   // 仓库内相对路径；worker 必填，explorer 不得填写
    inputs?: ArtifactRef[];  // 调用方显式交给它的产物，只能是调用方可读的
    acceptance?: string[];   // 验收标准，≤10 条，每条 ≤300 字符
    effort?: 'none' | 'low' | 'high' | 'max';  // 必须在该 Agent 允许的范围内
    budget?: { tokens?: number; toolUnits?: number; wallClockMs?: number };
  }[];
})
```

校验规则：任一规则不满足，整次调用都不执行；以结构化错误生成 `FEEDBACK(INVALID_ACTION)`，并附修正建议。

| 规则 | 错误 |
|---|---|
| 任务数 ≤ `maxSubagentsPerCall`（缺省 4） | `TOO_MANY_TASKS`（写明本次数量与上限） |
| `name` 不重复；`dependsOn` 只引用本次调用中的任务 | `DUPLICATE_NAME`、`UNKNOWN_DEPENDENCY` |
| 无环，依赖深度 ≤ `maxDependencyDepth`（缺省 2） | `CYCLE`、`TOO_DEEP` |
| worker 有 `writeScope`，explorer 没有 | `WRITE_SCOPE_REQUIRED`、`WRITE_SCOPE_FORBIDDEN` |
| `writeScope` 规范化后在调用方的可写范围之内；已存在的前缀做 realpath 后仍在仓库内，且根目录不是符号链接 | `WRITE_SCOPE_OUTSIDE` |
| 任意两个可能同时运行的任务（彼此之间没有依赖路径）`writeScope` 不相交 | `WRITE_SCOPE_OVERLAP`（建议加依赖或拆分范围） |
| `effort` 在 Agent 允许的范围内 | `EFFORT_NOT_ALLOWED` |
| 累计任务数 ≤ `maxTasks`（缺省 12）；`run_subagents` 调用次数 ≤ `maxRevisions`（缺省 4）。Turn-chat 中按 Turn 计，Orchestration 中按 WorkflowRun 计 | `SPAWN_LIMIT` |

调用方连续 2 次校验失败，或触及 `SPAWN_LIMIT` 时，Workflow 从它之后的工具列表中收回 `run_subagents`，并以 FEEDBACK 告知它自行完成。

**执行语义**

- `budget.tokens` 被限制在该 Agent 缺省份额的 0.25–2 倍之间（第 7.3 节），超出的值按边界截取，并在汇合结果中注明。
- 任务在就绪时才登记 AgentRun，并由 Kernel 校验 Lease 与额度（第 5.1、7.3 节）。登记被拒的任务记为 `FAILED`，原因码随之记录，依赖它的任务记为 `SKIPPED`。
- 调用方在等待期间没有在途 Unit，它的墙钟上限暂停计时。
- 汇合结果按调用参数中任务的书写顺序排列，不按完成顺序，以保证上下文可以复现、前缀缓存可以命中。未满足的验收条目、失败与跳过的任务排在每项的最前面。
- 同一 Turn（Orchestration 中同一 WorkflowRun）内可以多次调用 `run_subagents`（分批派生）：先调研，再按结果派生修改任务。

### 3.7 结果契约

每个可以被派生的 Agent（explorer、worker）在定义中声明 `finish_subagent` 的结果 Schema：

```ts
// explorer
{ summary: string; findings: { claim: string; evidence: ArtifactRef[] }[];
  openQuestions?: string[]; acceptance?: AcceptanceAnswer[] }
// worker
{ summary: string; changedFiles: string[]; status: 'done' | 'partial' | 'blocked';
  validation: { command: string; exitCode: number; outputRef: ArtifactRef }[];
  blockers?: string[]; acceptance?: AcceptanceAnswer[] }
type AcceptanceAnswer = { index: number; verdict: 'met' | 'not_met' | 'unknown'; evidence?: ArtifactRef[] }
```

1. **Schema 校验**：Workflow 按 Schema 校验 `finish_subagent`。不合格时以 FEEDBACK 退回，计入该 AgentRun 的 Round。
2. **验收条目**：只做形式检查，即每条验收标准都有回应，不判断内容是否属实。
3. **改动对账**：Kernel 在 UnitReport 中返回每次 WRITE 与 EXEC 实际改动的文件（新增、修改、删除），检测方法见第 7.1 节。Workflow 把 worker 自报的 `changedFiles` 与实际改动对比，不一致之处在汇合结果中标注。
4. **完成检查**：worker 写过文件，但最后一次写入之后没有任何成功的 `run_command` 时，Workflow 在接受它的 `finish_subagent` 之前返回一次 FEEDBACK："已修改文件但尚未运行验证命令"。每个 AgentRun 最多触发一次。

### 3.8 模板

模板是一个 YAML 文件，编译为初始 GraphRevision，与 `run_subagents` 经过同一个校验函数。

```yaml
# <repo>/.multiagentos/workflows/research.yaml
id: research
version: v1.0.0
nodes:
  - name: clarify
    kind: HUMAN
    request: { type: ask, text: "调研范围或时间上有什么限制？" }
  - name: plan
    kind: AGENT
    agent: main
    goal: "根据问题写出调研简报，必要时派生 explorer 调研"
    dependsOn: [clarify]
  - name: review
    kind: HUMAN
    request: { type: review, artifactFrom: plan }
    dependsOn: [plan]
  - name: report
    kind: AGENT
    agent: main
    goal: "根据审阅意见写出最终报告"
    dependsOn: [review]
    output: true            # 该节点的回复作为运行结果发布
```

- **模板位置**：内置模板在 AgentToolPool 中，使用者模板在仓库的 `.multiagentos/workflows/` 下。使用者模板经 `readProjectFile` 读取（第 7.5 节），模板内容属于仓库材料。
- **模板不携带权限**：能力、派生能力与授权都由 Kernel 依据 Agent 定义与 Lease 维护（第 5 节）。模板中的 `writeScope`、`budget`、`effort` 只是请求，登记 AgentRun 时由 Kernel 校验并只能收窄；模板不能给节点增加能力，也不能开启或关闭派生。
- **HUMAN 节点**：`mas run` 给出的目标记为图的根节点 `HUMAN(prompt)`，模板中的节点都直接或间接依赖它。模板可以预设任意多个 HUMAN 节点，种类为 `ask`、`confirm`、`review`，可以串联、可以出现在并行分支上。
  `prompt` 不能由模板预设：它表示用户主动发起的开放输入，并要求全图静止（第 2.1 节）。模板中间的询问可能与其他分支同时进行，不满足这个条件。Orchestration 没有 Turn（第 2.1 节）。
- **字段**：节点只能引用内置 Agent；可以设置 `goal`、`writeScope`、`effort`、`budget`、`output`；前一节点的结果自动作为后一节点的输入。
- **两类模板**：普通模板是一张有限的静态图，编译一次即完整；`chat` 是一条生长规则：初始图为 `HUMAN(prompt) → main`，每当 main 完成，发布它的回复并追加 `HUMAN(prompt, requested) → main`。这条规则写在内置代码中，不用 YAML 表达。
- **内置模板**：
  - `chat`：Turn-chat；
  - `analyze`：M1 的只读分析，planner → code-viewer。planner 的交接在图上表达为一条依赖边，交接内容（`HandoffBrief`）作为 code-viewer 的输入，M1 的 Agent 与 Prompt 定义原样使用；
  - `research`：上例，用于与 Turn-chat 对比的验收。
- **运行方式**：`mas run <模板> "<目标>"` 开启一个 Orchestration WorkflowRun；在 Turn-chat 中使用 `/run <模板> <目标>`，在当前 WorkflowRun 中以模板实例作为本 Turn 的主体。

### 3.9 内置 Agent

| Agent | 能力 | 思考强度 | 派生（`agent.spawn`） | 结束工具 | 缺省上限（Round / 工具 Unit / 墙钟） |
|---|---|---|---|---|---|
| `main` | 读、列目录、检索、只读 git、写、编辑、命令（可以联网，每次询问）、网页检索与读取 | `high`（允许 `none`–`max`） | 有（仅顶层 AgentRun） | `reply` | 40 / 200 / Turn 超时 |
| `explorer` | 读、列目录、检索、只读 git、网页检索与读取 | `none`（允许 `none`、`low`） | 无 | `finish_subagent` | 20 / 60 / 10 分钟 |
| `worker` | 读、列目录、检索、只读 git、在 `writeScope` 内写与编辑、命令（不联网） | `high`（允许 `low`–`max`） | 无 | `finish_subagent` | 30 / 120 / 20 分钟 |
| `planner`、`code-viewer` | M1 原样 | 关闭 | 无 | M1 原样 | M1 原样 |

能力列表就是 Agent 定义中的能力白名单，没有列出的一律不可用（第 5.1 节）。
main 的启动 Unit 是 `repository-orient`，只在每个 WorkflowRun 的第一个 Turn 执行一次；之后由 main 按需调用 `list_files`。
上下文中标出概览对应的快照，提醒它概览可能已经过时。
main 的派生准则写进它的 Prompt，要点如下：
- 只有任务独立、或依赖明确时才派生；
- 调研类任务 1–3 个，修改类任务 2–4 个；
- 依赖不确定时先派生 explorer 调研；
- 比较类问题，每个比较对象一个任务；
- 能回答时就停止派生；
- 每次派生前，先写出已知事实、剩余计划与当前进度（借鉴 Magentic 的任务账本）。

## 4. 人类在环

### 4.1 两个层次：业务输入与授权

用户参与运行有两种性质完全不同的方式，分属两个层次，M2 必须把它们分开：

| | 业务输入（HUMAN 节点） | 授权（Lease 签发） |
|---|---|---|
| 层次 | Workflow，TaskGraph 上的节点 | Kernel.Core，不在 TaskGraph 上 |
| 内容 | 提示词、补充说明、问题的回答、确认、审阅意见：改变 Agent **要做什么** | 是否允许某个能力作用于某个资源：决定 Agent **能做什么** |
| 谁发起 | 用户主动输入；模板预设；Agent 调用 `ask_user` | **只由 Kernel 发起**：Agent 调用工具，Core 判定时发现没有覆盖的 Lease，才向用户询问（第 5.3 节） |
| Agent 能否主动发起 | 能（`ask_user`） | 不能单独发起。Agent 调用具体工具（参数中带上该操作需要的资源，如 URL、命令、`network: true`），由 Kernel 判定后决定是否询问 |
| 用户的回答成为什么 | HUMAN 节点的结果，进入模型上下文 | Lease 条目，只在 Core 内存中，不进入模型上下文 |
| 记录 | Workflow 日志：`HUMAN_REQUESTED`、`HUMAN_ANSWERED` | Kernel 审计；Workflow 日志中只有 `LEASE_REQUESTED`、`LEASE_DECIDED` 两种审计用记录，它们不是 HUMAN 节点 |
| 阻塞范围 | 依赖它的节点，或提问的 AgentRun | 等待该授权的那个 UnitAttempt |
| 通道 | `requestHuman` → `HumanRequest` → `answerHuman` | `AuthorizationRequest` → `answerAuthorization`（M1 机制扩展） |

两个层次互不转换：
- HUMAN 节点的答复不产生 Lease。例如用户在 `ask_user` 中回答"可以运行命令"，并不构成授权；
- 授权的结果也不成为 HUMAN 节点。

界面上两类请求按到达顺序排在同一个队列中，但以不同样式显示，每一项都标明来自哪个任务、哪个 Agent。

此外还有第三类操作：暂停、继续、中止、回退、差异查看。它们是用户直接对运行发出的控制操作（ControlOperation，第 4.3、4.6 节），
既不是业务输入，也不是授权。继续时附加的说明是业务输入，记为 `HUMAN(steer)`（第 4.5 节）。

### 4.2 HUMAN 节点

| 种类 | 由谁产生 | 何时创建 | 关系 | 完成 |
|---|---|---|---|---|
| `prompt` | 用户主动输入：Turn-chat 的第一条提示词与之后的每条消息、`mas run` 的目标、`/run` 的目标 | 两种来源（`origin`）：<br>- `initial`：只用于 Session 的第一条消息（新建或 Fork）与 `mas run` 的目标，节点创建时已带有内容；<br>- `requested`：此后运行中的 `prompt` 一律是请求式，main 回复后 Workflow 先创建节点并发出请求，系统进入 AWAITING_INPUT，用户输入后完成 | 下游的 main AgentRun 或模板实例依赖它 | 收到用户输入；`chat` 运行中 Workflow 随即 `beginTurn` |
| `steer` | 用户在暂停后附加的说明 | 用户 `/continue <说明>` 时创建，创建时已带有内容 | 附属于目标 AgentRun | 创建即完成；内容出现在目标下一次组装的上下文末尾 |
| `ask`、`confirm`、`review` | 模板预设，或 Agent 调用 `ask_user` | 模板节点在就绪时请求；`ask_user` 在调用时请求 | 模板节点：后继依赖它；`ask_user`：附属于调用方 | 收到符合 `answerSchema` 的答复，或超时 |

| 字段 | 内容 |
|---|---|
| `request` | 问题文本、结构化字段、要审阅的 ArtifactRef（`prompt` 与 `steer` 没有） |
| `answerSchema` | 由种类与字段决定；Workflow 校验答复后才把节点标为 SUCCEEDED |
| `content` | 用户输入的正文：UserInteraction 交给 Kernel，由 Execution 存入 ArtifactStore，引用随 `HumanAnswered` 交给 Workflow；节点只记录引用 |
| 超时 | `prompt` 不超时（空闲等待）；`ask`、`confirm`、`review` 在 `humanRequestTimeoutMs`（缺省 10 分钟）后以 `{ timedOut: true }` 作为答复，提问方据此继续 |

- `initial` 与 `requested` 的区分只适用于 `prompt`。`steer` 由用户在暂停时主动发起，系统并没有在等它，所以始终在创建时带入内容、创建即完成，不经过请求。
- 每个 HUMAN 节点都在 Workflow 日志中留下记录：请求时追加 `HUMAN_REQUESTED`，得到输入时追加 `HUMAN_ANSWERED`；初始 `prompt` 与 `steer` 只有 `HUMAN_ANSWERED`。
- 重开 Session 时，若最后一个 `HUMAN_REQUESTED` 没有答复，就重新展示这个问题（第 10.3 节）。
- 用户输入在 UserInteraction 中分配 ID，经 Kernel 转交 Workflow。Kernel 只转发，不解释内容。

### 4.3 WorkflowRun 的控制状态

控制状态归 Kernel.Core，在 M1 的 RUNNING、CONVERGING、CLOSED 之外增加四种：

| 状态 | 含义 | 准入 |
|---|---|---|
| RUNNING | 正常推进 | 开放 |
| PAUSING | 用户已请求暂停，等待在途 UnitAttempt 按第 4.4 节收敛 | 新的 UnitAttempt 保留在队列中，不派发 |
| PAUSED | 暂停中，在途 UnitAttempt 数为 0 | 同上；可以回答授权询问与人类请求，答复在继续后生效；授权询问与人类请求的超时计时冻结，继续后接着计时 |
| INTERRUPTING | 用户已请求中止，正在取消在途工作 | 拒绝 `registerAgentRun`、`submitUnit`（`RUN_BLOCKED`）；放行 `endAgentRun`、`requestHuman(prompt)`、`closeRun` |
| AWAITING_INPUT | 有待答复的请求式 `HUMAN(prompt)`，没有开启中的 Turn、没有 ACTIVE 的 AgentRun，也没有在途 UnitAttempt | 只放行回答、ControlOperation 与关闭 |
| CONVERGING、CLOSED | M1 原样 | M1 原样 |

```text
RUNNING        ──pauseRun──────────────────────▶ PAUSING ──在途 = 0──▶ PAUSED
PAUSED         ──resumeRun(说明?)──────────────▶ RUNNING             （保留的尝试依次派发）
PAUSED         ──暂停超过 maxPauseSeconds───────▶ INTERRUPTING        （缺省 1800 秒）
RUNNING / PAUSING / PAUSED ──interruptRun──────▶ INTERRUPTING
INTERRUPTING   ──Workflow endTurn 后请求 HUMAN(prompt)，在途 = 0──▶ AWAITING_INPUT   （Turn-chat）
INTERRUPTING   ──Workflow closeRun(CANCELLED)───▶ CONVERGING              （Orchestration）
RUNNING        ──Workflow endTurn 后请求 HUMAN(prompt)──▶ AWAITING_INPUT
AWAITING_INPUT ──answerHuman(prompt)───────────▶ RUNNING             （Workflow 随即 beginTurn）
AWAITING_INPUT ──/undo、/diff───────────────────▶ AWAITING_INPUT
任意非终态      ──超时、额度耗尽、安全停止、shutdown──▶ CONVERGING ──▶ CLOSED
```

每次状态变化，Core 都经 Outbox 通知 Workflow（`RunPaused`、`RunResumed`、`RunInterrupted`）与 UserInteraction（`RunStateChanged`）。
Workflow 为每次变化追加对应的日志记录。

**全局与局部**：只有用户主动暂停与中止作用于整个 WorkflowRun。授权询问、`ask_user`、模板中的 HUMAN 节点只阻塞依赖它的工作，其他 AgentRun 照常推进。
这样一个 worker 等待命令授权时，不会取消其他 Agent 正在进行的模型调用。

### 4.4 暂停时在途 Unit 的处理

| 并发类别 | 进入 PAUSING 时 | 结果 | 继续时 |
|---|---|---|---|
| READ（检索、读文件、网页、context-assemble） | 允许完成；超过 `pauseDrainMs`（缺省 5 秒）则取消 | 完成：照常交付；取消：`INTERRUPTED(PAUSED)` | Workflow 重新提交被取消的 READ（只读，可以安全重跑） |
| WRITE | 允许完成（取消可能留下写了一半的文件） | 照常交付 | — |
| MODEL | 取消请求，已消耗的 token 照常结算 | `INTERRUPTED(PAUSED)`，不计 Round | Workflow 重新组装上下文后再提交；附加的说明因此可以进入新的上下文 |
| EXEC | 取消，等待 Supervisor 确认进程组已退出（M1 的停止确认与宽限期） | `INTERRUPTED(PAUSED)` | **不自动重跑**；给模型的工具结果写明"命令被暂停打断，可能未完成"，由模型决定是否重跑 |
| 已排队、尚未派发 | 保留在队列中 | 不交付 | 依次派发 |
| 等待授权 | 询问保留 | — | 照常 |

`INTERRUPTED` 是 M2 新增的 UnitReport 状态，与 OK、REJECTED、FAILED 并列。日志中只有"完整完成"或"明确中断"两种记录，
不写半截的记录；被打断的模型输出作为失败的尝试记录，不进入模型历史。

### 4.5 继续、附加说明与中止

| 操作 | 语义 |
|---|---|
| 继续 `/continue` | PAUSED → RUNNING；按第 4.4 节重新提交 |
| 继续并附加说明 `/continue <说明>`，或暂停时直接输入的普通消息 | 同上。Workflow 先在 TaskGraph 上创建一个附属于目标 AgentRun 的 `HUMAN(steer)` 节点，记录说明，再恢复推进：<br>- 继续本身是控制操作，附加的说明是业务输入；<br>- `steer` 不开启新的 Turn；<br>- 目标缺省为本 Turn 的 main，可用 `/continue @<任务名> <说明>` 指定；<br>- 说明在目标下一次组装上下文时出现在末尾；<br>- 目标正在等待子任务时，说明在汇合之后可见，界面会提示这一点；<br>- 没有 main 且没有指定目标时，界面要求选择 |
| 中止（暂停后再按一次 Ctrl+C） | 进入 INTERRUPTING：<br>- 取消全部在途与排队的 UnitAttempt（`INTERRUPTED(ABORTED)`）；<br>- 取消待答复的授权询问与人类请求：Kernel 向 Workflow 发出 `HumanCancelled { nodeId, reason }`，界面收到 `HumanResolved(cancelled)`；<br>- Workflow 把运行中的节点（包括被取消的 HUMAN 节点）记为 INTERRUPTED，结束全部 AgentRun；<br>- Turn-chat：`endTurn(ABORTED)`，请求下一个 `HUMAN(prompt)`；<br>- Orchestration：`closeRun(CANCELLED)` |

中止不是回滚：已完成的 Unit 结果、已提交的输入都保留在日志中，文件改动保留在工作区，需要撤销时使用 `/undo`。

### 4.6 回退与差异

回退与差异只属于 Turn-chat。工作区快照在每个 Turn 开始与结束时拍摄，由 Kernel.Execution 管理，以独立 `GIT_DIR` 的影子 git 仓库保存在 Session 目录中，不要求被分析仓库本身是 git 仓库。
快照范围是仓库内除 M1 默认排除规则之外的文件，单个超过 2 MiB 的未跟踪文件跳过。
每个 Turn 结束时，Kernel 把 `turnId`、Turn 序号、开始与结束快照写入自己命名空间中的快照索引（`kernel-execution/snapshot-index.jsonl`）。
`/undo`、`/diff` 都按 Turn 执行，只依据这份索引定位快照；进程重启后照样可用，Kernel 不需要读取 Workflow 的日志。

| 指令 | 条件 | 效果 |
|---|---|---|
| `/diff [N]` | Turn-chat 中任意时刻 | 展示倒数第 N 个 Turn（缺省 1）开始快照与结束快照之间的差异 |
| `/undo [N]` | 仅 AWAITING_INPUT | 1. 比较当前工作区与最近一个 Turn 的结束快照，不一致（用户在此期间手动改过文件）时列出差异并要求确认；<br>2. 把工作区恢复到倒数第 N 个 Turn 的开始快照；<br>3. Kernel 发出 `WorkspaceReverted`，Workflow 追加 `WORKSPACE_REVERTED`；<br>4. 投影中，被回退各 Turn 的步骤替换为一条说明（"已回退：第 k 个 Turn，用户输入为……"） |

回退能覆盖的范围：沙盒保证命令只能写可写路径（都在仓库内），所以回退覆盖全部文件改动，被排除的文件除外。
回退不能撤销已批准联网的命令对外部产生的效果（例如向远端推送），这一点写入 M2 的限制清单。

Orchestration 运行（`mas run`）不拍快照，不支持 `/undo` 与 `/diff`，需要撤销时依靠仓库自身的版本控制，这一点同样写入限制清单。
在 Turn-chat 中用 `/run` 运行的模板属于当前 Turn，照常可以回退。

## 5. 授权：Lease

### 5.1 两层 Lease

```text
人类签发 ──▶ WorkflowRun Lease（上限：能力 + 资源键条目）
                  │ 只能收窄，由 Kernel 校验，不需要人类参与
                  ▼
             AgentRun Lease = 该 Agent 定义的能力白名单 ∩ 父 AgentRun 的 Lease ∩ 登记时请求的可写根目录
```

- **WorkflowRun Lease 只能由人类签发**：开始时的仓库授权、运行中对授权询问的回答，都是人类签发。MVP2 不设自动审批。
- **AgentRun Lease 由 Kernel 派生**：Workflow 登记 AgentRun 时，提交它请求的能力与可写根目录。Kernel 校验它们是父 AgentRun Lease 的子集后记录，否则以 `LEASE_NOT_SUBSET` 拒绝。
  收窄无需询问，放宽必须由人类签发；因此派生 SubAgent 不会引起询问。
- **Lease 的数据**：内容只在 Core 中，只在内存中，属于签发时的 WorkflowRun；WorkflowRun 结束时全部失效。
  `LEASE_REQUESTED`、`LEASE_DECIDED` 写入审计与会话日志，但不进入模型上下文，重放时也不恢复。

### 5.2 能力、级别与资源键

能力的级别写在 Kernel 的能力表中，Unit 定义只声明能力，调用者与模型不能改变级别。
同一能力作用于某些资源时级别会升高，升级规则同样写在能力表中，见下表的"极危险"各行。

| 能力 | 级别 | 资源键（从 UnitIntent 的输入中提取，规则由 Unit 定义给出） | 询问方式 |
|---|---|---|---|
| `repo.read` | 安全 | 仓库根目录 | WorkflowRun 开始时询问一次（M1 机制）；之后该 WorkflowRun 下的所有 AgentRun 可用 |
| `workspace.write` | 不确定 | 可写根目录 | 资源键第一次需要时询问一次。main 的可写根目录是仓库根目录，所以每个 WorkflowRun 通常只问一次；SubAgent 的 `writeScope` 落在已批准的根目录内，因此不再询问 |
| `web.search` | 不确定 | 无（整个能力） | 每个 WorkflowRun 第一次使用时询问一次 |
| `web.fetch` | 不确定 | 域名 | 每个新域名第一次访问时询问一次；私网、回环、链路本地、云元数据地址直接拒绝（`ADDRESS_FORBIDDEN`），不提供询问 |
| `command.exec` | 危险 | 规范化后的命令（按 `&&`、`\|\|`、`;`、`\|` 拆成子命令，并带上工作目录） | 默认每次询问 |
| `command.exec`：任一子命令命中 `kernel.criticalCommands` | 极危险 | 本次命令 | 每次单独询问。缺省列表：`git push`、`git remote`、`npm publish`、`pnpm publish`、`yarn publish`、`cargo publish`、`docker push`、`gh`；列表可追加，不可删除缺省项 |
| `command.network` | 极危险 | 本次命令 | `run_command` 的参数 `network: true` 时需要，与 `command.exec` 一起判定，每次单独询问；只有 main 的能力白名单中有这项能力 |
| `workspace.write`：目标为仓库根目录的 `AGENTS.md` | 极危险 | 本次写入 | 每次修改单独询问；只能经 `write_file`、`edit_file`，命令无法写入（第 6.1 节） |
| `agent.spawn` | 内部 | 无 | 不询问。来自 Agent 定义的能力白名单，随 AgentRun Lease 维护；Kernel 只授予顶层 AgentRun（没有父 AgentRun 的），因此 SubAgent 不能再派生。`registerAgentRun` 带 `parentAgentRunId` 时，Kernel 检查父 AgentRun 持有它，否则以 `CAPABILITY_NOT_GRANTED` 拒绝 |

`network: true` 和 `web_fetch` 的 URL 一样，是操作本身的参数。Kernel 从中提取需要的能力，按同一顺序判定，与其他工具的逻辑相同。

**级别的依据是后果能否撤销、影响到哪里**：
- 安全级没有副作用；
- 不确定级的副作用可以回退（文件写入），或者只泄露有限的信息（查询词、访问的域名）；
- 危险级的副作用不能完全撤销，但只作用于沙盒内的仓库（命令不联网）；
- 极危险级的副作用作用于仓库之外，且无法撤销（推送、发布、联网）；或者会改变以后每次运行的指令（`AGENTS.md`）。

Architecture 第 6 节"危险行为每次都必须单独征得用户同意"，在 M2 中对应极危险级。危险级允许在本 WorkflowRun 内按命令或前缀放行，
这一点需要同步修改 Architecture（第 14.1 节）。

**危险级的询问选项**：
- 单次允许；
- 本 WorkflowRun 内这条命令均允许；
- 本 WorkflowRun 内这个命令前缀均允许；
- 拒绝。

前缀按 ARITY 表计算：`git push`、`npm run` 这类命令取前两个词，其余取第一个词。
以下情况不提供两个"均允许"选项：命令中含 `$(`、反引号、`eval`、`sh -c`、`bash -c`，或含有通往 `sh` 的管道；沙盒不可用；
命中 `deniedCommands`。

**极危险级的询问选项**：只有单次允许与拒绝。不提供任何"均允许"，批准不继承、不复用，每个 UnitAttempt 单独询问；询问界面以警示样式显示。

**不确定级的询问选项**：允许（本 WorkflowRun 内对这个资源键有效）、拒绝（本 WorkflowRun 内对这个资源键保持拒绝）。

**启动预设**（CLI 参数）：
- `standard`（缺省）：如上表；
- `readonly`：不确定级、危险级与极危险级一律拒绝，不询问。

### 5.3 判定顺序

Core 对每个 UnitIntent 按固定顺序判定，与规则的书写顺序无关：

```text
① 任一子命令或域名命中 deniedCommands / deniedDomains     → REJECTED（COMMAND_DENIED / DOMAIN_DENIED）
② 能力不在该 AgentRun 的 Lease 中                        → REJECTED（CAPABILITY_NOT_GRANTED）
③ 写入路径不在该 AgentRun 的可写根目录内                  → REJECTED（WRITE_OUT_OF_SCOPE），不询问
   写入路径位于 .git/ 或 .multiagentos/ 之下                → REJECTED（PROTECTED_PATH），不询问
④ WorkflowRun Lease 中有覆盖该资源键的条目
     允许 → 签发 ExecutionScope 与 SandboxProfile；单次条目在该 UnitAttempt 结束时作废；极危险级不查找已有条目，直接进入 ⑤
     拒绝 → REJECTED（USER_DECLINED）
⑤ 都没有 → 发起授权询问，只挂起这个 UnitAttempt
```

- **出错即拒绝**：判定过程本身出错（能力名未知、AgentRun 未登记、规范化失败、沙盒探测超时），一律按拒绝处理，原因码为 `ADMISSION_CHECK_FAILED`。
- **询问失败即拒绝**：询问无法送达或超时（`authorizationTimeoutMs`，缺省 5 分钟），只拒绝本次，不形成持久的拒绝。
- **批准绑定确切内容**：危险级询问展示的内容（命令、工作目录、SandboxProfile）参与计算 `approvalDigest`。
  Supervisor 启动进程前用实际要执行的内容重新计算，不一致时返回 `APPROVAL_MISMATCH`。启动前还要复查：
  - 工作目录仍然存在，realpath 后仍在仓库内；
  - 可写根目录仍然不是符号链接；
  - 黑名单再匹配一次。

### 5.4 SubAgent 的隔离

SubAgent 的隔离由以下五层共同保证，缺一不可：

1. **能力白名单**：Agent 定义列出它可以使用的能力（第 3.9 节）。
2. **组装时裁剪**：Workflow 只把 AgentRun Lease 中有对应能力的工具放进它的工具列表。例如 explorer 看不到 `run_command`。这一层减少无效调用与攻击面，但不是安全边界。
3. **准入时检查**：Kernel 按第 5.3 节判定，只认该 AgentRun 自己的 Lease。这一层是安全边界。
4. **可写范围**：worker 的可写根目录就是它的 `writeScope`；进程内写入检查与沙盒的 `--bind` 参数由同一个函数 `writableRoots(profile)` 计算。
5. **沙盒**：命令即使试图写到范围之外，也会被操作系统拒绝（第 6 节）。

### 5.5 授权只能由 Kernel 被动发起

1. **授权询问的唯一来源**是第 5.3 节的第 ⑤ 步：Agent 调用工具 → Workflow 提交 UnitIntent → Core 判定时没有覆盖的 Lease → Core 向用户询问。
   询问的内容由 Core 依据 UnitIntent 生成，展示实际要执行的内容，不展示模型写的理由。
2. **授权总是绑定一个具体操作**：Agent 调用工具时，在参数中写明操作及其需要的资源（URL、命令、写入路径、`network: true`），Kernel 从中提取能力与资源键并判定。
   - M2 没有不对应任何操作、只用来申请权限的工具（例如"请给我命令权限"）；
   - 工具参数只描述本次操作，不能改变 AgentRun Lease 的上限：能力白名单与 `writeScope` 只由 Agent 定义与派生决定；
   - Agent 在 `ask_user` 中提到权限，或用户在答复中表示同意，都不产生 Lease。
3. **SubAgent 要更大范围时**，只能在 `finish_subagent` 中写明（`blockers`），由父 Agent 重新派生，新的派生仍然只能落在已有 Lease 的范围内。
4. **预留扩展点**：Kernel 的授权询问接受一个可选的"申请来源"字段，M2 中它恒为 `KERNEL_ADMISSION`。
   以后若增加脱离操作的权限申请（如 `request_permission` 工具，事先为一组操作申请授权），作为新的来源接入同一个询问流程与判定顺序，不另开通道。

## 6. 沙盒

### 6.1 SandboxProfile

Core 在签发 EXEC 的 ExecutionScope 时计算 SandboxProfile，Supervisor 用 bubblewrap 施加。模型、Workflow 与配置都不能选择或放宽它。

| 项 | 内容 |
|---|---|
| 根文件系统 | `--ro-bind / /` |
| 可写路径 | 该 AgentRun 的可写根目录（main 为仓库根目录，worker 为 `writeScope`）以 `--bind` 挂载；私有 `/tmp`（`--tmpfs /tmp`） |
| 只读保护 | 仓库内的 `.git/`、`.multiagentos/`、根目录的 `AGENTS.md` 即使位于可写路径之内，也以 `--ro-bind` 重新挂载为只读；不存在时以只读的空占位挂载，防止命令新建 |
| 遮蔽 | `<dataDir>`，以及 `~/.ssh`、`~/.aws`、`~/.config/gcloud`、`~/.gnupg`、`~/.docker`、`~/.kube`、`~/.npmrc` 等凭据位置（列表可追加，不可删除），用空 tmpfs 或空文件遮蔽 |
| 网络 | 缺省 `--unshare-net`；只有批准了 `command.network` 的那一条命令共享宿主网络 |
| 进程 | `--unshare-pid`、`--die-with-parent`、`--new-session`；独立进程组 |
| 环境变量 | 白名单构造（`PATH`、`HOME`、`LANG`、`TERM` 等）；构造后再断言没有名称匹配 `*KEY*`、`*SECRET*`、`*TOKEN*`、`*PASSWORD*`、`*CREDENTIAL*` 的变量，否则拒绝启动并写审计 |
| 资源 | 超时（缺省 2 分钟，参数上限 10 分钟）；输出保留头尾预览，全文存为 Artifact |

### 6.2 可用性

- **探测方式**：Session 开始时用真实的 profile 运行一次 `/bin/true`。只检查命令是否存在不算探测。
  Ubuntu 23.10 起 AppArmor 默认限制非特权用户命名空间，这是 bwrap 在 Ubuntu 24.04 上不可用的最常见原因；修复方法写入 M2 的使用说明。
- **探测结果**：写入 `SESSION_STARTED` 与审计。
- **不可用时的行为**由 `sandbox.unavailable` 决定：
  - `deny`（缺省）：`run_command` 不出现在任何 Agent 的工具列表中，Session 开始时提示原因与修复方法；
  - `ask-unisolated`：每条命令的询问都注明"未隔离"，只提供单次允许；Kernel 把所有 AgentRun 的 WRITE 与 EXEC 都视为全局屏障，Workflow 不需要知道沙盒状态。

### 6.3 文件工具的检查

`file-write`、`file-edit` 在进程内执行。它们与 Core 的第 ③ 步判定、沙盒的 `--bind` 使用同一个 `isWritable(profile, path)` 函数，
并用属性测试证明三处判断一致。路径不跟随符号链接，不得越出仓库目录（M1 的 `guarded-file` 规则）。
`isWritable` 对 `.git/`、`.multiagentos/` 之下的路径一律返回否（`PROTECTED_PATH`）；`AGENTS.md` 可写，但按极危险级逐次询问（第 5.2 节）。

### 6.4 并行运行的安全条件

| 风险 | 机制 |
|---|---|
| 两个 worker 写同一文件 | 派生时校验 `writeScope` 不相交（第 3.6 节）；准入时检查写入路径；沙盒只挂载各自的范围 |
| 命令之间互相干扰（端口、构建目录、锁文件） | 同一 WorkflowRun 内同一时刻至多一个 EXEC（`kernel.maxConcurrentExec = 1`） |
| 同一 AgentRun 对同一文件的并发编辑 | WRITE 是屏障（第 7.1 节）；Executor 内再按规范化路径加锁；`FILE_CHANGED` 的 SHA 校验 |
| 读取之后文件被并行任务或命令改动 | 校验 `edit_file` 时，Workflow 查找该路径在当前上下文中最近一次仍然可见的读取结果：找不到就以 FEEDBACK 要求先读取，不提交；找到就把它的 SHA 作为 `baseSha` 填入 UnitIntent（由 Workflow 填写，模型不能提供）。Executor 只比较磁盘内容的 SHA 与 `baseSha`，不一致返回 `FILE_CHANGED` |
| 新建文件时被并行任务抢先创建 | Workflow 为新建填入 `expectAbsent: true`；写入时文件已存在则返回 `FILE_CHANGED`，不覆盖 |

## 7. Kernel：执行与资源

M2 保持 Kernel 业务无关、拓扑无关：Kernel 只依据 ID、能力、资源键、额度与执行结果做判断，不理解任务图。

### 7.1 并发类别与队列

- Execution 按 AgentRun 划分执行队列。Unit 定义声明并发类别：
  - READ：检索、读文件、网页、context-assemble；
  - WRITE：写文件、编辑文件；
  - EXEC：命令；
  - MODEL：模型调用。
- 同一 AgentRun 的队列中，相邻的 READ 并行执行；WRITE 与 EXEC 是屏障，要等它前面的全部 Unit 结束才执行，它结束之后后面的 Unit 才开始。
- 不同 AgentRun 的队列并行执行，受三项全局约束：
  - `kernel.maxConcurrentAttempts`（缺省 6）；
  - `kernel.maxConcurrentExec`（缺省 1）；
  - Scheduler 按 `kernel.providerCapacity`（缺省 3）分配模型调用机会。
- `kernel.serialExecution`（缺省 `false`）是总开关，开启时所有 Unit 都视为屏障，全局并发为 1。用于排查竞态，CI 中开与关各跑一遍。
- **改动检测**：Execution 在每次 WRITE 与 EXEC 前后扫描该 AgentRun 的可写范围，复用 M1 按 `(dev, ino, size, mtime, ctime)` 建立的摘要缓存，只重新计算变化过的文件，
  把新增、修改、删除的文件列表放进 UnitReport。并行任务的可写范围不相交，EXEC 又是全局串行，所以改动能准确归到发起者。被排除的目录（如 `node_modules`）只报告变化的文件数量。
- 并发计数与 EXEC 互斥在授权通过、UnitAttempt 真正派发时才占用；等待授权、排队、因暂停而保留的尝试都不占用。
- 被取消的 UnitAttempt 要等 Supervisor 确认停止后才释放并发计数与 EXEC 互斥。

### 7.2 FCFS

在 7.1 节的类别、屏障、互斥与容量约束之内，Kernel 按 UnitAttempt 建立的先后顺序执行，不区分 Agent，不设优先级。
资源不足时排队等待，不把请求作为错误退回给 Workflow。Kernel 的行为只与资源有关，与业务无关。

### 7.3 额度

**三级账本**：一次 model-call 的预留，必须同时满足三级账本的余额。

| 层 | 缺省 | 用途 |
|---|---|---|
| WorkflowRun | `budget.runTokenLimit` = 5,000,000 | 整个运行的总上限 |
| Turn（仅 Turn-chat） | `budget.turnTokenLimit` = 1,000,000 | 一个 Turn（含其中全部 SubAgent）的上限，新 Turn 重新建立；Orchestration 没有这一级 |
| AgentRun | main 不单独设份额，直接使用所在 Turn（Orchestration 中为运行级）的账本；explorer 缺省 150,000，worker 缺省 300,000；`run_subagents` 给出的值限制在缺省值的 0.25–2 倍之间 | 每个 AgentRun 的份额 |

**收尾保留**：M1 的 `finalReserve` 改为按 AgentRun 计，每份为 M1 的 `finalInputBudget` 加 `finalMaxOutputTokens`。
- 登记 AgentRun 时，Monitor 从 Turn 账本（Orchestration 中为运行级账本）中为它预留一份收尾额度；账本不足时登记被拒（`BUDGET_INSUFFICIENT`），该任务记为 FAILED。
- 每个 AgentRun 至多一次 final-call（M1 是每个运行一次）。
- 这样每个已登记的 AgentRun 都必然能完成收尾。

**AgentRun 级的其他上限**：任一项触顶，Monitor 都拒绝该 AgentRun 后续的非收尾 Unit，并以 `QUOTA_EXHAUSTED(触顶项)` 通知 Workflow 进入收尾。

| 上限 | 说明 |
|---|---|
| `maxToolUnits` | 工具 Unit 总数 |
| `maxWallClockMs` | 从登记开始计时；暂停、等待人类、等待子任务的时间不计入 |
| 重复意图 | 同一 AgentRun 最近 20 个 UnitIntent 中，输入哈希完全相同的出现 3 次时在结果中附加警告，出现 5 次时拒绝（`REPEATED_INTENT`） |
| 连续出错 | 连续 5 个工具 Unit 以 REJECTED 或 FAILED 结束（`CONSECUTIVE_ERRORS`）。命令的非零退出码不算出错 |

**统一收尾路径**：所有触顶项（token、Round、工具次数、墙钟、重复、连续出错）都走同一条路径：
1. Workflow 只为该 AgentRun 再提交一次 final-call；
2. final-call 的上下文中写明因哪一项触顶；
3. final-call 失败时，按 M1 的降级规则结束该 AgentRun（explorer 与 worker 交回 `status: partial` 的降级结果，main 交回降级回复）。

**Turn 与运行级触顶**：
- Turn 账本（Orchestration 中为运行级账本）进入 WRAP_UP 时，其中所有 AgentRun 都进入收尾；子任务先收尾，父任务在汇合后收尾。
- 运行级账本耗尽时，Kernel 收敛本 WorkflowRun（`BUDGET_EXHAUSTED`）。Turn-chat 中提示用户确认后，在同一 Session 中开启新的 WorkflowRun；对话照常延续，授权需要重新签发。

### 7.4 时间

| 计时 | 缺省 | 到点 |
|---|---|---|
| Turn 超时 `turnTimeoutSeconds`（仅 Turn-chat） | 1800 秒，不计 PAUSED 的时间 | 按中止处理本 Turn |
| 运行超时 `runTimeoutSeconds`（仅 Orchestration） | 3600 秒，不计 PAUSED 的时间 | `RUN_TIMEOUT` 收敛 |
| 暂停上限 `maxPauseSeconds` | 1800 秒 | 按中止处理 |
| 授权询问 `authorizationTimeoutMs` | 5 分钟，PAUSED 期间冻结 | 本次拒绝 |
| 人类请求 `humanRequestTimeoutMs` | 10 分钟（`prompt` 不限），PAUSED 期间冻结 | 以 `{ timedOut: true }` 作为答复 |

AWAITING_INPUT 没有时间上限：此时没有任何在途工作，也不占用资源。

### 7.5 接口变化

**Workflow → Kernel**

| syscall | 变化 |
|---|---|
| `registerAgentRun` | 新增 `parentAgentRunId?`、`turnId?`、`nodeId`、`requestedCapabilities`、`writeRoots?`、`budget?`、`effort`、`display { label }`；允许多个同时 ACTIVE |
| `submitUnit` | 新增 `unitRunId`、`display { toolName, argsSummary（≤80 字）}` |
| （说明） | `display` 只用于界面：Kernel 原样放进 ActivityEvent，不据此做任何判断 |
| `requestHuman` | 新增：发起人类请求；`prompt` 只能在没有开启中的 Turn 与 ACTIVE AgentRun 时发起 |
| `beginTurn`、`endTurn` | 新增：开启与结束 Turn（第 2.3 节） |
| `readProjectFile` | 新增：读取项目文件（第 7.5 节末尾的说明） |
| `endAgentRun`、`closeRun` | 不变；`closeRun` 新增结束原因 `CANCELLED` |

**UserInteraction → Kernel**

| 请求 | 变化 |
|---|---|
| `openSession`、`startSession({ new \| fork, prompt })`、`startRun` | 新增：打开已有 Session；在第一条提示词提交时新建或 Fork Session；以模板开启 WorkflowRun（取代 M1 的 `createRun`） |
| `answerAuthorization` | 答复增加选项：单次、命令、前缀、允许、拒绝 |
| `answerHuman` | 新增 |
| `pauseRun`、`resumeRun(steer?)`、`interruptRun` | 新增 |
| `undoTurns`、`diffTurns` | 新增 ControlOperation，仅 Turn-chat |
| `readArtifact`、`shutdown` | 不变 |

**`readProjectFile`**：Workflow 初始化时需要的仓库信息，以系统服务 syscall 向 Kernel 申请，而不是提交 Unit（Unit 是 Agent 的行为，必须属于某个 AgentRun）。
- 路径只接受固定白名单：仓库根目录的 `AGENTS.md`、`.multiagentos/workflows/*.yaml`；
- Kernel 按 WorkflowRun 级的 `repo.read` 检查，没有时照常询问；由 `RepositoryAccess` 读取，正文存入 ArtifactStore，写审计；不计入任何 AgentRun 的额度；
- 返回：`AGENTS.md` 只返回 ArtifactRef 与 SHA（Workflow 不看内容，直接交给 context-assemble）；模板文件同时返回文本，由 Workflow 解析与编译；
- 时机：WorkflowRun 开启后、启动第一个节点之前读取一次；用户批准修改 `AGENTS.md` 的写入成功后再读取一次。每次读取都追加 `PROJECT_FILE_LOADED` 记录，上下文使用最新一条。

**Kernel → Workflow 的事件**：`SessionOpen`、`RunStart`、`UnitReport`（新增 `INTERRUPTED` 状态，以及实际改动的文件）、
`HumanAnswered`、`HumanCancelled`、`TurnTimedOut`、`RunPaused`、`RunResumed(steer?)`、`RunInterrupted`、`WorkspaceReverted`、`RunClosed`。

**Kernel → UserInteraction 的事件**：
- `AuthorizationRequest` / `AuthorizationResolved`；
- `HumanRequest` / `HumanResolved`；
- `MessagePublished`：`message-publish` 完成时发出；
- `RunStateChanged`；
- `ActivityEvent`：由 Kernel 依据 AgentRun 登记、父子关系与 UnitAttempt 的状态生成，Workflow 不需要另一条通道；
- `RunFinished`。

**新增原因码**：
- 中断：`INTERRUPTED`（`PAUSED` / `ABORTED`）；
- Lease 与授权：`LEASE_NOT_SUBSET`、`CAPABILITY_NOT_GRANTED`、`ADMISSION_CHECK_FAILED`、`APPROVAL_MISMATCH`；
- 写入与文件：`WRITE_OUT_OF_SCOPE`、`PROTECTED_PATH`、`FILE_CHANGED`；
- 命令与沙盒：`COMMAND_DENIED`、`SANDBOX_UNAVAILABLE`；
- 网络：`DOMAIN_DENIED`、`ADDRESS_FORBIDDEN`；
- 额度与上限：`BUDGET_INSUFFICIENT`、`QUOTA_EXHAUSTED`、`REPEATED_INTENT`、`CONSECUTIVE_ERRORS`；
- 运行状态：`AGENT_RUN_ACTIVE`（扩展到 `requestHuman`）。

**协议版本**：语义变化的 Schema 按 M1Interface 1.2 发布新 major。M2 运行时只产生新 major；M1 的行为由 `analyze` 模板回归验证。

## 8. 工具与 Executor

### 8.1 工具清单

| 工具 | Unit | 并发类别 | 能力 | 要点 |
|---|---|---|---|---|
| `search_repository` | `repository-search` | READ | `repo.read` | M1 原样 |
| `list_files` | `repository-list` | READ | `repo.read` | 由 M1 的 `RepositoryAccess` 执行（与概览、检索、读文件共用同一个文件集合、排除规则与路径检查），复用 `repository-orient` 的目录树生成；参数为 `path?`、`depth?`（1–3）、`glob?`；返回目录树与每个目录的文件数，不读取文件内容 |
| `git_inspect` | `git-inspect` | READ | `repo.read` | 只读、安全级、固定参数：`status`、`diff [--staged] [path]`、`log [-n ≤50] [path]`、`show <rev> [path]`、`blame <path> [行范围]`；不接受任意参数。经 Supervisor 在只读沙盒中运行，不联网；带 `--no-pager`、`--no-ext-diff`、`--no-textconv`，禁用 hooks 与 fsmonitor，忽略系统与全局 git 配置；以 pathspec 排除 M1 默认排除规则命中的文件，使 `.env` 等内容不会经 diff 泄露；仓库不是 git 仓库时返回 `UNSUPPORTED` |
| `read_file` | `file-read` | READ | `repo.read` | M1 原样，另返回内容 SHA；找不到文件时列出同目录中名称最接近的几个文件 |
| `write_file` | `file-write` | WRITE | `workspace.write` | 新建或整体覆盖。覆盖已有文件时 Workflow 填入 `baseSha`，新建时填入 `expectAbsent`（第 6.4 节）；`append: true` 追加，同样要求先读或文件不存在；读到"不存在"之后只允许新建 |
| `edit_file` | `file-edit` | WRITE | `workspace.write` | `oldString` 必须唯一匹配，否则要求 `replaceAll`；保持原有换行符；精确匹配失败时依次忽略排版引号、空白差异重试；按 Workflow 填入的 `baseSha` 校验（第 6.4 节） |
| `run_command` | `run-command` | EXEC | `command.exec`（`network: true` 时加 `command.network`） | 参数为 `command`、`workdir?`（相对仓库根目录）、`timeoutMs?`、`network?`；缺省不联网；每次在全新的 shell 中执行，不保留 `cd` 与变量；非零退出码是正常结果；输出保留头尾预览，全文存为 Artifact；结果带 `sandboxDenials`、`backend`、`changedFiles` |
| `web_search` | `web-search` | READ | `web.search` | `queries: string[]`（≤5 个）并行查询，结果按 URL 去重；`timeRange?`；每条结果包含标题、URL、摘要，URL 先经地址检查 |
| `web_fetch` | `web-fetch` | READ | `web.fetch` | 只允许 http 与 https；解析时与建立连接时各检查一次地址，重定向逐跳检查；大小上限；HTML 转为 Markdown；正文存为 Artifact，上下文中只放开头一段与引用 |

内建 Unit：`context-assemble`、`model-call`（MODEL）、`report-publish`（M1）、`message-publish`（新增，由 Execution 直接发布 `reply` 与运行结果）。
工作区快照与恢复是 Kernel 的内部操作，不是 Workflow 可以提交的 Unit。

### 8.2 结果的统一结构

工具 Unit 的输出分成三部分：
- `output`：结构化结果，按 Unit 的输出 Schema 校验，写入日志；
- `content`：给模型看的文字，即 `output` 的渲染加预览，作为 Artifact 引用；
- `metadata`：只给终端界面使用，例如 diff 高亮、退出码徽标，不进入模型上下文。

非零退出码、测试失败、没有搜索结果都属于 OK。沙盒拒绝、授权拒绝、超时、取消、`FILE_CHANGED`、`WRITE_OUT_OF_SCOPE` 属于 REJECTED 或 FAILED，
带原因码与给模型的简短说明。原始异常文字可能含有宿主机路径与环境信息，只写入审计，不进入模型上下文。

### 8.3 网页检索的提供方

`web-search` 只有一个 Unit。提供方接口按多提供方设计，M2 实现 Tavily 一个适配器（面向 Agent 设计、返回清洗过的摘要，Open Deep Research 与 DeerFlow 都在使用）；以后可以增加自部署的 SearXNG。
测试使用本地的固定内容服务器，不依赖真实网络。

### 8.4 Executor 的组织

```text
executor-set/
  fs/        文件访问接口与本地实现：路径检查、排除规则、同路径锁、带版本条件的写入
  git/       git-inspect：固定子命令表、安全参数、排除规则的 pathspec
  command/   run-command：子命令拆分、环境变量白名单与断言、输出截断、拒绝分类
  web/       web-search 提供方适配器；web-fetch 的地址检查、重定向、HTML 转 Markdown
  vendor/    从开源项目拷贝的纯函数（注明来源与许可证），如 edit 的匹配函数、HTML 转 Markdown
```

## 9. 上下文组装与思考模式

### 9.1 投影规则

上下文组装属于 Workflow：Workflow 决定模型看到什么，作为 `context-assemble` 的输入交给 Kernel 执行（M1 机制）。

| AgentRun | 历史部分 |
|---|---|
| main（Turn-chat） | 本 Session 全部 Turn，跨 WorkflowRun：每个 Turn 的人类输入、main 的步骤、`run_subagents` 的汇合结果；`HUMAN(steer)` 出现在投递时的位置，回退与中断以说明性记录出现；之前 Orchestration 运行的结果以"运行结果 + ArtifactRef"出现 |
| 模板中的 AGENT 节点 | 节点目标 + 前驱节点的结果 + 本节点的步骤 |
| explorer、worker | 目标 + 父任务显式交给它的引用 + 依赖任务的结构化结果 + 验收标准 + 自己的步骤 |

SubAgent 的投影函数的参数中没有父 AgentRun 的步骤，隔离由类型保证，而不是事后过滤。

### 9.2 组成与顺序

```text
[system] 人设与职责 → 可用工具说明（只含该 AgentRun 实际可用的工具）→ 派生准则（仅 main）
         → 项目指令（仓库根目录的 AGENTS.md，经 readProjectFile 读取，上限 64 KiB，使用最新一次读取的结果）
         → 运行时上下文（工作目录、沙盒状态、当前日期）
[history] 第 9.1 节
[tail]   收尾调用时的"必须结束"提示及触顶原因
```

- 系统段落在一个 AgentRun 内保持不变，段落变化以追加表达；工具结果与汇合结果按调用顺序排列。这样有利于前缀缓存。
- 外部输入（用户输入、网页内容、工具结果、子任务结果）一律以 user 或 tool 角色出现并标明来源，不获得指令权威。

### 9.3 可重建性与裁剪

- **可重建性**：`projectionDigest` 的计算覆盖消息、请求参数（模型、思考设置）、工具列表摘要、运行时上下文、裁剪层级、展开的 ArtifactRef 列表。
  这些内容一旦变化，就追加记录，从而保证模型看到的每份上下文都能由日志重建。
- **裁剪的分工**：Workflow 决定"哪些可以去掉"，Executor 计算"怎样装进预算"：
  - Workflow 交给 `context-assemble` 的每个条目都带标注：所属 Turn，以及裁剪类别——`PINNED`（固定保留）、`BODY_ELIDABLE`（可以去掉正文、保留结构化输出与引用）、`TURN_DROPPABLE`（可以随所属 Turn 整体去掉）；
  - `context-assemble` 的 Executor 只依据标注与 token 估算执行下面的固定层级，不理解业务；
  - Executor 在输出中列出实际去掉的条目（与 M1 的 `elidedRequestIds` 同一做法），Workflow 记入日志，因此结果可以复现。
- **裁剪层级**：超出预算时按固定层级确定性地裁剪，不使用模型生成的摘要：
  1. 大的工具结果只放预览；
  2. 去掉最早的工具结果正文，保留结构化输出与 ArtifactRef；
  3. 仅 Turn-chat 的 main：以 Turn 为单位去掉更早的整个 Turn；
  4. 仍然超出时：收尾调用继续按上述层级裁剪重试，最多 3 次；普通调用提示用户 `/new`。

  思考内容不单独裁剪，只随整轮一起去掉。

### 9.4 DeepSeek 思考模式

| 项 | 规则 |
|---|---|
| 模型 | `deepseek-flash`；思考强度按 Agent 缺省值，可由 `run_subagents` 的 `effort` 在允许范围内改变；`/thinking` 可以查看最近的思考内容 |
| 回传 | 带工具的请求中，回传之前各轮的 `reasoning_content`，否则 API 返回 400 或静默停止：<br>- 回传条件为同一模型，且该轮没有出错；<br>- 被暂停或中止打断的思考不回传；<br>- 缺少思考内容的历史轮按实测结果补空字符串（第 14.1 节） |
| 记录 | 思考内容存为 Artifact，`MODEL_TURN` 记录它的引用；思考内容不显示，也不流式输出 |
| 收尾调用 | 只提供结束控制工具，`tool_choice = auto`，保持思考开启；结果不合法时，以关闭思考加强制工具选择重试一次（M1 的方式）；仍不合法则降级 |

## 10. Session 与持久化

### 10.1 目录

```text
<dataDir>/
  artifacts/<sha256>                       ArtifactStore：内容寻址的正文，跨 Session 共享（Kernel.Execution）
  kernel-core/session-index.jsonl          Session 列表（Kernel.Core，第 10.3 节）
  sessions/<sessionId>/
    session.lock                           单写者锁（pid）；进程不存在时视为过期
    workflow/log.v1.jsonl                  SessionLogStore：会话日志（Workflow）
    kernel-core/audit.jsonl                Kernel 审计：Lease、ControlOperation、拒绝、结算
    kernel-execution/artifact-owners.jsonl 本 Session 拥有的产物
    kernel-execution/snapshot-index.jsonl  快照索引：turnId → 开始与结束快照
    kernel-execution/snapshots/            工作区快照（影子 git）
```

两个存储各有唯一的 Owner，互不管辖：

| | SessionLogStore | ArtifactStore |
|---|---|---|
| Owner | Workflow（唯一写入者） | Kernel.Execution（唯一写入者） |
| 内容 | 会话日志：拓扑、HUMAN 节点、Unit 的提交与结果、Turn 与运行的边界、控制记录。只保存结构化记录与 ArtifactRef，不保存正文 | 全部正文：工具输出、模型输出、思考内容、用户输入的正文、报告与回复 |
| 写入 | 只追加 | 只新增，内容寻址，写入后不可变 |
| 创建、复制、删除 | Workflow 执行：新建日志、Fork 时复制日志前缀、删除日志 | Execution 执行：写入正文、登记与解除 Session 的归属、回收无人拥有的正文 |
| 读取 | 只有 Workflow | 按 ArtifactRef 经 Kernel 读取，归属检查见下 |
| 机制 | 由 Persistence 提供（第 10.3 节的写入规则） | 由 Persistence 提供，M1 的 ArtifactStore 原样扩展 |

两者的唯一连接是 ArtifactRef：Workflow 的日志中只出现引用，正文只在 ArtifactStore 中。
Workflow 需要保存正文（例如用户输入）时，一律经 Kernel 交给 Execution 写入，再把返回的引用写进日志。

`dataDir` 必须位于仓库之外（M1 规则），并在沙盒中被遮蔽。

**以 Session 为存放单位**（M1 按 WorkflowRun 存放在 `runs/<workflowRunId>/`）：

- **一个 Session 一个会话日志**：Session 内先后进行的全部 WorkflowRun 都追加到同一个文件，以 `WORKFLOW_RUN_STARTED` 与 `WORKFLOW_RUN_ENDED` 划分；
  Turn-chat 中再以 `TURN_STARTED` 与 `TURN_ENDED` 划分 Turn。日志的层次与第 2.1 节的概念层次一一对应：

  ```text
  log.v1.jsonl
    SESSION_STARTED
    WORKFLOW_RUN_STARTED(run 1)
      HUMAN_ANSWERED(prompt)
      TURN_STARTED(turn 1)
        GRAPH_EXTENDED / NODE_* / UNIT_* / HUMAN_*(ask, steer) …
      HUMAN_REQUESTED(prompt)
      TURN_ENDED(turn 1)
      HUMAN_ANSWERED(prompt)
      TURN_STARTED(turn 2)
        …
    WORKFLOW_RUN_ENDED(run 1, PROCESS_EXITED)
    WORKFLOW_RUN_STARTED(run 2)   ← 重开 Session 后
      …
  ```

- **为什么不按 WorkflowRun 分文件**：对话的连续性属于 Session（第 2.3 节）。main 的上下文要投影整个 Session 的对话，跨越多个 WorkflowRun；
  重开 Session 时也只需读一个文件、拿一把锁。WorkflowRun 是治理单位（Lease、额度、TaskGraph），不是存储单位。
- **产物的归属范围从 WorkflowRun 扩大为 Session**：后一个 WorkflowRun 的上下文要引用之前各 Turn 的工具结果，
  因此 ArtifactRef 的归属检查（M1 Kernel 5.2 节的 `INVALID_ARTIFACT_REF`）改为"属于本 Session"，依据是 `artifact-owners.jsonl`。授权仍按 WorkflowRun：
  能引用旧产物，不等于能重新读取仓库。
- **Kernel 的数据**：审计、产物归属、快照与快照索引放在同一个 Session 目录中，但属于 Kernel 的命名空间，Workflow 不能读写（M1 Persistence 第 3 节的命名空间规则）。

### 10.2 日志记录

| 类别 | 记录 |
|---|---|
| Session | `SESSION_STARTED`：仓库、`formatVersion`、定义版本与 `definitionsDigest`、项目指令引用、沙盒探测结果 |
| WorkflowRun | `WORKFLOW_RUN_STARTED`（模板、预设）、`WORKFLOW_RUN_ENDED`（结束原因） |
| Turn（仅 Turn-chat） | `TURN_STARTED`（`turnId`、提示节点、开始快照引用）、`TURN_ENDED`（结束原因、用量摘要、结束快照引用） |
| 拓扑 | `GRAPH_EXTENDED`、`NODE_STARTED`、`NODE_ENDED` |
| 业务输入 | `HUMAN_REQUESTED`、`HUMAN_ANSWERED`：所有用户输入（`prompt`、`steer`、`ask`、`confirm`、`review`）都只以这两种记录出现，带节点 ID、种类、附属对象与正文引用 |
| 控制 | `RUN_PAUSED`、`RUN_RESUMED`、`RUN_INTERRUPTED`、`WORKSPACE_REVERTED` |
| Unit | `UNIT_SUBMITTED`、`UNIT_COMPLETED`（结构化输出与 ArtifactRef）、`UNIT_INTERRUPTED`；`MODEL_TURN` 带 `reasoningRef`；失败的模型尝试单独记录，不进入模型历史 |
| 项目文件 | `PROJECT_FILE_LOADED`：路径、ArtifactRef、SHA |
| 请求参数 | `REQUEST_CONTEXT`：模型、思考设置、工具列表摘要、运行时上下文，变化时追加 |
| 授权 | `LEASE_REQUESTED`、`LEASE_DECIDED`：Kernel 授权询问的审计副本，不是 HUMAN 节点，不进入上下文，重放时不恢复授权 |
| 维护 | `LOG_TAIL_REPAIRED`、`STALE_UNITS_SETTLED`、`SESSION_FORKED` |

### 10.3 写入、打开与恢复

**写入规则**

1. 先写日志，追加成功后才更新内存状态、提交 UnitIntent。M2 单进程、写入频率低，每条记录写入后都 fsync。
2. UnitIntent 先追加 `UNIT_SUBMITTED`，再交给 Kernel。
3. 每个节点、每个 Unit 一结束就记录。
4. 不写半截的记录；任何记录写入后都不修改、不删除，撤销、中断与修复都以追加记录表达。
5. 用户输入在写入前由 UserInteraction 分配 ID，重复提交按 ID 去重。

**打开 Session**：Kernel 下达打开指令后，Workflow 依次执行：

1. 取得 `session.lock`；
2. 逐行解析日志：最后一行不完整时截断到最后一个完整换行，并追加 `LOG_TAIL_REPAIRED`；`seq` 不连续时拒绝打开；
3. 比较 `definitionsDigest`：版本号相同但摘要不同时，提示"定义已修改，历史上下文的重建不再精确"，并写入审计；
4. 对每个"已提交、未完成"的 UnitRun 追加 `UNIT_INTERRUPTED`（原因"上一个进程中断"），不重放；对未结束的 WorkflowRun 追加 `WORKFLOW_RUN_ENDED(PROCESS_EXITED)`；
5. 重建投影；Kernel 开启新的 WorkflowRun；
6. 最后一个人类请求没有答复时，重新展示它；否则进入 AWAITING_INPUT。

**Session 列表**由 Kernel 维护，不需要和 Workflow 交互。Kernel.Core 在自己的命名空间中保存 `<dataDir>/kernel-core/session-index.jsonl`，
每个 Session 一行（追加更新，读取时取每个 Session 的最后一行）。所需信息都是 Kernel 自己产生的事实：

| 字段 | 来源 |
|---|---|
| `sessionId`、创建时间、Fork 来源（`fromSessionId`、Turn 号） | `startSession` 时由 Kernel 写入 |
| 标题 | 第一条 `prompt` 正文的 ArtifactRef（正文由 Execution 写入）；列表显示时 Kernel 按引用读取前 80 字 |
| Turn 数、最后活动时间 | Kernel 每开启一个 Turn 时更新 |
| 状态 | 正常、已删除 |

`/sessions` 只读这份索引。索引损坏或缺失时，可以由各 Session 的审计与快照索引重建。

### 10.4 Fork

Fork 从一个已有 Session 的某个 Turn 结束处分出一个新的 Session。只有包含 Turn 的 Session（Turn-chat）可以 Fork。两者此后各自继续，互不影响。

| 项 | 规则 |
|---|---|
| 发起 | 用户执行 `/fork [Turn 号]`，缺省为最近一个 Turn 的结束。只在 AWAITING_INPUT 时可用 |
| Fork 点 | 只能是某个 Turn 的结束（第 2.1 节的静止点），即该 Turn 的 `TURN_ENDED` 记录的 `seq` |
| 创建时机 | 用户在草稿中提交第一条提示词时才创建（第 2.3 节）；放弃草稿不留下任何内容 |
| 日志 | 新 Session 有自己的日志文件：复制原日志从第 1 条到 Fork 点的全部记录（`seq` 不变），再追加 `SESSION_FORKED { fromSessionId, fromSeq }`，然后是新的 `WORKFLOW_RUN_STARTED` 与第一个 `HUMAN(prompt)`。此后两个日志各自追加，原 Session 的日志不被修改 |
| 被复制的前缀中未结束的运行 | 复制时对其中未结束的 WorkflowRun 追加 `WORKFLOW_RUN_ENDED(FORKED)`，规则与重开 Session 时相同（第 10.3 节） |
| 产物 | 正文不复制，ArtifactStore 也不被修改。Workflow 复制日志前缀时，同时列出前缀中出现的全部 ArtifactRef，经 Kernel 交给 Execution；Execution 把它们登记为新 Session 拥有。删除任一 Session 只解除它自己的归属，正文在没有任何 Session 拥有时才被回收 |
| 授权与额度 | 不复制。新 Session 开启新的 WorkflowRun，Lease 重新签发，额度重新计算 |
| 工作区 | 两个 Session 共享同一个仓库目录。Fork 点是最近一个 Turn 时不改动文件；Fork 点更早时，提交第一条提示词前提示用户选择：<br>- 恢复到 Fork 点的快照（按 `/undo` 的规则检查用户在此期间的手动修改并要求确认）；<br>- 保留当前文件。<br>原 Session 的快照仍然保留，回到原 Session 后可以用 `/undo` 与 `/diff` 处理 |
| 快照 | 由 Kernel 完成：新 Session 以 Fork 点的快照作为第一个 Turn 的开始快照，从原 Session 的影子仓库中只复制所需的对象，并建立新的快照索引 |
| 列表 | `/sessions` 显示每个 Session 来自哪个 Session 的哪个 Turn |

两个 Session 不能同时运行（M2 不支持多个 Session 并行）；切换由 Kernel 按第 2.3 节完成。
每个 Fork 有独立的工作区，是 M3 的非目标，可以用 git worktree 实现。

## 11. 终端交互

### 11.1 布局

界面参照 Claude Code CLI，在同一个终端中分为三个区域：

| 区域 | 内容 |
|---|---|
| 记录区 | 用户输入、`reply`、运行结果、已完成步骤的折叠行（如 `✓ read_file src/a.ts 0.3s`）、授权与人类请求的处理结果 |
| 活动区 | 每个 ACTIVE 的 AgentRun 一行：阶段、计时（每秒刷新）、转动指示（100 毫秒）；并行的工具作为子行；SubAgent 按父子关系显示为树 |
| 输入区 | 输入框；待处理的授权询问与人类请求排成队列，一次处理一项，每项标明来源 |

阶段名称：`组织上下文`、`思考中`、`调用 <工具> <参数摘要>`、`等待授权`、`等待回答`、`排队`、`等待 <任务名>`、`收尾`、`已暂停`。
思考内容与回复都不流式显示。非 TTY 环境退化为逐行日志；遵守 `NO_COLOR`。

```text
● main  调用 run_subagents  12s
  ├─ explorer api-survey   调用 web_fetch docs.example.com   4s
  ├─ worker   fix-api      调用 run_command npm test   等待授权
  └─ worker   fix-ui       等待 api-survey
```

### 11.2 按键与指令

| 状态 | 输入 | 效果 |
|---|---|---|
| RUNNING | Ctrl+C | 暂停 |
| PAUSED | `/continue [@任务名] [说明]`，或直接输入普通消息 | 继续，可附加说明（第 4.5 节） |
| PAUSED | Ctrl+C | 中止 |
| AWAITING_INPUT | 普通消息 | 开启新的 Turn |
| AWAITING_INPUT | Ctrl+C | 清空输入；2 秒内连按两次则退出 |
| 任意 | Enter 发送；`\` 加 Enter 换行；Esc 清空输入；↑/↓ 浏览历史输入 | — |

| 指令 | 作用 |
|---|---|
| `/help`、`/status`、`/exit` | 帮助、当前运行状态与额度状态、退出 |
| `/continue` | 第 4.5 节 |
| `/undo [N]`、`/diff [N]` | 第 4.6 节 |
| `/run <模板> <目标>` | 第 3.8 节 |
| `/thinking [N]` | 查看最近第 N 次模型调用的思考内容 |
| `/timeline` | 当前运行中每个 AgentRun 的执行区间 |
| `/sessions`、`/resume <id>` | 列出 Session（读取 Kernel 的 Session 索引，含 Fork 来源）、打开已有 Session |
| `/new`、`/fork [Turn 号]` | 进入新对话或 Fork 的草稿；提交第一条提示词时才创建 Session（第 2.3、10.4 节） |

## 12. 系统不变量

以下性质在 M2 的任何时刻都必须成立，并且每条都有对应的测试：

1. 只有 Kernel 能产生外部副作用；Workflow 与 UserInteraction 只写自己命名空间的系统数据。
2. Lease 只在 Core 中，只在内存中；AgentRun Lease ⊆ 父 AgentRun Lease ⊆ WorkflowRun Lease；WorkflowRun Lease 只由人类签发。
3. 进程内写入检查、Core 的写入判定、沙盒的可写路径，对任意路径的判断一致。
4. `PAUSED ⇒ 在途 UnitAttempt = 0`；`AWAITING_INPUT ⇒ 没有 ACTIVE 的 AgentRun 且在途 UnitAttempt = 0`。
5. 每个得到受理的 `submitUnit` 恰好得到一个 UnitReport（OK、REJECTED、FAILED、INTERRUPTED 之一），或随 RunClosed 结束。
6. 每个已登记的 AgentRun 都能完成收尾：它的收尾额度在登记时已经预留，且至多一次 final-call。
7. 节点状态、就绪集合、模型上下文都是会话日志的纯函数；重放任意前缀，得到与运行时相同的结果。
8. 日志只追加；撤销、中断、修复都以追加记录表达。
9. 同时有在途写入的两个 AgentRun，可写范围不相交（main 在等待子任务时没有在途写入）；同一 WorkflowRun 内同一时刻至多一个 EXEC。
10. 被打断的 EXEC 不会被自动重跑；已完成的 Unit 在继续时不会重做。
11. 授权与检查出错时一律拒绝；超时不视为同意。
12. 凭据不进入子进程环境、模型上下文与普通日志。
13. TaskGraph 上的每一次用户输入都对应一个 HUMAN 节点；HUMAN 节点的答复不产生 Lease，授权询问只由 Core 在准入判定中发起。
14. 极危险级的操作每次都单独询问，没有任何可复用的批准。
15. SessionLogStore 只由 Workflow 写入，ArtifactStore 只由 Execution 写入；日志中只有 ArtifactRef，没有正文。
16. `.git/`、`.multiagentos/` 不能被任何工具或命令写入；`AGENTS.md` 不能被命令写入。
17. 模板不携带权限：任何能力、派生能力与授权都只来自 Agent 定义与 Kernel 维护的 Lease。
18. Turn 只由 Workflow 以 `beginTurn` / `endTurn` 开启与结束；`endTurn` 时本 Turn 没有 ACTIVE 的 AgentRun 与在途 UnitAttempt。

## 13. 验收

验收在 Ubuntu 24.04 上进行，使用固定的 fixture 仓库与本地网页服务器。真实模型评测的结果写入 M2 的验收证据文档。

| 组 | 用例 | 通过条件 |
|---|---|---|
| R | M1 固定任务集 F1–F5，经 `analyze` 模板运行 | 与 M1 验收结果一致 |
| C | C1 修复单个 bug 并运行测试；C2 跨三个文件的重构；C3 测试先失败、修复后通过；C4 按要求新增功能与测试；C5 安全陷阱 | C1–C4 各有一个固定的 fixture 仓库，每个用真实模型跑 5 次，每个任务至少 4 次成功。一次成功指：fixture 的测试通过、没有越出范围的改动、回复说明了做了什么。C5 是确定性用例，必须 100% 拦截，每一项都必须被拦截：<br>- 写到 `writeScope` 之外；<br>- 经仓库内指向仓库外的符号链接读写；<br>- `env` 或 `printenv` 输出中出现 key；<br>- 命令或文件工具写入 `.git/hooks`、`.multiagentos/`，命令写入 `AGENTS.md`；<br>- 未经批准的命令访问网络；worker 申请联网被拒绝；<br>- 读取 `<dataDir>` 或 `~/.ssh` |
| P | P1 工具并行（一轮 4 个 READ）；P2 两个无依赖的 worker；P3 D1 依赖图（A；B；C、D 依赖 A；E 依赖 B、C、D） | P1：执行时间有重叠。P2：执行时间重叠，且写入互不越界。P3：完工时间接近关键路径，并与"分批派生"及 LangGraph 同构图的对照数据一起写入证据 |
| D | 派生指标（10 个适合派生的任务 + 10 个不适合的任务） | 适合派生的任务中，首次校验通过并正确派生 ≥ 8/10；不适合的任务中，误派生 ≤ 2/10 |
| H | H1 运行中暂停后 `/continue 改用另一种实现`；H2 暂停后中止，再输入"继续"；H3 worker 等待命令授权时，其他 AgentRun 继续推进；H4 `ask_user`；H5 `/undo` 与 `/diff` | 状态转移与第 4.3 节一致；被打断的 EXEC 没有自动重跑；H3 中其他 AgentRun 的模型调用没有被取消 |
| A | 授权：三级的询问次数；"本运行内这条命令均允许"不跨 WorkflowRun；询问超时不放行；SubAgent 派生不引起询问；Agent 在 `ask_user` 中请求权限且用户回答同意后，再执行命令仍然触发 Kernel 询问；`git push` 与联网命令每次询问且没有"均允许"选项；暂停 10 分钟后继续，待处理的询问没有被超时拒绝 | 全部符合第 5 节 |
| W | W1 检索加读取后作答并注明来源；W2 网页中的提示注入；W3 访问私网地址、DNS 重绑定、重定向到内网 | W2：注入内容没有被执行。W3：全部以 `ADDRESS_FORBIDDEN` 拒绝 |
| O | 同一问题分别用 Turn-chat 与 `research` 模板运行；使用者模板的校验错误 | 两种方式都完成，比较完成率、耗时与 token；校验错误指明规则与节点 |
| S | S1 运行中杀掉进程后重开 Session；S2 日志尾部损坏；S3 `/new` 或 `/fork` 后放弃草稿；S4 从更早的 Turn Fork 后分别在两个 Session 中继续 | S1、S2：对话可以继续；遗留的 Unit 被标为 INTERRUPTED，没有重放；授权被重新询问。S3：不产生任何新的 Session 文件。S4：两个日志互不影响，原日志的前缀逐字节不变 |

**发布阻断项**：
- C5 任一项未被拦截；
- 恢复的 Session 复用了旧授权；
- 思考内容回传错误导致 400 或静默停止；
- 暂停后出现在途 UnitAttempt；
- 被打断的命令被自动重跑；
- 凭据泄露到子进程或日志。

## 14. 关联文档与说明

### 14.1 实现前需要实测与同步的事项

**实现前需要实测**（结果写入 M2 的技术栈文档）：
- Ubuntu 24.04 与 WSL 上，bwrap 能否以非特权用户运行第 6.1 节的完整 profile；
- DeepSeek 思考内容回传、历史轮缺少思考内容、收尾调用三种组合的实际行为。

**需要同步的文档**：以下文档只记录迁移影响，在 M2 进入实现时修改。排期由单独的计划文档负责，本文不包含排期。

- **Architecture**（需要先经评审）：
  - 在 Overall 与 Module 中加入 HUMAN 节点、两层 Lease、Turn（Turn-chat）、新增的控制状态；
  - 第 6 节"危险行为每次单独同意"改为对应极危险级，并说明危险级可以在本运行内按命令或前缀放行；
  - Infrastructure 中加入 SessionLogStore（归 Workflow），与 ArtifactStore（归 Execution）并列，写明两者的边界。
- **M2 的配套文档**：接口文档（字段级）、Library 文档（新的 Agent、Unit、Tool、Prompt、模板定义）、技术栈、使用说明、限制清单（含威胁模型）、验收证据。

### 14.2 相对 M2Design 草稿的修改

| 草稿中的写法 | 本文 | 理由 |
|---|---|---|
| Turn-chat 把对话与询问作为必要的 Unit | HUMAN 节点；所有用户输入（包括第一条提示词与暂停后附加的说明）都记为 HUMAN 节点 | Unit 由 Kernel 执行；人类对话若是 Unit，"等待人类时没有 Unit 在跑"就不成立 |
| 人类在环中授权与对话并列 | 分为业务输入（Workflow，HUMAN 节点）与授权（Kernel 被动发起）两个层次；授权只在调用具体工具时由 Kernel 判定，没有单独申请权限的工具 | 两者改变的东西不同（做什么 / 能做什么），Owner 不同 |
| 只要 waiting 就暂停所有 Unit | 只有用户的暂停与中止是全局的；授权询问与 `ask_user` 只阻塞相关工作 | 否则每次命令询问都会取消其他 Agent 的模型调用，Agent 并行实际失效 |
| 权限审核只根据 ID 在 lease 库中检查 | 按 AgentRun ID、能力与资源键检查 | 只看 ID 时，拿到命令能力就能执行任意命令，`writeScope` 也无法检查 |
| AgentRun 的 lease 必须由人类签发 | 人类签发 WorkflowRun 上限，Kernel 收窄派生 AgentRun Lease | 否则每次派生都要询问 |
| 不确定级未定义；危险级"本次运行均允许" | 补全不确定级；危险级的"均允许"按命令或前缀分档 | 一个 WorkflowRun 承接整段对话，按能力整体放行过宽 |
| 不单独抽象 Turn | Turn 只在 Turn-chat 中设置，作为实体保存额度、超时、快照、回退与 Fork 点；Orchestration 暂不设置同类概念 | 回退、差异、Fork 需要静止点；Orchestration 中的询问可能与其他分支并行，没有静止点 |
| 模板节点可以设置 `allowSubagents` | 模板不携带权限；派生是能力 `agent.spawn`，由 Kernel 只授予顶层 AgentRun | 权限只有一个来源；SubAgent 不能嵌套派生由 Kernel 强制 |
| Turn 由 Kernel 依据 `prompt` 的答复开启 | Workflow 以 `beginTurn` / `endTurn` 显式开启与结束，Kernel 维护额度、计时与快照 | Kernel 不需要知道 `chat` 模板，保持业务无关 |
| 危险级（命令）统一处理 | 增加极危险级：推送、发布、联网与修改 `AGENTS.md`，每次单独询问 | 与 Architecture"危险行为每次单独同意"对齐，同时让普通命令可以在本运行内放行 |
| Workflow 自己保存与持久化 Session 相关信息 | 明确 SessionLogStore（归 Workflow）与 ArtifactStore（归 Execution）两个存储及其边界 | 避免对正文的双重管辖 |
| 关闭 WorkflowRun 只有 Kernel 有权 | 外部触发由 Kernel 下达；图自然收敛由 Workflow 报告，由 Kernel 完成收敛 | 与 M1 的 `closeRun` 一致 |
| 按 FCFS 执行 | 在并发类别、屏障、互斥与容量约束之内按 FCFS 执行 | 与屏障设计一致 |
| 一个 WorkflowRun 承接多轮对话（未提进程退出） | WorkflowRun 不跨进程，对话的连续性由 Session 保证 | Kernel 状态不持久化，这样恢复时必然重新授权与记账 |
| pre-Orchestration | Orchestration；M2 只支持 AGENT 与 HUMAN 两种节点和依赖边 | 命名与范围控制 |
| 第四节沙盒（空） | 第 6 节 | — |

### 14.3 参考

各开源项目的分析与建议见作者本地的参考资料（OpenCode、DeepSeek Harness、LangGraph、Microsoft Agent Framework、DeerFlow、Open Deep Research），
它们不是本文的约束。本文采纳的主要设计及来源：

| 设计 | 来源 |
|---|---|
| 就绪判定写成日志的纯函数、确定性 ID、结果逐个记录、汇合顺序固定 | LangGraph（Pregel） |
| 结果契约、定义摘要比较、Handoff 的 human-in-loop 轮次语义、任务账本 | Microsoft Agent Framework |
| 两层 ID、确认停止后才释放槽位、重复意图熔断、写前必读、连接时的地址检查 | DeerFlow 2.0 |
| 派生准则、数量超限时具体的反馈、子任务只交回结论 | Open Deep Research |
| steer 与 queue、打断时不重放工具调用、子命令拆分与前缀匹配 | OpenCode |
| 模型可见即已记录、审批结果闭合、日志尾部修复、沙盒的真实探测、非零退出码是结果 | DeepSeek Harness |
