# MultiAgentOS M2 设计

> 状态：v1.7 定稿（2026-10-31）。作者：CaryHe-maker。此后改变设计含义的修改须发布新版本，并记入文末的版本记录；只改链接、错字、格式的编辑性修改不升版本，同样记入版本记录。
> 本文是 M2 的总体设计：说明 M2 相比 M1 增加的全部能力、每项能力的机制与 Owner、它们之间的关系，以及验收、交付顺序（只有阶段与依赖，不含日期）与待决事项。
> 字段级接口、Schema 清单与定义实例在实现阶段写入 M2 的接口文档与 Library 文档，本文只给出语义与约束。
> 长期概念与安全边界以 [Architecture](../Architecture/README.md) 为准；M1 已交付的机制以归档的 [M1 文档](../History/M1/README.md) 为准，
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
| G7 | 分级授权与沙盒：四级能力、能力上限与授权条目两步判定、bubblewrap | 第 5、6 节 |
| G8 | Session：多轮对话持续，重开 Session 后对话可以继续 | 第 2.3、10 节 |
| G9 | 终端界面：参照 Claude Code CLI，显示阶段、工具、计时与 SubAgent 树 | 第 11 节 |

### 1.3 非目标

下列能力不属于 M2。遇到相关请求时，系统给出结构化的 Unsupported 结果，而不是静默忽略。

- **跨进程续跑**：进程退出后，正在运行的 WorkflowRun 不能原地恢复。重开 Session 时对话可以继续，但开启的是新的 WorkflowRun（第 2.3 节）。
- **任务图能力**：SubAgent 再派生 SubAgent（嵌套派生）、没有次数上限的循环、以任意代码表达的条件、`any` 与 `quorum` 汇合、模板级的动态扇出（map）、Agent 之间的直接消息传递（M2 支持的边与触发规则见第 3.1 节）。
- **无人值守**：无人值守运行（unattended）、定时任务、自动审批。
- **按节点回退**：Orchestration 运行整体是一个 Turn（第 2.1 节），`/undo`、`/diff` 不能回到运行中间的某个节点。
- **从历史位置分叉**：Fork 只能从 Session 的当前末端进行，不能从更早的 Turn 分出（第 10.4 节）。
- **多实例**：同一个 `dataDir` 同一时刻只运行一个 MultiAgentOS 实例（第 10.1 节）。
- **隔离副本**：每个 Agent 或每个 Session 一个工作区副本、再合并；M2 只预留接口（第 6.5 节）。
- **脱离操作的权限申请**：不对应任何具体操作、只用来申请权限的工具（第 5.5 节）。
- **扩展与接入**：MCP；使用者自定义 Agent 定义（M2 的模板只能引用内置 Agent）。
- **隔离方式**：Linux 以外平台的沙盒、Landlock 退路、容器与虚拟机级隔离。
- **调度与运行形态**：同一系统内多个 Session 并行运行、调度优先级、多用户、远程执行。
- **显示**：思考内容与回复的流式显示。
- **会话的自动清理**：Session 不会被自动删除，只由用户删除；系统只自动回收过期的产物正文（第 10.1 节）。

### 1.4 从 M1 到 M2 的变化

| 方面 | M1 | M2 | 位置 |
|---|---|---|---|
| 运行组织 | 一次进程一个运行，运行结束即退出 | 一个进程同一时刻打开一个 Session，可以切换；`mas run` 运行结束即退出；Turn-chat 中一个 WorkflowRun 承接多个 Turn | 2.1、2.3 |
| Agent | Planner 单向交接给 CodeViewer，同一时刻一个 ACTIVE | main、explorer、worker；多个 AgentRun 同时 ACTIVE；M1 的两个 Agent 作为内置模板保留 | 3.8、3.9 |
| 任务图 | 无，固定两步 | TaskGraph：AGENT 与 HUMAN 节点；依赖边、条件边与有界循环；节点触发规则；不可变的 GraphRevision；就绪即推进 | 3 |
| 模式 | 单次只读分析 | Turn-chat（内置模板 `chat`）与 Orchestration（内置或使用者模板） | 2.2、3.8 |
| 工具 | 概览、检索、读文件 | 增加列目录、只读 git 查看、写文件、编辑文件、执行命令、网页检索、网页读取 | 8 |
| 执行 | 全部 Unit 按 FIFO 串行 | 按 AgentRun 分队列；READ、WRITE、EXEC、MODEL 四类并发类别；运行级并发上限；按 provider 容量分配模型调用 | 7.1 |
| 授权 | `repo.read` 一种能力，每个运行问一次 | 安全、不确定、危险、极危险四级能力；先查 AgentRun 的能力上限（Kernel 计算，越界即拒绝），再查 WorkflowRun 的授权条目（人类签发，没有就询问）；按资源键判定 | 5 |
| 沙盒 | 无（只读） | bubblewrap：可写路径、网络、遮蔽目录由 AgentRun 的能力上限与本次 Lease 计算；`$HOME`、`<dataDir>` 与仓库中的敏感文件被遮蔽；`.git/`、`.multiagentos/`、`AGENTS.md` 只读，命令新建它们会被隔离 | 6 |
| 额度 | 按 WorkflowRun 一份账本，一次 final-call | WorkflowRun → Turn → AgentRun 逐级委派：上级预先划出份额，下级各自记账，结束时把剩余返还上级；每个 AgentRun 一份收尾保留与一次 final-call；工具次数与墙钟上限归 Kernel，重复意图与连续出错熔断归 Workflow | 7.3、3.4 |
| 人类在环 | 开始时一次 Y/N；可以取消 | 分为两个层次：业务输入一律记为 TaskGraph 上的 HUMAN 节点（含 `ask_user`）；授权只由 Kernel 在准入时被动发起。另有暂停、继续、中止、回退等控制操作 | 4 |
| 控制状态 | RUNNING、CONVERGING、CLOSED | 增加 PAUSING、PAUSED、INTERRUPTING、AWAITING_INPUT | 4.3 |
| 持久化 | 运行结束时写一条运行记录 | SessionLogStore：以 Session 为单位的只追加会话日志（归 Workflow）；ArtifactStore 仍归 Execution，改为跨 Session 共享内容、按 Session 登记归属，正文分为长期保留与 7 天过期两类；Kernel 的快照索引；工作区快照、实例锁与 Session 锁、格式版本；Session 延迟创建与 Fork | 10 |
| 上下文 | 按 Round 组装，一次运行内有效 | 由会话日志投影，跨 Turn、跨 WorkflowRun；思考内容回传；工具结果的预览在产生时固定；超出窗口时由 Kernel 以模型摘要压缩并写回日志；两次压缩之间请求只在末尾追加，以利于提示词缓存 | 9 |
| 模型 | 关闭思考模式，收尾强制工具选择 | 按 Agent 与任务选择思考强度；回传 `reasoning_content`；收尾调用的新规则 | 9.4 |
| 界面 | 一次输入、一次输出 | 记录区、活动区、输入区；Ctrl+C 暂停与中止；斜杠指令 | 11 |
| 子进程 | 只有 `rg` | `rg`、命令（bwrap + sh）、git（工作区快照与只读查看） | 2.5 |
| 协议 | Schema major 0 冻结 | 变化的 Schema 发布新 major 1；M1 固定任务集经内置模板 `analyze` 回归 | 7.5、13 |

## 2. 运行模型

### 2.1 概念层次

`{}` 表示抽象对象（定义或持久的身份），`[]` 表示运行实体。

```text
{System}  → [SystemRuntime]                    一个 CLI 窗口 = 一个进程 = 一个 SystemRuntime = 唯一的 Kernel 实例
{Session} → [WorkflowRun] → [TaskGraph]         Session 内的 WorkflowRun 依次进行，同一时刻至多一个活动
            └ [Turn]                            一条开放输入（HUMAN(prompt)）引出的全部工作；由 Kernel 依据开放输入开启与结束
{Template} → [TaskGraph]                        每个 WorkflowRun 以一个模板开启；模板由 Workflow 编译为 TaskGraph 的初始 GraphRevision
{Agent}   → [AgentRun]                          AgentRun 是 TaskGraph 上的 AGENT 节点
{Unit}    → [UnitRun] → [UnitAttempt]           UnitRun 归 Workflow（业务拓扑中的位置），UnitAttempt 归 Kernel（一次实际执行尝试）
```

| 层 | 定义 | 生命周期 | Owner |
|---|---|---|---|
| SystemRuntime | 一个进程中的整个系统 | 进程启动到退出 | 组合根；Kernel 是唯一的运行决策者 |
| Session | 一个仓库上的持续工作档案：会话日志、产物、工作区快照 | 创建后持久存在，直到用户删除 | Session 列表与会话日志归 Workflow；Kernel 只保存 Session 的引用与自己命名空间中的数据，生命周期指令只由 Kernel 下达；UserInteraction 不保存任何 Session 信息，一切以 Kernel 交给它的为准（第 2.4 节） |
| Template | TaskGraph 的定义：节点、依赖、生长规则；有版本，不可变 | 定义层，不是运行实体 | 内置模板在 AgentToolPool，使用者模板在仓库中；由 Workflow 编译。模板不携带任何权限（第 3.8 节） |
| WorkflowRun | 一次受治理的执行期：一张 TaskGraph、一份授权条目集合、一份运行级额度 | 开启到收敛；不跨进程 | 业务状态归 Workflow，控制状态归 Kernel |
| Turn | 一条开放输入（`HUMAN(prompt)`）引出的全部工作。Turn-chat 中每条用户消息一个 Turn；Orchestration 运行只有开头的目标一个开放输入，整个运行就是一个 Turn | Kernel 在开放输入得到答复时开启，在下一次请求开放输入或运行收敛时结束；保存本 Turn 的额度、超时、开始与结束快照、用量与结束原因 | Kernel.Core（额度归 Monitor，快照归 Execution）；Workflow 从事件中得知 `turnId`，只用于日志与投影（第 2.3 节） |
| AgentRun | 一个 Agent 在 TaskGraph 上的一次执行 | 登记到结束 | Workflow 持有实例，Kernel 登记身份、能力上限与额度 |
| UnitRun | Workflow 决定要执行的一个 Unit：拓扑中的位置与确定性 ID | 提交到得到结果 | Workflow |
| UnitAttempt | Kernel 为 UnitRun 建立的一次执行尝试；技术重试产生新的 UnitAttempt，UnitRun 不变 | 建立到结果检查 | Kernel.Execution |

**Turn 由开放输入界定。** 人类请求在 Kernel 层分为两类（第 4.2 节）：
- **开放输入**（`prompt`）：用户主动发起、内容不受限制的输入，要求全局静止，即请求时没有 ACTIVE 的 AgentRun，也没有在途 UnitAttempt；
- **局部询问**（`ask`、`confirm`、`review`）：只阻塞相关的工作，其他分支照常推进。

这一分类是控制层面的约束，不是业务含义，所以 Kernel 可以据此维护 Turn，而不需要知道 `chat` 或任何模板。
Turn 是有 ID 的实体，以下信息都按 Turn 保存与计量：额度、超时、开始与结束快照、`/undo` 与 `/diff`、派生上限。
Turn-chat 中每条用户消息开启一个 Turn；Orchestration 运行（`mas run`）只有开头的目标一个开放输入，整个运行就是一个 Turn。

**Turn 的边界是静止点**：Turn 结束时没有 ACTIVE 的 AgentRun、没有在途 UnitAttempt，工作区不会再被改动（由 Kernel 强制，第 2.3 节）。
只有在静止点拍快照，回退才能回到一致的状态；也只有在静止点结算额度，才不会把一个任务的消耗切成两半。
`ask`、`confirm`、`review`、`steer` 发生在工作进行之中，只阻塞相关的 AgentRun，其他 SubAgent 可能仍在写文件、跑命令（第 4.3 节"全局与局部"），
所以它们不是 Turn 的边界。Orchestration 模板中的询问同样是局部询问，因此一个 Orchestration 运行内部没有静止点，只能整体回退。

### 2.2 两种模式

两种模式使用同一种 TaskGraph、同一条推进规则、同一个 Kernel，区别只在图的来源：

| | Turn-chat | Orchestration |
|---|---|---|
| 图的来源 | 内置模板 `chat`：`HUMAN(prompt) → main → HUMAN(prompt) → main → …`，每次 main 结束（不论成败）后追加下一对节点 | 模板文件（内置或使用者编写，第 3.8 节）编译出初始图 |
| 运行中扩展 | main 调用 `run_subagents` 派生子图 | 引用 main 的 AGENT 节点调用 `run_subagents`（派生能力由 Kernel 维护，第 5.2 节） |
| 与用户对话 | 默认在每次 main 回复之后；运行中只在必要时（`ask_user`、授权询问） | 只在模板中的 HUMAN 节点、`ask_user` 与授权询问时 |
| WorkflowRun 何时结束 | 新的 Session 真正创建时（第 2.3 节）、`/exit`、切换 Session、Workflow 因运行级额度到达限制以 `closeRun(BUDGET)` 报告、进程退出 | 图收敛（没有可以就绪的节点）、中止、Workflow 因额度到达限制以 `closeRun(BUDGET)` 报告、进程退出 |
| 在对方之中使用 | — | 在 Turn-chat 中执行 `/run <模板> <目标>`，当前 Turn 的主体换成该模板的实例，结果回到对话中；模板实例属于这个 Turn，照常受 Turn 的额度、超时与回退约束 |

Turn-chat 是 Orchestration 的子集：`chat` 模板只用到 AGENT 与 HUMAN 两种节点，并按固定规则追加。

### 2.3 生命周期规则

**Session**

0. **进程绑定一个仓库**：启动时的工作目录（或 `--repo` 参数）决定本进程的仓库，取其 realpath 作为仓库根目录，进程运行期间不变。
   每个 Session 属于创建它时的仓库；`/sessions` 与 `/resume` 只列出、只打开本仓库的 Session。Kernel 打开 Session 时检查引用中的仓库根目录与本进程的一致，不一致时拒绝。
1. **打开已有 Session**（`/resume`、启动时选择）：UserInteraction 把选择交给 Kernel，由 Kernel 向 Workflow 发出 `SessionOpen` 事件。
   Workflow 收到后取得 Session 锁、校验并修复日志、重建投影（第 10.3 节）。
2. **新建与 Fork 都延迟到第一条提示词提交时才创建**：
   - 用户执行 `/new` 或 `/fork` 只让界面进入"草稿"状态，不创建任何文件，当前 Session 与 WorkflowRun 也保持不变；
   - 用户在草稿中提交第一条提示词时，UserInteraction 发出 `startSession({ new | fork, prompt })`。Kernel 依次收敛当前 WorkflowRun、释放旧锁，
     再由 Workflow 在 SessionLogStore 中创建新 Session（Fork 时复制整个日志），由 Kernel 登记产物归属（第 10.4 节），
     然后开启 WorkflowRun，把这条提示词记为第一个 `HUMAN(prompt)`，并开启第一个 Turn；
   - 用户放弃草稿（`Esc`、`/resume` 回到原对话、退出）时什么都不留下。

   因此每个 Session 至少有一个 `HUMAN(prompt)`，不会出现空的或重复的 Session 副本。
3. 删除 Session、切换 Session 只能由 Kernel 下达。切换时先收敛当前 WorkflowRun，再释放锁，再打开目标 Session。
   删除只针对未打开的 Session（要删除当前 Session，先切换或新建）：由 Workflow 删除 SessionLogStore 中的日志，并在 Session 列表中标为已删除；由 Kernel 把 Session 引用标为已删除，删除审计、快照与快照索引，并由 Execution 删除该 Session 的归属文件（第 10.1 节）。
   Workflow 删除失败时，Kernel 仍然标记并删除自己的文件；新建 Session 失败时同样删除 Kernel 已为它写入的文件。回收只看 Session 引用的状态，所以残留的文件不会让正文继续被保留。
4. 同一个 `dataDir` 同一时刻只运行一个 MultiAgentOS 实例（`instance.lock`，第 10.1 节）；第二个实例启动时报错，并说明哪个进程持有锁。
5. 同一个 Session 同一时刻只能被一个进程打开（`session.lock`）。在第 4 条之下它不会被争用，保留它是为了以后放开多实例时不必修改 Session 的打开流程。
6. **打开或切换 Session 不改动工作区**：切换的只是系统内部状态（Workflow 重建该 Session 的投影，Kernel 开启新的 WorkflowRun），文件保持原样（与 OpenCode、DeepSeek Harness 相同）。
   离开期间工作区的变化（在其他 Session 中工作、用户手动修改）是后续对话需要知道的信息，而不是需要撤销的错误：
   - Kernel 比较当前工作区与该 Session 最后一个 Turn 的结束快照（没有结束快照时用开始快照），有差异时把改动的文件列表交给 Workflow，不询问用户；
   - Workflow 追加 `WORKSPACE_DIVERGED`，main 的上下文中注明"自上次对话以来，以下文件在本 Session 之外被修改过"；
   - 这些文件此前的读取结果不能再作为 `baseSha` 的依据，编辑前必须重新读取（第 6.4 节）；
   - 界面显示一行提示与文件数量。用户若要撤销本 Session 自己的改动，使用 `/undo`（第 4.6 节）。

**WorkflowRun**

1. WorkflowRun 的开启由 Kernel 下达：打开 Session 之后、`mas run`、因额度结束后用户确认继续时（对当前 Session 再次 `openSession`，在同一个 Session 中开启新的 WorkflowRun）。Turn-chat 中的 `/run` 不开启新的 WorkflowRun（第 2.2 节）。
   **`mas run <模板> "<目标>"` 总是新建一个 Session**，不复用已有的 Session：目标作为第一个 `HUMAN(prompt)`，整个运行是这个 Session 的第一个 Turn。
   运行收敛、发布结果后进程退出。之后可以用 `/resume` 打开这个 Session，以 Turn-chat 继续：main 的上下文中带有这次运行的结果，也可以用 `/undo` 回退整个运行。
   Workflow 追加 `WORKFLOW_RUN_STARTED`，用 `readProjectFile` 读取 `AGENTS.md`（使用者模板也在此时读取），编译模板，再启动第一个节点。
2. WorkflowRun 结束的发起方有两类：
   - Kernel 发起：用户指令（`/exit`、切换或新建 Session）、安全停止与 `shutdown`，由 Kernel 进入收敛；
   - Workflow 报告：图自然收敛；额度到达限制后完成收尾（`BUDGET`，第 7.3 节）；Orchestration 中止后（`CANCELLED`）或 Turn 超时后（`TIMEOUT`）收敛完节点；以及 Workflow 判定无法继续。都由 Workflow 以 `closeRun` 报告（与 M1 相同）。
     额度与超时都不是 Kernel 直接强制收敛运行的理由：超时由 Kernel 按中止处理（第 2.3 节 Turn 第 3 条），收敛由 Workflow 报告。

   两种情况下，最终都由 Kernel 完成收敛并发出 `RunClosed`。
3. **WorkflowRun 不跨进程。** Kernel 的运行状态（能力上限、授权条目、Lease、额度账本、在途尝试）只在内存中。进程退出等于 WorkflowRun 结束；
   重开 Session 时 Workflow 先结算遗留记录（第 10.3 节），再由 Kernel 开启新的 WorkflowRun。
   因此授权条目必然由人类重新签发，额度必然重新计算，不会出现恢复旧授权的问题。
4. 对话的连续性由 Session 保证，而不是由 WorkflowRun 保证：Turn-chat 中 main 的上下文来自整个 Session 的日志投影（第 9.1 节），
   新的 WorkflowRun 中 main 仍然能看到之前的对话。

**Turn**

Turn 由 Kernel.Core 依据开放输入开启与结束（第 2.1 节），Workflow 没有任何开启或结束 Turn 的 syscall。

| 时机 | Kernel 检查 | Kernel 动作 |
|---|---|---|
| **开启**：开放输入得到答复（`answerHuman`，种类 `prompt`），或 `startSession`、`mas run` 带来的初始输入 | 本运行没有开启中的 Turn | 1. 分配 `turnId` 与序号；<br>2. 拍摄开始快照并写入快照索引（第 4.6 节），快照完成之前保留 Unit，不派发；<br>3. 从运行级账本为本 Turn 划出份额（第 7.3 节），开始计时；<br>4. 在交给 Workflow 的 `HumanAnswered` 中带上 `turnId`（Workflow 据此更新 Session 列表） |
| **结束**：Workflow 请求下一个开放输入（`requestHuman`，种类 `prompt`），或 WorkflowRun 收敛 | 没有 ACTIVE 的 AgentRun，也没有在途 UnitAttempt。请求开放输入时不满足，以 `AGENT_RUN_ACTIVE` 拒绝该请求 | 1. 拍摄结束快照；<br>2. 结算 Turn 账本，剩余返还运行级账本；<br>3. 在快照索引中补上结束快照与改动文件列表（第 4.6 节）；<br>4. 向 Workflow 发出 `TurnClosed { turnId, reason, 用量摘要, 两个快照的引用 }` |

1. **登记**：Turn 开启期间登记的 AgentRun 自动归入该 Turn，`registerAgentRun` 不带 `turnId`；没有开启中的 Turn 时登记被拒（`NO_OPEN_TURN`）。
2. **结束原因**由 Kernel 依据自己的状态判定：`COMPLETED`（正常请求下一个开放输入）、`ABORTED`（从 INTERRUPTING 结束）、`TIMEOUT`、`BUDGET`、`RUN_CLOSED`（运行收敛）。
3. **超时**：Turn 超时时，Kernel 按中止处理本 Turn（进入 INTERRUPTING，第 4.5 节），记下原因 `TIMEOUT`。Workflow 收敛节点后，
   Turn-chat 请求下一个开放输入，Orchestration 以 `closeRun` 报告，Turn 随之结束。
   额度触顶不中止，而是按第 7.3 节的统一收尾路径收尾；收尾后的结束原因记为 `BUDGET`。
4. **静止保证**：开放输入只能在静止时请求，Turn 只在静止时结束，所以每个 Turn 结束时所有工作都已停止。

| 数据 | 维护者 | 内容 |
|---|---|---|
| `TurnRecord` | Kernel.Core | `turnId`、`workflowRunId`、序号、`OPEN` / `CLOSED`、开启时间、结束原因、用量 |
| Turn 账本 | Kernel.Monitor | 委派账本：运行 → Turn → AgentRun（第 7.3 节） |
| 快照索引 | Kernel.Execution | `{ turnId, seqNo, viewId, startSnapshot, endSnapshot, changedFiles }`，以及回退时追加的 `{ revertedTurnIds, forced, backupSnapshot }`；持久化在 Kernel 命名空间；`viewId` 在 M2 中恒为 `main`（第 6.5 节） |
| `TurnProjection` | Workflow | `turnId`、序号、提示节点、本 Turn 的节点集合、回复引用、结束原因；由 `TURN_STARTED`、`TURN_ENDED` 投影得到，不另存 |

**Kernel 负责**：Turn 的开启与结束、静止检查、结束原因、Turn 额度、计时、快照与快照索引。
**Workflow 负责**：收到 `HumanAnswered { turnId }` 时追加 `TURN_STARTED`，收到 `TurnClosed` 时追加 `TURN_ENDED`；为上下文条目标注所属 Turn、在回退后替换历史；
收到中止、超时或额度信号后收敛节点。Workflow 只记录 Turn，不控制 Turn；它唯一需要遵守的是"只在静止时请求开放输入"。

### 2.4 所有权

| 数据或决定 | Owner | 其他组件能做的 |
|---|---|---|
| TaskGraph、节点状态、推进、上下文组装输入、会话日志（SessionLogStore） | Workflow | Kernel 只看到 AgentRun 登记与 UnitIntent |
| 上下文压缩的时机与执行（第 9.6 节） | Kernel.Core（摘要调用的额度归 Monitor，执行经 Execution） | Workflow 应 Kernel 的查询交出可压缩的条目，并把压缩结果按固定规则记入日志；不决定是否压缩 |
| 人类请求（HUMAN 节点）的业务含义 | Workflow | Kernel 转发请求与答复，只区分开放输入与局部询问 |
| Session 列表（标题、Fork 来源、Turn 数、最后活动时间）与会话日志 | Workflow | Kernel 保存 Session 引用（`sessionId`、状态与仓库根目录），由 Session 管理以系统级事件（第 2.6 节）向 Workflow 查询后交给 UserInteraction |
| 界面上显示的一切 Session 信息 | 不归 UserInteraction | UserInteraction 不保存 Session 列表、标题或 Fork 关系，只展示 Kernel 交来的结果；输入历史等纯界面偏好除外 |
| Turn 的开启与结束、静止检查 | Kernel.Core（Turn 额度归 Monitor，快照归 Execution） | Workflow 从 `HumanAnswered`、`TurnClosed` 得知 Turn 并记入日志 |
| 授权询问、能力上限、授权条目、Lease、SandboxProfile | Kernel.Core | Workflow 只得到裁决与原因码 |
| 运行控制状态（第 4.3 节） | Kernel.Core | Workflow 与 UserInteraction 经事件得知 |
| 额度账本、工具次数与墙钟计数 | Kernel.Monitor | Workflow 只得到 `BudgetView` 与触顶项，不持有 token 数值 |
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

`file-write`、`file-edit` 也在进程内执行。Architecture Supervisor 第 4 节把"文件修改"列为不可信行为、要求每次在独立的子进程中运行；
M2 是有意偏离：这两个 Executor 是可信的内置代码，处理的只是不可信的路径与内容，安全由 `isWritable` 与 Core 的判定保证（第 6.3 节）。见第 14.1 节。

### 2.6 Kernel 中的 Session 级处理

M1 的 Kernel 核心只有两层：运行管理（只保存 `workflowRunId → 运行 actor` 的映射）与每个 WorkflowRun 的运行 actor（Architecture Kernel 第 3.2 节）。
M2 有一部分请求与状态不属于任何一个 WorkflowRun：

| 请求或状态 | 为什么不属于某一个 WorkflowRun |
|---|---|
| `openSession`、`startSession`、`deleteSession`、`listSessions`，打开 Session 时比较工作区 | 发生在 WorkflowRun 开启之前或结束之后 |
| 快照索引、产物归属、审计 | 跨越同一 Session 中先后多个 WorkflowRun：`/undo` 可以回退上一个进程中的 Turn，后一个运行的上下文要引用前一个运行的产物 |
| Session 引用、`AGENTS.md` 信任记录、ArtifactStore 正文 | 跨越多个 Session |
| provider 调用容量（M1 已有） | 跨越多个运行 |

**Session actor**：M2 把串行处理的单位从 WorkflowRun 提升为 Session。每个打开的 Session 有一个 Session actor（M2 同一时刻至多一个），由 Core 的 Session 管理（即 M1 的运行管理）创建与回收：
- 它沿用运行 actor 的全部规则：一个 Inbox、控制通道优先、一条消息处理完才处理下一条、对其他通讯主体的调用只登记、由发送器按登记顺序发出；
- 它的状态分块分两层：Session 级分块（Core：本 Session 的审计与 Session 级 Outbox；Execution：快照索引、产物归属、隔离目录），以及当前 WorkflowRun 的分块（与 M1 运行 actor 的分块相同：授权条目、能力上限、账本、尝试、队列、`runEpoch`、运行级 Outbox）；
- WorkflowRun 的开启与收敛、Turn 的开启与结束、`/undo`、`/diff`、Session 的生命周期请求都在同一个串行循环中处理，因此"运行处于 AWAITING_INPUT 时才能回退"这类跨层检查不需要额外的同步；
- 事件有三个序列：运行级事件仍按 WorkflowRun 编号，`RunClosed` 是该运行发给接收方的最后一个事件（Architecture Protocol 第 6 节不变）；Session 级事件（`SessionOpened`、`SessionClosed` 等）按 Session 另行编号，`SessionClosed` 是最后一个；
  系统级事件不属于任何 Session（Session 列表的查询与结果、删除未打开的 Session），由 Session 管理发出，按进程编号——启动时还没有打开的 Session，`listSessions` 也必须能够完成。

**系统级状态**：Session 引用、`AGENTS.md` 信任记录、ArtifactStore 正文与回收、实例锁跨越多个 Session，由 Session 管理在 Session actor 之外处理。
实例锁（第 10.1 节）保证同一个 `dataDir` 只有一个进程，这些状态因此只有一个写入者。

Architecture 已据此修改（Module/Kernel 3.2、3.3，Evolution 第 2、4 节等）：串行处理的单位是 Session，分片的单位是 Session，跨运行的状态分为运行级、Session 级、系统级三层，每层有唯一写入者。

## 3. Workflow：任务图与推进

### 3.1 节点与边

| 节点种类 | 含义 | 完成条件 |
|---|---|---|
| `AGENT` | 一个 AgentRun：引用一个内置 Agent 定义，带目标、可写范围、额度份额与思考强度 | 该 AgentRun 调用结束控制工具（`reply`、`finish_subagent`、M1 的 `finish`），或以失败结束 |
| `HUMAN` | 一次业务层的用户输入，种类见第 4.2 节：`prompt`、`steer`、`ask`、`confirm`、`review` | 收到符合答复 Schema 的答复，或询问超时；初始 `prompt` 与 `steer` 在创建时就已带有用户输入，创建即完成 |
| `INTEGRATE`（预留） | 合并各隔离副本中的改动（第 6.5 节） | M2 不支持：模板或扩展中出现即以 `GraphValidationError(UNSUPPORTED_NODE_KIND)` 拒绝 |

| 关系 | 含义 |
|---|---|
| 依赖边（`dependsOn`） | 前驱结束后，后继按自己的触发规则判断能否就绪；多个前驱即为汇合 |
| 条件边（`when`） | 依赖边加一个谓词：前驱 SUCCEEDED 且谓词成立时这条边被选中，前驱 SUCCEEDED 但谓词不成立时这条边未被选中 |
| 循环边（`loop`） | 从一个节点回到它的某个祖先，带 `maxIterations`；见第 3.2 节的展开规则 |
| `attachedTo`（附属） | HUMAN 节点附属于一个 AGENT 节点：由该 AgentRun 发起的 `ask_user`，或投递给该 AgentRun 的 `steer`。附属关系不参与就绪判定，只决定答复交给谁 |

`Edge` 的 `kind` 为 `DEPENDS`、`CONDITIONAL` 或 `LOOP`。

**触发规则**写在节点上（`trigger`），决定节点何时就绪：

| 触发规则 | 就绪条件 | 跳过条件 |
|---|---|---|
| `all_success`（缺省） | 全部入边都被选中（前驱 SUCCEEDED，条件边的谓词成立） | 全部前驱结束后判定：任一前驱为 FAILED、INTERRUPTED 或 `SKIPPED(DEPENDENCY_FAILED)` → `SKIPPED(DEPENDENCY_FAILED)`；否则任一入边未被选中，或前驱为 `SKIPPED(NOT_TAKEN)` → `SKIPPED(NOT_TAKEN)` |
| `all_done` | 全部前驱都已结束，不论成败与是否被选中 | 不跳过 |

- `chat` 中下一个 `HUMAN(prompt)` 的触发规则是 `all_done`：main 失败或被中止后，对话照常继续；
- 模板中"即使部分分支失败也要汇总"的节点使用 `all_done`，它的输入中注明每个前驱的结束状态。

**条件的写法**：只允许声明式谓词 `{ field, equals | in }`，`field` 是前驱结构化结果中的字段路径，不允许任意代码，
因此就绪判定仍然只依赖日志中的结构化记录，是纯函数（第 3.3 节）。可以作为条件来源的结果有：
- HUMAN `confirm` 的答复（`confirmed: boolean`）与 `review` 的答复（`verdict: approve | reject`、`comment?`）；
- explorer、worker 的结构化结果（第 3.7 节，如 `status`）；
- M1 planner 的结束方式（`action: HANDOFF | FINISH`），只用于内置模板 `analyze`；
- main 的 `reply` 是文字，不能作为条件来源；模板编译时引用不存在的字段或不可作为来源的节点，以 `GraphValidationError` 报告。

`run_subagents` 只能使用依赖边与缺省触发规则；条件边、循环边与 `all_done` 只在模板中使用。

**TaskGraph 上的每一次用户输入都记为一个 HUMAN 节点**，没有例外：Turn-chat 的第一条提示词、之后的每条消息、
`mas run` 给出的目标、暂停后继续时附加的说明、对 `ask_user` 与模板询问的回答。
HUMAN 节点只表达业务输入，不是 Unit（Unit 是 Kernel 执行的操作，而人类输入不是执行），也不是授权（第 4.1 节）。
这一区分保证了不变式"等待人类时没有在途 UnitAttempt"（第 12 节）。

节点状态：`PENDING → READY → RUNNING → SUCCEEDED | FAILED | SKIPPED(DEPENDENCY_FAILED | NOT_TAKEN) | INTERRUPTED`。状态只由日志记录投影得到。

### 3.2 GraphRevision

- TaskGraph 是一串只追加的 GraphRevision。每个 Revision 是不可变的规格：节点、边、可写范围、额度份额、思考强度。
- Revision 有三个来源，经过同一个校验函数 `validateExtension(当前图, 提议) → GraphRevision | GraphValidationError[]`：
  - 模板编译：初始 Revision；`chat` 模板按它的生长规则在每次 main 结束后追加一对节点（第 3.8 节）；
  - 循环展开：见下文；
  - `run_subagents`：运行时扩展。
- **确定性 ID**：节点、UnitRun 与每次提交都有一条由日志确定的可读路径，ID 由路径派生，格式沿用 M1 的 `<前缀>_<body>`（M1Interface 第 3.1 节），body 为路径 SHA-256 的前 32 位小写十六进制。可读路径作为单独的 `path` 字段写入日志并用于界面展示。重放日志得到相同的路径，因此得到相同的 ID。
- 节点路径为 `<workflowRunId>/<revision>/<名称>#<迭代号>`（不在循环中的节点迭代号为 1），节点 ID 前缀为 `nod`。模型给的名称只在一次调用内唯一；路径由 Workflow 生成，所以模型在不同调用中重复使用同一个名称也不会冲突。
- UnitRun 路径为 `<agentRunId>/round-<n>/<序号>`，ID 前缀为 `unr`。每次提交的路径为 `<UnitRun 路径>#<提交次数>`，`requestId` 由它派生（前缀 `req`）：同一个提交因通信重传而重复到达时，Kernel 按 `requestId` 去重；暂停后重新提交被取消的 READ（第 4.4 节）是新的一次提交，提交次数加一。
  打开 Session 时遗留的 Unit 记为 `INTERRUPTED`，不会重新提交（第 10.3 节）。

**循环展开**：每个 Revision 都是无环图，循环不在图中真的成环，而是逐次展开。
- 循环边从源节点 S 回到它的祖先 T，带可选的条件与 `maxIterations`。从 T 到 S 的所有路径上的节点构成循环体。
- S 的第 k 次迭代以 SUCCEEDED 结束、条件成立且 k < `maxIterations` 时，Workflow 在计算就绪集合之前追加一个 Revision：把循环体复制为第 k+1 次迭代，
  T#k+1 依赖 S#k，并以 S#k 的结果为输入（例如审阅意见）。
- 条件成立但已达到 `maxIterations` 时不再展开，追加 `LOOP_EXHAUSTED`，这条循环边视为未被选中。
- 循环体之外的节点对循环体内节点的依赖，只按**最后一次迭代**判定：某次迭代之后会继续展开时，下游节点不会因为这次迭代的条件边未被选中而被跳过。
  展开与否在 S#k 结束的同一次事件处理中确定，所以"最后一次迭代"同样是日志的纯函数。
- 校验规则：T 必须是 S 的祖先；循环体不含 `HUMAN(prompt)`；M2 不支持嵌套或相互交叠的循环；`maxIterations` ≤ `maxLoopIterations`（缺省 3）。

### 3.3 推进规则

推进是日志投影的纯函数：

```text
edgeState(e, status, results) =                       // 只看前驱的最后一次迭代（第 3.2 节）
  前驱未结束                                  → WAITING
  前驱 SUCCEEDED 且（无条件或谓词成立）        → TAKEN
  前驱 SUCCEEDED 且谓词不成立                  → NOT_TAKEN
  前驱 SKIPPED(NOT_TAKEN)                     → NOT_TAKEN
  前驱 FAILED、INTERRUPTED、SKIPPED(DEPENDENCY_FAILED) → FAILED

readyNodes = { n | status(n) = PENDING 且
                   trigger(n) = all_success：全部入边为 TAKEN
                   trigger(n) = all_done：  没有入边为 WAITING }
skippedNodes = { n | status(n) = PENDING 且 trigger(n) = all_success 且没有入边为 WAITING 且有入边不为 TAKEN }
  原因：有入边为 FAILED → DEPENDENCY_FAILED；否则 → NOT_TAKEN
```

Workflow 处理每条 Inbox 事件的顺序固定为：

1. 追加日志；
2. 更新投影；
3. 需要循环展开或 `chat` 生长时，追加 `GRAPH_EXTENDED`；
4. 把 `skippedNodes` 按原因记为 `SKIPPED`，重复直到不再变化（跳过会向下游传递）；
5. 对 `readyNodes` 中的每个节点追加 `NODE_STARTED`，再启动它：AGENT 节点登记 AgentRun，HUMAN 节点发起人类请求。

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
5. **业务熔断**（Workflow 计数与判断，Kernel 不解释）：
   - 重复意图：同一 AgentRun 最近 20 个 UnitIntent 中，输入哈希完全相同的出现 3 次时，Workflow 在结果中附加警告；出现 5 次时不再提交，以 FEEDBACK 说明，并进入收尾（`REPEATED_INTENT`）；
   - 连续出错：连续 5 个工具 Unit 以 REJECTED 或 FAILED 结束时进入收尾（`CONSECUTIVE_ERRORS`）。命令的非零退出码不算出错。
   两者都走第 7.3 节的统一收尾路径。

### 3.5 控制工具

控制工具由 Workflow 解释，不是 Unit，不进入 Kernel。

| 控制工具 | 谁可用 | 效果 |
|---|---|---|
| `reply` | main | 以文字结果完成本节点，结束该 AgentRun。是否把结果发布给用户（内建 Unit `message-publish`）、之后追加什么节点，由模板决定：`chat` 模板发布回复并追加下一个 `HUMAN(prompt)`；其他模板只发布 `output: true` 节点的结果 |
| `run_subagents` | 能力上限中含 `agent.spawn` 的 AgentRun（M2 中只有顶层的 main） | 扩展 TaskGraph（第 3.6 节）；调用方进入"等待子任务"，所有子任务结束后，它收到汇合结果作为这次调用的工具结果 |
| `finish_subagent` | explorer、worker | 以结构化结果结束本 AgentRun（第 3.7 节） |
| `ask_user` | main、worker（explorer 不可用） | 在 TaskGraph 上追加一个附属于调用方的 `HUMAN(ask / confirm / review)` 节点：向用户提问、请用户确认，或向用户展示一个产物并请求审阅；答复作为这次调用的工具结果 |
| `update_todos` | main、worker | 以完整列表替换该 AgentRun 的待办（见下文）；不改变任务图，不结束 AgentRun |
| `finish`、`handoff-to-code-viewer` | M1 的 planner、code-viewer | 只在 `analyze` 模板中使用，语义见第 3.8 节 |

`ask_user` 与 `run_subagents`、`handoff` 一样，是 Agent 主动改变任务图的控制工具：
它只阻塞调用它的 AgentRun，其他 AgentRun 照常推进。参数为种类、问题文本、可选的结构化字段（字段类型只有文本、多行文本、单选、多选、确认五种，
其他类型降级为文本）与 `review` 时要展示的 ArtifactRef。

**M2 不提供单独申请授权的控制工具。** 授权只在 Agent 调用一个具体工具、由 Kernel 准入判定时发生；`ask_user` 的答复也不能产生授权（第 5.5 节）。

**`update_todos`**（参考 OpenCode 的 `todowrite`）：长任务中让 Agent 维护结构化的待办，减少遗忘步骤。
- 参数为 `todos: { content: string; status: 'pending' | 'in_progress' | 'done' | 'cancelled' }[]`（≤30 项，每项 ≤200 字符，`in_progress` 至多一项），每次以完整列表替换；
- Workflow 校验后追加 `TODOS_UPDATED`（只引用模型输出中的这次调用，不复制正文），工具结果为一行计数（"待办 7 项：完成 3、进行中 1"）；参数不合法时以 FEEDBACK 退回；
- 它是唯一可以与普通工具、结束控制工具在同一次返回中出现的控制工具（`CONTROL_MIXED` 的例外），Workflow 先处理它；不提交 Unit，不计入工具次数；只调用它的一轮计入无进展检测；
- 进度经 `updateActivity` 交给 Kernel，Kernel 只把它原样放进 ActivityEvent（与 `display` 相同，不据此做任何判断），活动区显示"3/7 · <进行中的一项>"；
- 待办不跨 AgentRun 继承：main 在下一个 Turn 中从投影里的历次调用看到之前的列表。

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
| 累计任务数 ≤ `maxTasks`（缺省 12）；`run_subagents` 调用次数 ≤ `maxSpawnCalls`（缺省 4）。都按 Turn 计（Orchestration 运行整体是一个 Turn） | `SPAWN_LIMIT` |
| 各任务的 `budget.tokens` 之和 ≤ 调用方当前可委派的额度（由 Kernel 的 `reserveDelegation` 判定，第 7.3 节） | `BUDGET_INSUFFICIENT`（写明可委派的余额与各任务的份额） |

调用方连续 2 次校验失败，或触及 `SPAWN_LIMIT` 时，Workflow 从它之后的工具列表中收回 `run_subagents`，并以 FEEDBACK 告知它自行完成。

**执行语义**

- `budget.tokens` 缺省为该 Agent 的缺省份额，被限制在 `[该 Agent 的最小份额, 缺省份额的 2 倍]` 之间（第 7.3 节），超出的值按边界截取，并在汇合结果中注明。
- 校验通过时，Kernel 一次性从调用方的账本中划出全部任务的份额，作为委派保留（全有或全无，第 7.3 节）；之后不会因额度不足而只派生一部分。
- 任务在就绪时才登记 AgentRun，由 Kernel 计算并校验它的能力上限，并把委派保留中属于它的份额转为它自己的账本。登记被拒的任务记为 `FAILED`，原因码随之记录，依赖它的任务记为 `SKIPPED`，它们的份额返还调用方。
- 调用方在等待期间没有在途 Unit，它的墙钟上限暂停计时。
- 汇合结果按调用参数中任务的书写顺序排列，不按完成顺序，以保证上下文可以复现、前缀缓存可以命中。未满足的验收条目、失败与跳过的任务排在每项的最前面。
- 同一 Turn 内可以多次调用 `run_subagents`（分批派生）：先调研，再按结果派生修改任务。

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
    loop:                   # 审阅不通过时回到 plan 重写，最多 3 次
      to: plan
      when: { field: verdict, equals: reject }
      maxIterations: 3
  - name: report
    kind: AGENT
    agent: main
    goal: "根据审阅意见写出最终报告"
    dependsOn: [review]     # 只按 review 的最后一次迭代判定
    output: true            # 该节点的回复作为运行结果发布
```

依赖可以写成节点名称，也可以写成条件边 `{ node: review, when: { field: verdict, in: [approve] } }`；节点可以设置 `trigger: all_done`（第 3.1 节）。

- **模板位置**：内置模板在 AgentToolPool 中，使用者模板在仓库的 `.multiagentos/workflows/` 下。使用者模板经 `readProjectFile` 读取（第 7.5 节），模板内容属于仓库材料。
- **模板不携带权限**：能力上限、派生能力与授权条目都由 Kernel 依据 Agent 定义与人类的回答维护（第 5 节）。模板中的 `writeScope`、`budget`、`effort` 只是请求，登记 AgentRun 时由 Kernel 校验并只能收窄；模板不能给节点增加能力，也不能开启或关闭派生。
- **HUMAN 节点**：`mas run` 给出的目标记为图的根节点 `HUMAN(prompt)`，模板中的节点都直接或间接依赖它。模板可以预设任意多个 HUMAN 节点，种类为 `ask`、`confirm`、`review`，可以串联、可以出现在并行分支上。
  `prompt` 不能由模板预设：它表示用户主动发起的开放输入，要求全图静止，并会结束当前 Turn（第 2.1 节）。模板中间的询问可能与其他分支同时进行，不满足这个条件；整个 Orchestration 运行是一个 Turn。
- **字段**：节点只能引用内置 Agent；可以设置 `goal`、`writeScope`、`effort`、`budget`、`output`、`trigger`、`loop`；前一节点的结果自动作为后一节点的输入。
- **并行的可写节点**：可能同时运行（彼此之间没有依赖路径）的两个可写节点（引用 main 或 worker）都必须写明 `writeScope`，且两者不相交；否则编译报 `WRITE_SCOPE_REQUIRED` 或 `WRITE_SCOPE_OVERLAP`。
  没有并行可写节点的模板可以省略 `writeScope`，此时 main 节点的可写根目录为仓库根目录。Kernel 在登记时还会按第 6.4 节的写入占用规则再检查一次。
- **两类模板**：普通模板是一张有限的图，编译一次得到初始 Revision，之后只有循环展开与 `run_subagents` 会追加 Revision；`chat` 是一条生长规则：初始图为 `HUMAN(prompt) → main`，每当 main 结束（不论成败），发布它的回复（如有）并追加 `HUMAN(prompt, requested, trigger: all_done) → main`。这条规则写在内置代码中，不用 YAML 表达。
- **内置模板**：
  - `chat`：Turn-chat；
  - `analyze`：M1 的只读分析，planner → code-viewer。planner 可能交接，也可能直接以 `finish` 交出报告，因此交接在图上表达为一条条件边（`when: { field: action, equals: HANDOFF }`）：交接时 code-viewer 就绪，交接内容（`HandoffBrief`）作为它的输入；直接结束时 code-viewer 记为 `SKIPPED(NOT_TAKEN)`，planner 的报告即运行结果。M1 的 Agent 与 Prompt 定义原样使用；
  - `research`：上例，用于与 Turn-chat 对比的验收。
- **运行方式**：`mas run <模板> "<目标>"` 新建一个 Session 并开启一个 Orchestration WorkflowRun（第 2.3 节）；在 Turn-chat 中使用 `/run <模板> <目标>`，在当前 WorkflowRun 中以模板实例作为本 Turn 的主体。

### 3.9 内置 Agent

| Agent | 能力 | 思考强度 | 派生（`agent.spawn`） | 结束工具 | 缺省上限（Round / 工具 Unit / 墙钟） |
|---|---|---|---|---|---|
| `main` | 读、列目录、检索、只读 git、写、编辑、命令（可以联网，每次询问）、网页检索与读取 | `high`（允许 `none`–`max`） | 有（仅顶层 AgentRun） | `reply` | 40 / 200 / Turn 超时 |
| `explorer` | 读、列目录、检索、只读 git、网页检索与读取 | `none`（允许 `none`、`low`） | 无 | `finish_subagent` | 20 / 60 / 10 分钟 |
| `worker` | 读、列目录、检索、只读 git、在 `writeScope` 内写与编辑、命令（不联网） | `high`（允许 `low`–`max`） | 无 | `finish_subagent` | 30 / 120 / 20 分钟 |
| `planner`、`code-viewer` | M1 原样 | 关闭 | 无 | M1 原样 | M1 原样 |

能力列表就是 Agent 定义中的能力白名单，是能力上限的来源；没有列出的一律不可用，调用时直接拒绝、不询问（第 5.1、5.3 节）。
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

| | 业务输入（HUMAN 节点） | 授权（授权条目的签发） |
|---|---|---|
| 层次 | Workflow，TaskGraph 上的节点 | Kernel.Core，不在 TaskGraph 上 |
| 内容 | 提示词、补充说明、问题的回答、确认、审阅意见：改变 Agent **要做什么** | 是否允许某个能力作用于某个资源：决定 Agent **能做什么** |
| 谁发起 | 用户主动输入；模板预设；Agent 调用 `ask_user` | **只由 Kernel 发起**：Agent 调用工具，Core 判定能力在上限之内、但没有覆盖的授权条目时，才向用户询问（第 5.3 节） |
| Agent 能否主动发起 | 能（`ask_user`） | 不能单独发起。Agent 调用具体工具（参数中带上该操作需要的资源，如 URL、命令、`network: true`），由 Kernel 判定后决定是否询问 |
| 用户的回答成为什么 | HUMAN 节点的结果，进入模型上下文 | 授权条目，只在 Core 内存中，不进入模型上下文 |
| 记录 | Workflow 日志：`HUMAN_REQUESTED`、`HUMAN_ANSWERED` | Kernel 审计；Workflow 日志中只有 `AUTHORIZATION_REQUESTED`、`AUTHORIZATION_DECIDED` 两种审计用记录，它们不是 HUMAN 节点 |
| 阻塞范围 | 依赖它的节点，或提问的 AgentRun | 等待该授权的 UnitAttempt（相同的询问合并时为多个，第 5.3 节） |
| 通道 | `requestHuman` → `HumanRequest` → `answerHuman` | `AuthorizationRequest` → `answerAuthorization`（M1 机制扩展） |

两个层次互不转换：
- HUMAN 节点的答复不产生授权条目。例如用户在 `ask_user` 中回答"可以运行命令"，并不构成授权；
- 授权的结果也不成为 HUMAN 节点。

界面上两类请求按到达顺序排在同一个队列中，但以不同样式显示，每一项都标明来自哪个任务、哪个 Agent。

此外还有第三类操作：暂停、继续、中止、回退、差异查看。它们是用户直接对运行发出的控制操作（ControlOperation，第 4.3、4.6 节），
既不是业务输入，也不是授权。运行中插入的说明与继续时附加的说明是业务输入，记为 `HUMAN(steer)`（第 4.5 节）。

### 4.2 HUMAN 节点

| 种类 | 由谁产生 | 何时创建 | 关系 | 完成 |
|---|---|---|---|---|
| `prompt` | 用户主动输入：Turn-chat 的第一条提示词与之后的每条消息、`mas run` 的目标、`/run` 的目标 | 两种来源（`origin`）：<br>- `initial`：只用于 Session 的第一条消息（新建或 Fork）与 `mas run` 的目标，节点创建时已带有内容；<br>- `requested`：此后运行中的 `prompt` 一律是请求式，main 结束（不论成败）后 Workflow 先创建节点并发出请求，系统进入 AWAITING_INPUT，用户输入后完成 | 下游的 main AgentRun 或模板实例依赖它 | 收到用户输入；Kernel 随即开启新的 Turn（第 2.3 节） |
| `steer` | 用户在运行中插入的说明，或暂停后附加的说明 | 运行中 `/steer <说明>`（或 Alt+Enter 发送），或暂停后 `/continue <说明>` 时创建，创建时已带有内容 | 附属于目标 AgentRun | 创建即完成；内容出现在目标下一次组装的上下文末尾 |
| `ask`、`confirm`、`review` | 模板预设，或 Agent 调用 `ask_user` | 模板节点在就绪时请求；`ask_user` 在调用时请求 | 模板节点：后继依赖它；`ask_user`：附属于调用方 | 收到符合 `answerSchema` 的答复，或超时 |

| 字段 | 内容 |
|---|---|
| `request` | 问题文本、结构化字段、要审阅的 ArtifactRef（`prompt` 与 `steer` 没有） |
| `answerSchema` | 由种类与字段决定；Workflow 校验答复后才把节点标为 SUCCEEDED |
| `content` | 用户输入的正文：UserInteraction 交给 Kernel，由 Execution 存入 ArtifactStore，引用随 `HumanAnswered` 交给 Workflow；节点只记录引用 |
| 超时 | `prompt` 不超时（空闲等待）；`ask`、`confirm`、`review` 在 `humanRequestTimeoutMs`（缺省 10 分钟）后以 `{ timedOut: true }` 作为答复，提问方据此继续 |

- Kernel 只区分两类请求：`prompt` 是开放输入，要求静止并界定 Turn；`ask`、`confirm`、`review` 是局部询问（第 2.1 节）。
- `initial` 与 `requested` 的区分只适用于 `prompt`。`steer` 由用户主动发起，系统并没有在等它，所以始终在创建时带入内容、创建即完成，不经过请求。
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
RUNNING / PAUSING ──Turn 超时───────────────────▶ INTERRUPTING        （第 7.4 节）
INTERRUPTING   ──Workflow 请求 HUMAN(prompt)，在途 = 0──▶ AWAITING_INPUT   （Turn-chat；本 Turn 以 ABORTED 结束）
INTERRUPTING   ──Workflow closeRun(CANCELLED | TIMEOUT)──▶ CONVERGING      （Orchestration）
RUNNING        ──Workflow 请求 HUMAN(prompt)，在途 = 0──▶ AWAITING_INPUT   （本 Turn 以 COMPLETED 结束）
AWAITING_INPUT ──answerHuman(prompt)───────────▶ RUNNING             （Kernel 开启新的 Turn）
AWAITING_INPUT ──/undo、/diff───────────────────▶ AWAITING_INPUT
任意非终态      ──用户指令、安全停止、shutdown、Workflow closeRun──▶ CONVERGING ──▶ CLOSED   （额度与超时不会直接触发）
任意状态        ──STOP_UNCONFIRMED─────────────▶ 系统停机（第 4.7 节）
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
| EXEC | 以 `cancelExecution` 取消（第 7.6 节），等待 Supervisor 确认进程组已退出（停止的升级顺序见第 4.7 节） | `INTERRUPTED(PAUSED)` | **不自动重跑**；给模型的工具结果写明"命令被暂停打断，可能未完成"，由模型决定是否重跑 |
| 已排队、尚未派发 | 保留在队列中 | 不交付 | 依次派发 |
| 等待授权 | 询问保留 | — | 照常 |

`INTERRUPTED` 是 M2 新增的 UnitReport 状态，与 OK、REJECTED、FAILED 并列。日志中只有"完整完成"或"明确中断"两种记录，
不写半截的记录；被打断的模型输出作为失败的尝试记录，不进入模型历史。

### 4.5 继续、附加说明与中止

| 操作 | 语义 |
|---|---|
| 运行中插话 `/steer [@任务名] <说明>`，或 Alt+Enter 发送输入框中的消息 | 不暂停、不打断当前工作（参考 OpenCode 的 `delivery: steer` 与 DeepSeek Harness 的 `steer`）。Kernel 存储正文后交给 Workflow，Workflow 创建附属于目标 AgentRun 的 `HUMAN(steer)` 节点，说明在目标下一次组装上下文时出现在末尾，也就是当前这一轮的工具全部结束之后：<br>- 只在 RUNNING 时受理，不开启新的 Turn；目标的规则与下一行相同；<br>- 送达时目标已经结束：目标是 SubAgent 时改为附属于它的父 AgentRun，并注明原定的目标；目标是 main 而本 Turn 已在收尾时，说明在下一个 Turn 的历史中出现（main 的投影跨 Turn），界面提示这一点 |
| 排队 | RUNNING 时在输入框中按 Enter 的消息缺省进入排队，由 UserInteraction 保存在界面中（界面偏好，与草稿同类，不是 Session 信息）：<br>- 运行进入 AWAITING_INPUT 并收到 `HumanRequest(prompt)` 时，界面把排队的第一条作为开放输入提交，开启新的 Turn；其余的依次等待之后的 AWAITING_INPUT；<br>- 排队的消息在提交前可以编辑或撤回；中止、运行因额度结束、切换或关闭 Session 时不自动提交，放回输入框；<br>- Kernel 与 Workflow 不知道排队的存在 |
| 继续 `/continue` | PAUSED → RUNNING；按第 4.4 节重新提交 |
| 继续并附加说明 `/continue <说明>`，或暂停时直接输入的普通消息 | 同上。Workflow 先在 TaskGraph 上创建一个附属于目标 AgentRun 的 `HUMAN(steer)` 节点，记录说明，再恢复推进：<br>- 继续本身是控制操作，附加的说明是业务输入；<br>- `steer` 不开启新的 Turn；<br>- 目标缺省为本 Turn 的 main，可用 `/continue @<任务名> <说明>` 指定；<br>- 说明在目标下一次组装上下文时出现在末尾；<br>- 目标正在等待子任务时，说明在汇合之后可见，界面会提示这一点；<br>- 没有 main 且没有指定目标时，界面要求选择 |
| 中止（暂停后再按一次 Ctrl+C） | 进入 INTERRUPTING：<br>- 取消全部在途与排队的 UnitAttempt（`INTERRUPTED(ABORTED)`）；<br>- 取消待答复的授权询问与人类请求：Kernel 向 Workflow 发出 `HumanCancelled { nodeId, reason }`，界面收到 `HumanResolved(cancelled)`；<br>- Workflow 把运行中的节点（包括被取消的 HUMAN 节点）记为 INTERRUPTED，结束全部 AgentRun；<br>- Turn-chat：请求下一个 `HUMAN(prompt)`，Kernel 以 `ABORTED` 结束本 Turn；<br>- Orchestration：`closeRun(CANCELLED)`，Turn 随运行收敛结束 |

中止不是回滚：已完成的 Unit 结果、已提交的输入都保留在日志中，文件改动保留在工作区，需要撤销时使用 `/undo`。

### 4.6 回退与差异

工作区快照由 Kernel.Execution 管理，以独立 `GIT_DIR` 的影子 git 仓库保存在 Session 目录中，不要求被分析仓库本身是 git 仓库。
快照在每个 Turn 开始与结束时拍摄，这两个时刻都是静止点（第 2.1 节）。Orchestration 运行整体是一个 Turn，所以它在运行开始与收敛时各有一个快照，运行中不拍摄。

快照范围是仓库内除 M1 默认排除规则之外的文件，单个超过 2 MiB 的未跟踪文件跳过。影子 git 设置 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`，不读取用户与系统的 git 配置。
每个 Turn 开启时，Kernel 把 `turnId`、Turn 序号与开始快照写入自己命名空间中的快照索引（`kernel-execution/snapshot-index.jsonl`）；结束时追加结束快照，以及两者之间改动过的文件列表（新增、修改、删除）。
因进程退出或停机而没有正常结束的 Turn，在索引中只有开始快照。
回退时再追加一项，标明哪些 Turn 已被回退。`/undo`、`/diff` 只依据这份索引定位快照；进程重启后照样可用，Kernel 不需要读取 Workflow 的日志。

**回退只还原被回退的 Turn 改动过的文件**，其他文件一律不动（与 OpenCode 的 `SessionRevert.plan` 相同）。
因此一个 Session 执行 `/undo`，对其他 Session 与用户手动的修改来说，和进行一轮新的 Turn 是同一种行为：只改动自己改过的文件。

| 指令 | 条件 | 效果 |
|---|---|---|
| `/diff [N]` | 任意时刻 | 展示倒数第 N 个尚未被回退的 Turn（缺省 1）开始快照与结束快照之间的差异 |
| `/undo` | 仅 AWAITING_INPUT | 回退最近一个尚未被回退的 Turn。可以连续执行，每次再往前回退一个 Turn |
| `/undo all` | 仅 AWAITING_INPUT | 回退本 Session 中全部尚未被回退的 Turn。Fork 出的 Session 只回退它自己的 Turn，即回到 Fork 时的状态 |

不提供回到任意更早 Turn 的 `/undo N`，也不提供 redo。

**回退的步骤**（Kernel.Execution 执行，Core 发起与确认）：
1. **确定范围**：取被回退的各 Turn 改动过的文件的并集。每个文件的目标是"本次被回退的 Turn 中第一个改它的 Turn"的开始快照；文件在目标快照中不存在，就删除它。
2. **静态检查**：对范围内的每个文件，比较当前内容（包括是否存在）与"本 Session 中最后改它的那个 Turn"的结束快照：
   - 全部一致：没有外部修改，直接回退，不询问；
   - 有不一致：这些文件在之后被其他 Session、用户手动或外部程序改过，进入第 3 步。
3. **有外部修改时询问用户**：列出这些文件及其差异，只有两个选项：
   - **强制回退**：覆盖外部修改，范围内的全部文件照常还原；
   - **取消**：不修改任何文件。

   不提供"只回退没有冲突的文件"：部分回退会让工作区一半新、一半旧，与对话历史也对不上。
   超时或关闭界面一律按取消处理。这个询问是 ControlOperation 的确认，不是授权询问，不产生授权条目，也不是 HUMAN 节点，不进入模型上下文。
4. **兜底快照**：强制回退之前，Kernel 先对当前工作区拍一个快照，询问时告知用户"被覆盖的内容会保留在快照中"。M2 不提供 redo，但误覆盖的修改可以从影子仓库找回。
5. **写入前复查**：逐个文件写入之前再比较一次。如果文件在第 2 步之后又被改动（用户确认之后，编辑器或外部程序还在改），就停止回退，已写入的文件按兜底快照恢复，然后重新提示。
   `/undo` 只在 AWAITING_INPUT 执行，本系统没有 Agent 在运行，实例锁又排除了另一个 MultiAgentOS 进程，所以这种情况只可能来自本系统之外。
6. **记录**：Kernel 在快照索引中标记被回退的 Turn，发出 `WorkspaceReverted`；Workflow 追加 `WORKSPACE_REVERTED`（被回退的 Turn、是否强制、外部修改的文件、兜底快照的引用）。
   投影中，被回退各 Turn 的步骤替换为一条说明（"已回退：第 k 个 Turn，用户输入为……"）。日志只追加，不删除任何记录。

**没有结束快照的 Turn**（进程退出或停机导致）：它改动过的文件按"开始快照与下一个 Turn 的开始快照之间的差异"计算。
如果它就是最近一个 Turn，没有下一个 Turn，就与当前工作区比较；此时无法区分本 Turn 的改动与外部修改，范围内的全部文件都按"有外部修改"处理，进入第 3 步询问。

回退能覆盖的范围：沙盒保证命令只能写可写路径（都在仓库内），所以回退覆盖全部文件改动，被排除的文件（如 `node_modules`）除外；询问与回退结果中都注明这一点。
回退不能撤销已批准联网的命令对外部产生的效果（例如向远端推送），这一点写入 M2 的限制清单。
同样写入限制清单的还有：沙盒中读不到敏感文件，依赖 `.env` 等文件的命令（如需要密钥的集成测试）只能由用户在沙盒外自行运行。

Orchestration 运行只能整体回退，不能回到运行中间的某个节点；运行结束后在该 Session 中（`/resume`）使用。
在 Turn-chat 中用 `/run` 运行的模板属于当前 Turn，照常按 Turn 回退。

### 4.7 无法确认停止的执行

M2 中 `STOP_UNCONFIRMED` 不是处理后可以继续运行的任务异常，而是系统故障，出现即停机。
它表示 Kernel 已经下令停止某个执行，却无法确认它已经停止。此时工作区可能仍在被改动，EXEC 互斥与并发计数无法安全释放，
PAUSED、Turn 结束与快照所依赖的静止保证都不再成立，系统没有可以继续的一致状态。

**停止的升级顺序**（Supervisor）：
1. 发出中止信号：进程内的 Executor 收到 AbortSignal，子进程组收到 SIGTERM；
2. `cancelGraceMs`（缺省 5 秒）后仍未结束，对子进程组发 SIGKILL。命令在 bwrap 的独立 PID 命名空间中运行，结束命名空间中的第一个进程即结束其中全部进程；
3. 再等待 `killGraceMs`（缺省 2 秒）。仍无法确认时，才上报 `STOP_UNCONFIRMED`。

进程内的 Executor（模型调用、网页、文件工具）只能依靠中止信号，没有第 2 步，超过宽限期同样上报。

**处理**：Core 收到 `STOP_UNCONFIRMED` 后不再像 M1 那样只收敛这一个运行，而是经 `reportSystemFault` 请求组合根停机（M1 SystemFaultHandling 的 panic 流程）：
1. 封锁新的请求与执行，对全部残余执行发出中止；
2. Kernel 写审计：Unit、进程号、已知效果；
3. 界面显示"无法确认 <命令摘要> 已停止（进程 <pid>），系统已停止，请检查该进程与工作区"；
4. 进程以非零退出码退出，释放实例锁。

**之后的恢复**：停机时不保证 Workflow 写完日志。下次打开该 Session 时按第 10.3 节修复：未完成的 Unit 记为 `INTERRUPTED`（原因"上一个进程故障停机"），
没有结束快照的 Turn 记为异常结束；打开 Session 时按第 2.3 节 Session 第 6 条把与最后一个快照的差异告知用户与 main，不改动文件；需要撤销时由用户使用 `/undo`。

## 5. 授权：能力上限、授权条目与 Lease

### 5.1 能力上限与授权条目

授权依据由两样性质不同的东西组成，Core 分两步判定（第 5.3 节）：

| | 能力上限 | 授权条目 |
|---|---|---|
| 回答的问题 | 这个 AgentRun **最多可能**被允许做什么 | 人类**已经同意**了什么 |
| 内容 | 能力集合与可写根目录 | `(能力, 资源键, 有效范围, 允许 / 拒绝)`；有效范围为单次、本运行内这条命令、本运行内这个前缀、本运行内这个资源键 |
| 来源 | Agent 定义的能力白名单、父 AgentRun 的能力上限、登记时请求的可写根目录、启动预设 | 人类对授权询问的回答；WorkflowRun 开始时的仓库授权 |
| 何时确定 | AgentRun 登记时由 Kernel 计算一次，之后不变 | 运行中逐条累积 |
| 是否需要人类 | 不需要；只能收窄，不能放宽 | 只能由人类签发，M2 不设自动审批 |
| 挂在哪里 | 每个 AgentRun 一份 | 每个 WorkflowRun 一份，本运行内全部 AgentRun 共用 |
| 不满足时 | 直接拒绝，不询问 | 询问人类；人类拒绝才拒绝 |

```text
能力上限（AgentRun 登记时由 Kernel 计算）
  顶层 AgentRun：Agent 定义的能力白名单 ∩ 启动预设允许的能力；可写根目录为请求值（仓库内）
  SubAgent：     Agent 定义的能力白名单 ∩ 父 AgentRun 的能力上限；可写根目录 ⊆ 父 AgentRun 的可写根目录
授权条目（WorkflowRun 内由人类逐条签发）
Lease = Core 为一个 UnitAttempt 签发的执行许可：能力在上限之内，且有授权条目覆盖时才签发，并由它派生 ExecutionScope 与 SandboxProfile
```

- **能力上限由 Kernel 计算**：Workflow 登记 AgentRun 时提交请求的能力与可写根目录。Kernel 校验它们不超出上述上限后记录，否则以 `CAPABILITY_NOT_SUBSET` 拒绝登记。
  能力上限只能收窄，不涉及人类，因此派生 SubAgent 不会引起询问。
- **能力上限决定"有资格被询问"，不代表"已被允许"**：worker 的能力上限中有 `workspace.write`，只表示它写入时可以向人类询问；是否允许由授权条目决定。
- **授权条目对本运行内全部 AgentRun 生效**：例如 main 批准的"本运行内 `npm test` 均允许"，worker 执行同一条命令时同样适用；但只在各自的能力上限之内适用，explorer 仍然不能执行命令。
- **数据**：能力上限、授权条目与 Lease 都只在 Core 中，只在内存中，属于当前 WorkflowRun；WorkflowRun 结束时全部失效。
  `AUTHORIZATION_REQUESTED`、`AUTHORIZATION_DECIDED` 写入审计与会话日志，但不进入模型上下文，重放时也不恢复。

### 5.2 能力、级别与资源键

能力的级别写在 Kernel 的能力表中，Unit 定义只声明能力，调用者与模型不能改变级别。
同一能力作用于某些资源时级别会升高，升级规则同样写在能力表中，见下表的"极危险"各行。

| 能力 | 级别 | 资源键（从 UnitIntent 的输入中提取，规则由 Unit 定义给出） | 询问方式 |
|---|---|---|---|
| `repo.read` | 安全 | 仓库根目录 | WorkflowRun 开始时询问一次（M1 机制）；之后该 WorkflowRun 下能力上限中有它的 AgentRun 都可用 |
| `workspace.write` | 不确定 | 发起写入的 AgentRun 的可写根目录；已批准的条目覆盖其下全部路径 | 没有覆盖的条目时询问一次。main 的可写根目录是仓库根目录，批准后也覆盖全部 SubAgent 的 `writeScope`，所以每个 WorkflowRun 通常只问一次；main 尚未写过时，worker 第一次写入按它自己的 `writeScope` 询问 |
| `web.search` | 不确定 | 无（整个能力） | 每个 WorkflowRun 第一次使用时询问一次 |
| `web.fetch` | 不确定 | 域名 | 每个新域名第一次访问时询问一次；私网、回环、链路本地、云元数据地址直接拒绝（`ADDRESS_FORBIDDEN`），不提供询问 |
| `command.exec` | 危险 | 规范化后的命令（按语法树拆成子命令，并带上工作目录，见下文"命令的拆分"） | 默认每次询问 |
| `command.exec`：任一子命令命中 `kernel.criticalCommands` | 危险（沙盒可用时）；极危险（`ask-unisolated`，第 6.2 节） | 本次命令 | 每次询问，不提供两个"均允许"选项，以警示样式显示。缺省列表：`git push`、`git remote`、`npm publish`、`pnpm publish`、`yarn publish`、`cargo publish`、`docker push`、`gh`；列表可追加，不可删除缺省项。名单只是界面分类，不是安全边界（见下文） |
| `command.network` | 极危险 | 本次命令 | `run_command` 的参数 `network: true` 时需要，与 `command.exec` 一起判定，每次单独询问；只有 main 的能力白名单中有这项能力 |
| `workspace.write`：目标为仓库根目录的 `AGENTS.md` | 极危险 | 本次写入 | 每次修改单独询问；只能经 `write_file`、`edit_file`，命令无法写入（第 6.1 节） |
| `project.instructions` | 不确定 | `AGENTS.md` 内容的 SHA | 不是 Agent 的能力，由 `readProjectFile` 读到未被信任的 `AGENTS.md` 时询问，决定它能否进入 system 段（第 9.5 节）；不产生任何执行权限 |
| `agent.spawn` | 内部 | 无 | 不询问，也没有授权条目，只看能力上限。来自 Agent 定义的能力白名单；Kernel 只把它放进顶层 AgentRun（没有父 AgentRun 的）的能力上限，因此 SubAgent 不能再派生。`registerAgentRun` 带 `parentAgentRunId` 时，Kernel 检查父 AgentRun 的能力上限中有它，否则以 `CAPABILITY_NOT_GRANTED` 拒绝 |

`network: true` 和 `web_fetch` 的 URL 一样，是操作本身的参数。Kernel 从中提取需要的能力，按同一顺序判定，与其他工具的逻辑相同。

**级别的依据是后果能否撤销、影响到哪里**：
- 安全级没有副作用；
- 不确定级的副作用可以回退（文件写入），或者只泄露有限的信息（查询词、访问的域名）；
- 危险级的副作用不能完全撤销，但只作用于沙盒内的仓库（命令不联网，读不到 `$HOME` 与敏感文件，第 6.1 节）；
- 极危险级的副作用作用于仓库之外，且无法撤销（联网的命令；沙盒不可用时的推送、发布）；或者会改变以后每次运行的指令（`AGENTS.md`）。

**安全边界是网络隔离，不是命令名单**：沙盒中的命令缺省不联网，`.git/` 只读，因此推送、发布、修改远端配置在沙盒中本来就无法成功；
能把副作用送出仓库的只有获准的 `command.network`，所以它是极危险级。`criticalCommands` 按命令名匹配，可以被改写绕过
（如 `env git push`、`git -C . push`），只用来让用户在询问时注意到这类命令。沙盒不可用（`ask-unisolated`）时没有网络隔离，命中名单的命令才升为极危险级。

Architecture 中"危险行为每次都必须单独征得用户同意"在 M2 中对应极危险级；危险级允许在本 WorkflowRun 内按命令或前缀放行。Architecture 已据此修改（第 14.1 节）。

**危险级的询问选项**：
- 单次允许；
- 本 WorkflowRun 内这条命令均允许；
- 本 WorkflowRun 内这个命令前缀均允许；
- 拒绝。

**命令的拆分**（参考 OpenCode 的 `shell/parse.ts`）：
- 以 tree-sitter 的 bash 语法（WebAssembly 版本，不需要原生编译）解析命令，从语法树中取出每条简单命令（`&&`、`||`、`;`、`|`、换行、子 shell、`{ }` 中的都算），
  得到命令名与参数；引号、转义与变量赋值前缀按语法树处理，不按文字拆分。资源键、名单匹配与询问展示都以这些子命令为准；
- 前缀按表驱动的 ARITY 表计算：表中写明每个命令取前几个词作为前缀（如 `git push`、`npm run` 取两个词，`docker compose up`、`cargo run` 这类按表取三个词），
  表中没有的命令取第一个词；表写在 ExecutorSet 的 `command/parse/` 中，可以追加；
- **解析失败一律按最严格处理**：语法树中有错误节点、命令名不是字面量（如来自变量或命令替换），或拆分本身出错时，不提供两个"均允许"选项，只能单次允许或拒绝；
  名单匹配照常进行（按原始文字再匹配一次，取两者的并集），不会因解析失败而漏掉禁止规则；
- 以下情况同样不提供两个"均允许"选项：语法树中含命令替换（`$(…)`、反引号）、进程替换、`eval`、`sh -c` 或 `bash -c`、通往 `sh` 或 `bash` 的管道、heredoc 作为 shell 的输入；沙盒不可用；
  命中 `deniedCommands` 或 `criticalCommands`。

**极危险级的询问选项**：只有单次允许与拒绝。不提供任何"均允许"，批准不继承、不复用，每个 UnitAttempt 单独询问；询问界面以警示样式显示。

**不确定级的询问选项**：允许（本 WorkflowRun 内对这个资源键有效）、拒绝（本 WorkflowRun 内对这个资源键保持拒绝）。

每个选项都形成一条授权条目（第 5.1 节）；"单次允许"的条目在该 UnitAttempt 结束时作废。

**启动预设**（CLI 参数），作用于顶层 AgentRun 的能力上限：
- `standard`（缺省）：如上表；
- `readonly`：能力上限中只保留安全级能力，不确定级、危险级与极危险级的能力被移出，因此在第 5.3 节第 ② 步直接拒绝，不询问；对应的工具也不出现在工具列表中。

### 5.3 判定顺序

Core 对每个 UnitIntent 按固定顺序判定，与规则的书写顺序无关。前三步是"不询问的拒绝"，后两步才涉及人类：

```text
—— 系统策略与能力上限：不满足即拒绝，不询问 ——
① 任一子命令或域名命中 deniedCommands / deniedDomains     → REJECTED（COMMAND_DENIED / DOMAIN_DENIED）
② 所需能力不在该 AgentRun 的能力上限中                   → REJECTED（CAPABILITY_NOT_GRANTED）
③ 写入路径不在该 AgentRun 的可写根目录内                  → REJECTED（WRITE_OUT_OF_SCOPE）
   写入路径位于 .git/ 或 .multiagentos/ 之下                → REJECTED（PROTECTED_PATH）
—— 授权条目：没有就询问，人类拒绝才拒绝 ——
④ 本 WorkflowRun 有覆盖该能力与资源键的授权条目
     允许 → 签发 Lease，派生 ExecutionScope 与 SandboxProfile
     拒绝 → REJECTED（USER_DECLINED）
     极危险级不查找已有条目，直接进入 ⑤
⑤ 没有覆盖的条目 → 发起授权询问，挂起这个 UnitAttempt（相同的询问合并，见下文）；人类的回答形成授权条目后回到 ④
```

**为什么前三步不询问**：
- 第 ① 步是用户或系统事先定下的禁止规则；
- 第 ② 步的能力上限来自可信定义（Architecture Overall 第 5、6 节："受保护能力由可信定义确定""静态能力存在不代表任意调用者可以执行它"），M1 同样以 `FORBIDDEN` 直接拒绝定义之外的 Unit。
  允许越过上限去询问，会让 Agent 定义失去约束力：被注入的 explorer 可以不断发起询问，诱导用户批准；
- 第 ③ 步的可写根目录是并行安全的前提（运行中的 AgentRun 写入占用两两不相交，第 3.6、6.4 节），不是人类可以放行的授权问题：用户批准 worker 写到别人的范围，等于破坏不相交的保证；
- 正常情况下前三步都不会触发：越过上限的工具不出现在工具列表中（第 5.4 节），触发时多半是模型编造了工具或受到注入，应当拒绝并反馈给模型。

- **出错即拒绝**：判定过程本身出错（能力名未知、AgentRun 未登记、规范化失败、沙盒探测超时），一律按拒绝处理，原因码为 `ADMISSION_CHECK_FAILED`。
- **相同的询问只问一次**：同一 WorkflowRun 中已有一个待答复的询问时，之后需要同一能力、同一资源键的 UnitAttempt（例如两个 worker 都要执行 `npm test`）挂在这个询问上，等待同一个答复，不再重复询问（Architecture Kernel 第 5 节，M1 Core 第 4 节的做法）。
  答复为允许时，按答复的有效范围依次签发；单次允许只覆盖最先挂起的那一个 UnitAttempt，其余的重新判定并询问。极危险级不合并，每个 UnitAttempt 单独询问。
- **询问失败即拒绝**：询问无法送达或超时（`authorizationTimeoutMs`，缺省 5 分钟），只拒绝本次（包括挂在这个询问上的全部 UnitAttempt），不形成持久的拒绝；之后同样的操作会重新询问。
  用户明确选择"拒绝"时，按不确定级与危险级的选项在本 WorkflowRun 内保留（第 5.2 节）。这一点修改了 Architecture 与 M1"超时在本次运行内保留"的规则，见第 14.1 节。
- **批准绑定确切内容**：危险级询问展示的内容（命令、工作目录、SandboxProfile）参与计算 `approvalDigest`。
  Supervisor 启动进程前用实际要执行的内容重新计算，不一致时返回 `APPROVAL_MISMATCH`。启动前还要复查：
  - 工作目录仍然存在，realpath 后仍在仓库内；
  - 可写根目录仍然不是符号链接；
  - 黑名单再匹配一次。

### 5.4 SubAgent 的隔离

SubAgent 的隔离由以下五层共同保证，缺一不可：

1. **能力白名单**：Agent 定义列出它可以使用的能力（第 3.9 节），是能力上限的来源。
2. **组装时筛选工具**：Workflow 只把能力上限中有对应能力的工具放进它的工具列表。例如 explorer 看不到 `run_command`。这一层减少无效调用与攻击面，但不是安全边界。
3. **准入时检查**：Kernel 按第 5.3 节判定，只认该 AgentRun 自己的能力上限。这一层是安全边界。
4. **可写范围**：worker 的可写根目录就是它的 `writeScope`；进程内写入检查与沙盒的 `--bind` 参数由同一个函数 `writableRoots(profile)` 计算。
5. **沙盒**：命令即使试图写到范围之外，也会被操作系统拒绝（第 6 节）。

### 5.5 授权只能由 Kernel 被动发起

1. **授权询问的唯一来源**是第 5.3 节的第 ⑤ 步：Agent 调用工具 → Workflow 提交 UnitIntent → Core 判定能力在上限之内、但没有覆盖的授权条目 → Core 向用户询问。
   询问的内容由 Core 依据 UnitIntent 生成，展示实际要执行的内容，不展示模型写的理由。
2. **授权总是绑定一个具体操作**：Agent 调用工具时，在参数中写明操作及其需要的资源（URL、命令、写入路径、`network: true`），Kernel 从中提取能力与资源键并判定。
   - M2 没有不对应任何操作、只用来申请权限的工具（例如"请给我命令权限"）；
   - 工具参数只描述本次操作，不能改变能力上限：能力白名单与 `writeScope` 只由 Agent 定义与派生决定；
   - Agent 在 `ask_user` 中提到权限，或用户在答复中表示同意，都不产生授权条目。
3. **SubAgent 要更大范围时**，只能在 `finish_subagent` 中写明（`blockers`），由父 Agent 重新派生，新的派生仍然只能落在父 AgentRun 的能力上限之内。
4. **预留扩展点**：Kernel 的授权询问接受一个可选的"申请来源"字段，M2 中它恒为 `KERNEL_ADMISSION`。
   以后若增加脱离操作的权限申请（如 `request_permission` 工具，事先为一组操作申请授权），作为新的来源接入同一个询问流程与判定顺序，不另开通道。

## 6. 沙盒

### 6.1 SandboxProfile

Core 在签发 EXEC 的 ExecutionScope 时计算 SandboxProfile，Supervisor 用 bubblewrap 施加。模型、Workflow 与配置都不能选择或放宽它。

| 项 | 内容 |
|---|---|
| 根文件系统 | `--ro-bind / /`（系统目录只读可见，命令能使用宿主的编译器与运行时） |
| 用户目录 | `$HOME` 整体以空 tmpfs 遮蔽，再把白名单中的工具链与包缓存目录（如 `~/.nvm`、`~/.volta`、`~/.cargo`、`~/.rustup`、`~/.local/bin`、`~/.npm`）以只读挂回；白名单可追加。挂回的目录中的凭据文件（如 `~/.cargo/credentials.toml`、`~/.npmrc`）仍以空文件遮蔽，列表可追加、不可删除 |
| 仓库 | 仓库根目录以只读挂回（仓库通常位于 `$HOME` 之内，挂载顺序在遮蔽之后） |
| 可写路径 | 该 AgentRun 的可写根目录（main 为仓库根目录，worker 为 `writeScope`）以 `--bind` 挂载；私有 `/tmp`（`--tmpfs /tmp`） |
| 敏感文件 | M1 默认排除规则中的秘密类规则（`.env*`、`*.pem`、`*.key`、`id_rsa*` 等私钥，不含 `.git` 与 `node_modules`）加上 `kernel.sandboxMaskedPatterns`（可追加）命中的仓库文件，以 `/dev/null` 只读覆盖，目录以空 tmpfs 覆盖。列表由 Execution 在派发 EXEC 前按同一个匹配器扫描得出，复用第 7.1 节的摘要缓存。这样文件工具与命令对秘密的可见性一致，命令输出不会把它们带进模型上下文 |
| 只读保护 | 仓库内已存在的 `.git/`（任何位置）、`.multiagentos/`、根目录的 `AGENTS.md`，即使位于可写路径之内，也以 `--ro-bind` 重新挂载为只读 |
| 新建保护 | 不存在的受保护路径不做占位挂载（bwrap 会在宿主仓库中真实创建挂载点，改动用户的仓库）。改为事后检查：Execution 在命令前后检查这些路径是否存在（任何位置的 `.git` 由改动检测发现），命令新建了其中任一路径时，Kernel 把它移入本 Session 的隔离目录（`kernel-execution/quarantine/`），结果以 `PROTECTED_PATH_CREATED` 报告并写审计。例如在不是 git 仓库的目录中 `git init` 后写入 `.git/hooks`，这些 hook 不会留到用户以后使用 git 时执行 |
| 遮蔽 | `<dataDir>` 位于 `$HOME` 之外时单独以空 tmpfs 遮蔽 |
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
文件工具同样不能读取敏感文件（M1 的排除规则），与第 6.1 节命令的可见性一致。

### 6.4 并行运行的安全条件

| 风险 | 机制 |
|---|---|
| 两个 AgentRun 写同一文件 | 派生与模板编译时校验 `writeScope` 不相交（第 3.6、3.8 节）；登记时由 Kernel 按下文的写入占用规则强制检查；准入时检查写入路径；沙盒只挂载各自的范围 |
| 命令之间互相干扰（端口、构建目录、锁文件） | 同一 WorkflowRun 内同一时刻至多一个 EXEC（`kernel.maxConcurrentExec = 1`） |
| 同一 AgentRun 对同一文件的并发编辑 | WRITE 是屏障（第 7.1 节）；Executor 内再按规范化路径加锁；`FILE_CHANGED` 的 SHA 校验 |
| 读取之后文件被并行任务或命令改动 | 校验 `edit_file` 时，Workflow 查找该路径在当前上下文中最近一次仍然可见的读取结果：找不到就以 FEEDBACK 要求先读取，不提交；找到就把它的 SHA 作为 `baseSha` 填入 UnitIntent（由 Workflow 填写，模型不能提供）。Executor 只比较磁盘内容的 SHA 与 `baseSha`，不一致返回 `FILE_CHANGED` |
| 新建文件时被并行任务抢先创建 | Workflow 为新建填入 `expectAbsent: true`；写入时文件已存在则返回 `FILE_CHANGED`，不覆盖 |
| 读取的文件正被别的 AgentRun 写入 | 不禁止（读取共享代码是写代码的常态）。读取路径落在另一个 AgentRun 的写入占用之内时，工具结果注明"此文件正被任务 X 修改，内容可能变化"，由模型决定是否等待或重新读取 |

**写入占用**：Kernel.Core 为每个能力上限中含 `workspace.write` 的 AgentRun 维护一份写入占用，即它的可写根目录。规则是：**处于运行状态的 AgentRun，写入占用两两不相交。**
- **登记时检查**：`registerAgentRun` 请求的可写根目录与任何一个处于运行状态、且不是它祖先的 AgentRun 的写入占用相交时，登记被拒（`WRITE_SCOPE_CONFLICT`），该节点记为 FAILED。
  这覆盖了模板中并行的 main 节点、它们各自派生的 SubAgent，以及同一个 main 分批派生的 SubAgent。
- **父 AgentRun 的占用在派生期间转为委派**：SubAgent 的可写根目录必然落在父 AgentRun 的范围之内。父 AgentRun 调用 `run_subagents`、Kernel 受理 `reserveDelegation` 时，
  父的写入占用转为"已委派"：它不参与相交检查，父 AgentRun 在此期间提交的 WRITE 与 EXEC 一律拒绝（`WRITE_SCOPE_DELEGATED`）。
  正常情况下父 AgentRun 在等待汇合，不会提交任何 Unit，这条拒绝只是兜底。全部子任务结束，或份额被返还后，父的占用恢复。
- **结束即释放**：AgentRun 结束（`endAgentRun`）时释放它的写入占用。
- explorer 等没有 `workspace.write` 的 AgentRun 没有写入占用，不参与检查。

### 6.5 工作区视图（为隔离副本预留）

M2 中所有 AgentRun 都直接在仓库目录中工作，并行写入靠第 6.4 节不相交的写入占用保证安全。"每个 Agent 一个隔离副本，最后合并"留到 M3，M2 只预留以下接口，使 M3 不需要改动已有的语义：
- **工作区视图**：每个 AgentRun 登记时带一个 `workspaceViewId`。沙盒的挂载源、文件工具的根目录、改动检测与快照，都通过 `workspaceRootOf(agentRun)` 取得路径，
  不直接使用仓库根目录。M2 中只有一个视图 `main`，`workspaceRootOf` 总是返回仓库根目录；
- **快照索引**：每一项带 `viewId`，M2 中恒为 `main`；
- **合并**：节点种类预留 `INTEGRATE`（第 3.1 节），Unit 预留 `workspace-merge`（第 8.1 节）。M2 中出现即以 Unsupported 拒绝。

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

**等待调用机会**：M1 中 Scheduler 申请失败立即返回、Core 把它当作内部错误收敛（M1 Scheduler 第 3 节）。M2 中多个 AgentRun 会同时申请，申请不到是正常情况：
- `requestReservation` 在调用机会已满时返回 `WAIT_CAPACITY`，不是失败；Execution 把这个 MODEL 尝试放进"等待调用机会"列表，按建立先后排列；
- Session actor 不能阻塞等待。每次处理消息的末尾，只要这次处理中有调用机会被归还，Execution 就按列表顺序为等待中的尝试重新申请，直到申请不到为止；
- 原子性不变：Core 先取得调用机会，再向 Monitor 预留额度，两者要么都持有、要么都不持有（M1 Core 5.1）。额度预留被拒仍是拒绝，不进入等待；
- 等待中的尝试不占用并发计数（第 7.1 节）；暂停时保留在列表中，中止时移出并交付 `INTERRUPTED(ABORTED)`。

### 7.3 额度

**逐级委派**：额度不是多个 Agent 共用一个账本，而是由上级预先划出份额，下级在自己的账本中记账，结束时把剩余返还上级。

```text
WorkflowRun 账本（budget.runTokenLimit）
  └─ Turn 账本：Turn 开启时从运行级账本划出，Turn 结束时剩余返还
       ├─ chat 的 main：直接使用 Turn 账本
       ├─ 模板中的 AGENT 节点：登记时从 Turn 账本划出份额
       └─ SubAgent：run_subagents 校验通过时从父 AgentRun 的账本划出委派保留，登记时转为自己的账本
```

| 层 | 缺省份额（初值） | 说明 |
|---|---|---|
| WorkflowRun | `budget.runTokenLimit` = 5,000,000 | 整个运行的总上限 |
| Turn | `budget.turnTokenLimit` = 2,000,000 | 一个 Turn（含其中全部 AgentRun）的上限；运行级余额不足时取余额 |
| AgentRun | explorer 300,000；worker 600,000；模板节点按所引用 Agent 的缺省份额 | `run_subagents` 与模板可以在 `[最小份额, 缺省份额的 2 倍]` 内调整 |

**为什么要委派**：同一个 AgentRun 内的模型调用是串行的（一轮一次 model-call），所以每个账本的在途预留最多一份。
M1 Monitor 的结论（NORMAL 状态下普通预留必然成功、收尾预留必然成功）可以原样用在每个账本上；
一个 Agent 的消耗与在途预留不会挤占另一个 Agent，并行争用不会把别人推进 WRAP_UP。

**委派规则**：
1. **可委派额度** = 上级账本的余额 − 上级自己的收尾保留 − 上级一次普通调用的余量（M1 的 `wrapUpMargin`）。因此上级在下级结束后一定还能继续并收尾。
2. **全有或全无**：`run_subagents` 校验通过时，Kernel 一次性划出全部任务的份额；超出可委派额度时整次调用不执行，以 `BUDGET_INSUFFICIENT` 告知可委派的余额（第 3.6 节）。
3. **登记时转移**：任务登记时，委派保留中属于它的份额转为它自己的账本；任务被跳过或登记被拒时，份额返还上级。
4. **结束即返还**：每个 AgentRun 结束时，账本中未使用的部分立即返还上级。未知消耗（M1 的 K）计为已用，不返还。
5. Workflow 不持有 token 数值：份额以请求的形式随 `run_subagents` 或模板传入，余额只出现在 Kernel 生成的拒绝说明中。

**每个 Agent 的额度参数**：M1 的 `perCallInputLimit`、`maxOutputTokens`、`finalInputBudget`、`finalMaxOutputTokens` 改为写在每个 Agent 定义中，SubAgent 使用更小的值。由此得到：
- 收尾保留 `F = finalInputBudget + finalMaxOutputTokens`；
- 余量 `wrapUpMargin = perCallInputLimit + maxOutputTokens`；
- 最小份额 `minShare = F + 2 × wrapUpMargin`，保证至少能做两次普通调用再收尾。

启动检查（沿用 M1 Monitor 第 4 节的方式）保证：每个 Agent 的缺省份额 ≥ 它的 `minShare`；`turnTokenLimit` 至少能容纳 main 的 `minShare`；
各项估算不超过模型的上下文窗口。上表的份额是初值，实现时按固定任务集校准。

**收尾**：每个 AgentRun 在自己的账本中保留一份 F，至多一次 final-call（M1 是每个运行一次），所以每个已登记的 AgentRun 都必然能完成收尾。

**AgentRun 级的资源上限**（归 Kernel.Monitor）：工具次数与墙钟是资源，由 Kernel 计数。任一项触顶，Monitor 拒绝该 AgentRun 后续的非收尾 Unit，并以 `QUOTA_EXHAUSTED(触顶项)` 通知 Workflow 进入收尾。

| 上限 | 说明 |
|---|---|
| `maxToolUnits` | 工具 Unit 总数 |
| `maxWallClockMs` | 从登记开始计时；暂停、等待人类、等待子任务的时间不计入 |

重复意图与连续出错是业务判断，归 Workflow（第 3.4 节），与 Round 上限一样由 Workflow 计数并决定收尾，Kernel 不解释它们（Architecture Workflow 第 3 节）。

**统一收尾路径**：所有触顶项（Kernel 报告的 token、工具次数、墙钟；Workflow 自己判断的 Round、重复意图、连续出错）都走同一条路径：
1. Workflow 只为该 AgentRun 再提交一次 final-call；
2. final-call 的上下文中写明因哪一项触顶；
3. final-call 失败时，按 M1 的降级规则结束该 AgentRun（explorer 与 worker 交回 `status: partial` 的降级结果，main 交回降级回复）。

**额度到达限制时 Kernel 只拒绝预留，不停止运行**（Architecture Kernel 第 9 节："达到硬阈值时 Monitor 拒绝新的消耗型预留，不停止运行"）。收尾与结束都由 Workflow 完成：
- 每个 AgentRun 的账本各自按 M1 的状态（NORMAL → WRAP_UP → EXHAUSTED）推进，只影响它自己。账本进入 WRAP_UP（剩余只够收尾保留加一次普通调用）时，
  Kernel 在 UnitReport 的 `BudgetView` 中告知，Workflow 让该 AgentRun **进入最后一轮**：下一次模型调用就是 final-call，不再等到预留被拒；
- Turn 账本只为 chat 的 main 记账、为下级划出份额；它进入 WRAP_UP 时，main 进入最后一轮，不能再委派；
- 运行级账本进入 WRAP_UP（余额不足以再为一个 Turn 划出 main 的最小份额）时，Kernel 只在 `BudgetView` 中告知，不收敛运行：
  - Turn-chat：当前 Turn 照常收尾、发布回复；Workflow 随后以 `closeRun(BUDGET)` 报告结束，界面提示用户确认后，Kernel 在同一 Session 中开启新的 WorkflowRun，对话照常延续，授权条目需要重新签发；
  - Orchestration：整个运行是一个 Turn，各 AgentRun 进入最后一轮，Workflow 发布运行结果后以 `closeRun(BUDGET)` 报告结束。

**额度到达限制时必有报告**：除非出现真正的系统错误（第 4.7 节的停机、Kernel 内部故障），正常的额度触顶一律留下可交付的结果：
1. 每个已登记的 AgentRun 都预留了收尾额度，必然能做一次 final-call（第 7.3 节"收尾"）；
2. final-call 结果不合法时，按 M1 的降级规则生成降级结果或降级回复，不依赖模型；
3. Orchestration 中输出节点（`output: true`）因额度未能运行时，Workflow 以确定性方式生成运行报告：列出已完成节点的结果、未完成节点及其原因、触顶项，不调用模型，经 `message-publish` 发布；
4. 回复与运行报告中都注明是因额度到达限制而结束，以及剩余未完成的工作。

**压缩的额度**（第 9.6 节）：上下文压缩的摘要调用从被压缩对象所用的账本支出——chat 的 main 为当前 Turn 的账本，模板中的 AGENT 节点与 SubAgent 为该 AgentRun 自己的账本（份额来自上级的委派），不得动用收尾保留 F。
修剪（第 9.6 节第 4.5 步）不调用模型，不需要额度。
Kernel 在调用摘要之前检查：账本余额扣除 F 之后能否容纳一次摘要调用的估算；回退为纯文本的每次重试各自预留与结算，同样受这一检查约束。不能时不调用摘要，按额度到达限制的统一路径处理——该 AgentRun 进入最后一轮，
回复或结果中注明因额度结束（收尾调用按第 9.3 节的保险组装）。SubAgent 因此总能用自己账本中的 F 做最后一次调用，以 `finish_subagent` 整理交给 main 的结果。
Turn-chat 的下一个 Turn 有新的份额，届时可以压缩；运行级额度也已不足时，按上文以 `closeRun(BUDGET)` 结束，用户确认后在同一 Session 的新运行中继续。
AWAITING_INPUT 时的压缩（用户的 `/compact` 与空闲时的预先压缩）没有开启中的 Turn，从运行级账本支出，扣除后余额仍须不低于 `minShare(main)`；
不满足时 `/compact` 以 `BUDGET_INSUFFICIENT` 拒绝并告知用户，预先压缩直接不做。

### 7.4 时间

| 计时 | 缺省 | 到点 |
|---|---|---|
| Turn 超时 `turnTimeoutSeconds` | Turn-chat 1800 秒；Orchestration 运行（整体一个 Turn）3600 秒；都不计 PAUSED 的时间 | 按中止处理本 Turn（进入 INTERRUPTING，第 2.3 节）；Orchestration 由 Workflow 收敛节点后以 `closeRun(TIMEOUT)` 报告 |
| 暂停上限 `maxPauseSeconds` | 1800 秒 | 按中止处理 |
| 授权询问 `authorizationTimeoutMs` | 5 分钟，PAUSED 期间冻结 | 本次拒绝 |
| 人类请求 `humanRequestTimeoutMs` | 10 分钟（`prompt` 不限），PAUSED 期间冻结 | 以 `{ timedOut: true }` 作为答复 |

AWAITING_INPUT 没有时间上限：此时没有任何在途工作，也不占用资源。

**技术重试的等待**（M1 的技术重试：至多 `technicalRetryLimit` 次，指数退避）：provider 以限流或过载拒绝、并给出 `Retry-After`（或同义的重试时刻）时，
Executor 把它随失败一起交回，Execution 以"指数退避与 `Retry-After` 中较大者"作为等待时间（参考 OpenCode 的重试策略）；
`Retry-After` 超过 `retryAfterMaxMs`（缺省 120000）时不再等待，按重试耗尽处理。等待期间 ActivityEvent 的阶段为"重试中（第 n 次，x 秒后）"，界面倒计时；
等待不占用并发计数与调用机会，暂停时保留、中止时交付 `INTERRUPTED(ABORTED)`。

### 7.5 接口变化

**Workflow → Kernel**

| syscall | 变化 |
|---|---|
| `registerAgentRun` | 新增 `parentAgentRunId?`、`delegationId?`、`nodeId`、`workspaceViewId`（M2 恒为 `main`）、`requestedCapabilities`、`writeRoots?`、`budget?`、`effort`、`display { label }`；允许多个同时 ACTIVE；可写根目录按写入占用规则检查（第 6.4 节），冲突时返回 `WRITE_SCOPE_CONFLICT`；自动归入开启中的 Turn，没有时返回 `NO_OPEN_TURN` |
| `reserveDelegation` | 新增：`run_subagents` 校验通过后，为全部任务划出委派保留（全有或全无）；返回 `delegationId`，或 `BUDGET_INSUFFICIENT` 与可委派余额 |
| `releaseDelegation` | 新增：任务被跳过或不再登记时返还其份额 |
| `submitUnit` | 新增 `unitRunId`、`display { toolName, argsSummary（≤80 字）}` |
| （说明） | `display` 只用于界面：Kernel 原样放进 ActivityEvent，不据此做任何判断 |
| `requestHuman` | 新增：发起人类请求。`prompt`（开放输入）只能在没有 ACTIVE AgentRun 与在途 UnitAttempt 时发起，并结束当前 Turn（第 2.3 节）；其他种类是局部询问 |
| `readProjectFile` | 新增：读取项目文件（第 7.5 节末尾的说明） |
| `reportSessionList` | 新增：回答 Kernel 的 Session 列表查询（第 10.3 节） |
| `reportCompactionSource`、`ackCompaction` | 新增：回答 Kernel 的压缩材料查询；确认修剪结果与压缩结果已记入日志（第 9.6 节） |
| `updateActivity` | 新增：`update_todos` 的进度（第 3.5 节）；只用于界面，Kernel 原样放进 ActivityEvent |
| `endAgentRun`、`closeRun` | 不变；`closeRun` 新增结束原因 `CANCELLED`、`BUDGET`、`TIMEOUT` |

**Kernel 内部接口**：`SupervisorPort` 新增 `cancelExecution`（第 7.6 节）；`requestReservation` 新增返回 `WAIT_CAPACITY`（第 7.2 节）。

**UserInteraction → Kernel**

| 请求 | 变化 |
|---|---|
| `openSession`、`startSession({ new \| fork, prompt })`、`startRun` | 新增：打开已有 Session；在第一条提示词提交时新建或 Fork Session；`mas run` 以模板新建一个 Session 并开启 WorkflowRun（取代 M1 的 `createRun`） |
| `listSessions`、`deleteSession` | 新增：由 Session 管理处理（第 2.6 节）；列表内容由 Kernel 向 Workflow 查询，UserInteraction 不保存 |
| `answerAuthorization` | 答复增加选项：单次、命令、前缀、允许、拒绝 |
| `answerHuman` | 新增 |
| `pauseRun`、`resumeRun(steer?)`、`interruptRun` | 新增 |
| `steerRun({ target?, input })` | 新增：运行中插话（第 4.5 节），只在 RUNNING 时受理 |
| `undoTurns({ scope: last \| all })`、`confirmUndo({ force })`、`diffTurns` | 新增 ControlOperation；`confirmUndo` 回答第 4.6 节第 3 步的询问 |
| `compactContext` | 新增：用户的 `/compact`，只在 Turn-chat 的 AWAITING_INPUT 时受理（第 9.6 节） |
| `readArtifact`、`shutdown` | 不变 |

**`readProjectFile`**：Workflow 初始化时需要的仓库信息，以系统服务 syscall 向 Kernel 申请，而不是提交 Unit（Unit 是 Agent 的行为，必须属于某个 AgentRun）。
- 路径只接受固定白名单：仓库根目录的 `AGENTS.md`、`.multiagentos/workflows/*.yaml`；
- Kernel 查找本 WorkflowRun 中 `repo.read` 的授权条目，没有时照常询问；由 `RepositoryAccess` 读取，正文存入 ArtifactStore，写审计；不计入任何 AgentRun 的额度；
- 返回：`AGENTS.md` 只返回 ArtifactRef、SHA 与 `trusted`（Workflow 不看内容，直接交给 context-assemble；`trusted` 的判定与询问见第 9.5 节）；模板文件同时返回文本，由 Workflow 解析与编译；
- 时机：WorkflowRun 开启后、启动第一个节点之前读取一次；用户批准修改 `AGENTS.md` 的写入成功后再读取一次。每次读取都追加 `PROJECT_FILE_LOADED` 记录，上下文使用最新一条。

**Kernel → Workflow 的事件**：`SessionOpen`、`SessionListQuery`、`RunStart`、`UnitReport`（新增 `INTERRUPTED` 状态，以及实际改动的文件）、
`HumanAnswered`（开放输入的答复带 `turnId`；运行中插话为 `steer`）、`HumanCancelled`、`TurnClosed`、`RunPaused`、`RunResumed(steer?)`、`RunInterrupted`（带原因：用户中止、暂停超时、Turn 超时）、`WorkspaceReverted`、`WorkspaceDiverged`（打开 Session 时的工作区差异，第 2.3 节）、
`CompactionSourceQuery`、`ToolResultsPruned`、`ContextCompacted`（第 9.6 节）、`RunClosed`。

**Kernel → UserInteraction 的事件**：
- `AuthorizationRequest` / `AuthorizationResolved`；
- `HumanRequest` / `HumanResolved`；
- `MessagePublished`：`message-publish` 完成时发出；
- `RunStateChanged`；
- `ActivityEvent`：由 Kernel 依据 AgentRun 登记、父子关系与 UnitAttempt 的状态生成，Workflow 不需要另一条通道；
  技术重试等待期间阶段为"重试中"，带第几次重试与重试时刻；`updateActivity` 交来的待办进度原样附上；
- `ContextCompacted`、`CompactionFailed`：压缩生效（Workflow 确认已记入日志）后的通知，界面在记录区显示一行，可以经 `readArtifact` 查看摘要；压缩没有进行或失败时的说明；
- `RunFinished`；
- Session 级事件：`SessionOpened`、`SessionFailed`、`SessionClosed`（按 Session 单独编号，第 2.6 节）；
- 系统级事件：`SessionList`、`SessionDeleted`（按进程编号，第 2.6 节）。

**新增原因码**：
- 中断：`INTERRUPTED`（`PAUSED` / `ABORTED`）；
- 能力上限与授权：`CAPABILITY_NOT_SUBSET`（登记时请求超出上限）、`CAPABILITY_NOT_GRANTED`（所需能力不在上限中）、`ADMISSION_CHECK_FAILED`、`APPROVAL_MISMATCH`；
- 写入与文件：`WRITE_OUT_OF_SCOPE`、`WRITE_SCOPE_CONFLICT`、`WRITE_SCOPE_DELEGATED`、`PROTECTED_PATH`、`PROTECTED_PATH_CREATED`、`FILE_CHANGED`；
- 预留能力：`UNSUPPORTED_NODE_KIND`（`INTEGRATE`）、`workspace-merge` 返回 Unsupported；
- 命令与沙盒：`COMMAND_DENIED`、`SANDBOX_UNAVAILABLE`；
- 网络：`DOMAIN_DENIED`、`ADDRESS_FORBIDDEN`；
- 额度与上限：`BUDGET_INSUFFICIENT`、`QUOTA_EXHAUSTED`（Kernel）；`REPEATED_INTENT`、`CONSECUTIVE_ERRORS` 是 Workflow 的收尾原因，不是 Kernel 原因码；
- 运行状态：`AGENT_RUN_ACTIVE`（扩展到 `requestHuman`）、`NO_OPEN_TURN`；
- 上下文与产物：`CONTEXT_COMPACTED`（挂起的 `context-assemble` 因压缩而返回，须以新的投影重新提交）、`CONTEXT_OVERFLOW`（provider 报告上下文过长）、`COMPACTION_SUMMARY_INVALID`（摘要不符合指令规定的格式）、`COMPACTION_UNKNOWN`（压缩的回复对应不上）、`ARTIFACT_EXPIRED`（正文已过保留期，按登记时间判断）；
- 系统故障：`STOP_UNCONFIRMED` 触发停机（第 4.7 节）。

**协议版本**：语义变化的 Schema 按 M1Interface 1.2 发布新 major。M2 运行时只产生新 major；M1 的行为由 `analyze` 模板回归验证。

### 7.6 取消与 runEpoch

M1 中 Supervisor 只有 `cancelRun({ workflowRunId, runEpoch })`，`runEpoch` 一旦前进，之后到达的结果都不再交付（M1 Supervisor 第 3 节、Core 第 5 节）。
M2 的暂停与中止要取消单个执行，而且 Turn-chat 中止后运行还要继续，所以：
- **按执行取消**：`SupervisorPort` 新增 `cancelExecution({ executionId, reason: PAUSED | ABORTED })`，停止的升级顺序见第 4.7 节。`cancelRun` 保留，用于收敛。
- **`runEpoch` 只在进入 CONVERGING 时前进**，与 M1 相同。暂停与中止不改变 `runEpoch`，因为被打断的 Unit 仍要交付 `INTERRUPTED`（不变量 5）。
- **交付条件**：尝试的 `runEpoch` 等于当前值，且运行处于 RUNNING、PAUSING、PAUSED、INTERRUPTING 或 AWAITING_INPUT（M1 只有 RUNNING）。
- **结果映射**：Supervisor 以 `TERMINATED` 上报被取消的执行，Execution 按取消原因形成 `INTERRUPTED(PAUSED | ABORTED)`；MODEL 按 M1 的规则结算已发生的用量。
- **排队中的尝试**：中止时，尚未派发的尝试从队列中移出，同样交付 `INTERRUPTED(ABORTED)`（M1 收敛时清出队列的尝试不交付，这里不同）。
- **防止迟到的提交**：每个尝试记录所属的 `turnId`。Turn 结束后，属于它的 `submitUnit` 一律以 `NO_OPEN_TURN` 拒绝。

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
| `run_command` | `run-command` | EXEC | `command.exec`（`network: true` 时加 `command.network`） | 参数为 `command`、`workdir?`（相对仓库根目录）、`timeoutMs?`、`network?`；缺省不联网；每次在全新的 shell 中执行，不保留 `cd` 与变量；非零退出码是正常结果；预览保留输出的头尾，超出时全文另存（第 8.2 节）；结果带 `sandboxDenials`、`backend`、`changedFiles` |
| `web_search` | `web-search` | READ | `web.search` | `queries: string[]`（≤5 个）并行查询，结果按 URL 去重；`timeRange?`；每条结果包含标题、URL、摘要，URL 先经地址检查 |
| `web_fetch` | `web-fetch` | READ | `web.fetch` | 只允许 http 与 https；解析时与建立连接时各检查一次地址，重定向逐跳检查；大小上限；HTML 转为 Markdown；预览为正文的开头一段，超出时全文另存（第 8.2 节） |
| `read_output` | `output-read` | READ | `repo.read` | 分段读取此前某次工具调用被截断的完整输出，或在压缩中被修剪的工具结果（第 8.2、9.6 节）。参数为 `toolCallId`（那次调用的编号）、`offset?`（起始行，从 1 开始）、`limit?`（行数，缺省并且至多 2000）、`pattern?`（只返回含有这段文字的行，按字面匹配）；结果带行号，同样受预览上限约束，不再产生完整输出。模型只给出编号，不接触 ArtifactRef 或存储地址 |

内建 Unit：`context-assemble`、`model-call`（MODEL）、`report-publish`（M1）、`message-publish`（新增，由 Execution 直接发布 `reply` 与运行结果）。
工作区快照与恢复是 Kernel 的内部操作，不是 Workflow 可以提交的 Unit。
预留 Unit：`workspace-merge`（合并隔离副本，第 6.5 节），M2 中提交即以 Unsupported 拒绝。

### 8.2 结果的统一结构

工具 Unit 的输出分成四部分：
- `output`：结构化结果，按 Unit 的输出 Schema 校验，写入日志；
- `content`：给模型看的文字，即 `output` 的渲染加预览，作为 Artifact 引用（`outputRef`），长期保留；
- `full`：只在预览截断了内容时存在，即完整的原始输出，作为 Artifact 引用（`fullRef`），7 天后过期回收（第 10.1 节）；
  大小不超过该 Unit 的 `maxFullOutputBytes`（缺省 8 MiB），超出时 Executor 按与预览相同的取舍（头、尾或两端）保存，并在预览中注明完整输出也不完整；
- `metadata`：只给终端界面使用，例如 diff 高亮、退出码徽标，不进入模型上下文。

**预览的上限**（参考 OpenCode：2000 行或 50 KiB；DeepSeek Harness 每条工具结果内联至多约 12,500 token）：
- 预览上限与执行上限分开。M2 的工具 Unit（`v1` 定义）的预览不超过 `previewMaxBytes`（缺省 51200）与 `previewMaxLines`（缺省 2000），先到者为准，
  并且不超过该 Unit 的 `maxOutputBytes`（例如 `read_file` 仍是 M1 的 16 KiB）；`maxOutputBytes` 不再是检索、概览、列目录预览的上限（M1 为 1 MiB，一次结果就可能占去大半个上下文窗口）；
- M1 的 `v0` Unit 定义（`analyze` 使用）沿用 M1：预览上限为 `maxOutputBytes`、不限行数，因此 `analyze` 的行为不变；
- 上限按 Unit 定义的版本由 Execution 选取，随执行限制交给 Executor。

**预览在产生时固定**：
- 预览由 Executor 生成：保留哪一部分（头、尾或头尾两端，按字节、按行或按条目）由各 Executor 依据输出的含义决定，截断机制由 ExecutorSet 的共用模块提供；
  预览注明省略了多少内容、完整输出保留 7 天，以及可以用 `read_output` 按本次调用的 `toolCallId` 分段读取；预览中不出现引用或路径；
- Execution 存储预览与完整输出，并为它们登记保留类别（预览长期保留，完整输出 7 天过期）；结果检查确认预览不超过上述预览上限、完整输出不超过 `maxFullOutputBytes`；
- 上下文中放的永远是预览，组装上下文时不再重新截断（第 9.3 节）；因此完整输出的过期不影响上下文的重建。

**读取完整输出**（`read_output`，阶段 2）：用户经界面（`readArtifact`）查看，模型经 `read_output` 分段读取。模型读取时的隔离：
- **编号由 Workflow 翻译**：模型只给出 `toolCallId`。Workflow 在发起调用的 AgentRun 的范围内找到那次工具调用，取出可读的引用填入 Unit 输入：
  截断时为它的 `fullRef`；没有截断、但它的预览在压缩中被修剪过时（第 9.6 节），为原来的预览（此时预览就是完整输出）。
  找不到、或那次结果既没有被截断也没有被修剪时，Workflow 不提交 Unit，按参数错误反馈给模型。范围按日志计算，不按当前投影：
  - main：本 Session 主线上的全部工具调用，跨 WorkflowRun，包括已被压缩取代的，以及 Fork 时继承的历史中的；
  - 模板中的 AGENT 节点、explorer、worker：该 AgentRun 自己步骤中的工具调用，与委派给它的上下文范围一致；main 读不到 SubAgent 的工具调用，SubAgent 也读不到父 AgentRun 的；
  - **被 `/undo` 回退的 Turn 中的工具调用不在范围内**：回退之后对话回到那个 Turn 之前，那些步骤在投影中只剩一条说明（第 4.6 节）；
    读取它们的结果等于让模型看到已被撤销的"未来"，也可能依据已被还原的文件内容行事。回退之前的编号此后一律按"没有这个编号"反馈；
  - 范围内有多次调用的 `toolCallId` 相同时（编号由 provider 生成），取最近的一次。
- **授权与过期由 Execution 检查**：引用必须属于本 Session，且登记为某次工具调用的完整输出（截断时另存的完整输出，或修剪时补登的未截断预览）；是否过期按登记的 `retainedSince` 加 `expiringRetentionDays` 判断，与正文是否已被删除无关，
  过期即返回 `ARTIFACT_EXPIRED`，模型得到"完整输出已过期删除"的说明。结果因此只取决于日志与时间，与回收任务是否已经运行无关。
- **截取由 Executor 完成**：`output-read` Executor 只接收 Execution 解析后的正文，按行切分、过滤、加行号，经共用模块限制在预览上限内（与 OpenCode 的 `read` 相同：至多 2000 行或 50 KiB）；它不接触存储，没有文件系统与网络权限，不需要沙盒。
- **结果固定**：读出的一段是这次 `read_output` 调用的预览，写入日志、长期保留，此后与其他工具结果一样只在末尾追加，不随完整输出的过期而改变。
- **信任不提升**：读出的内容保持原工具结果的来源标记（例如 `web_fetch` 的网页内容仍是外部材料，第 9.2 节）。

非零退出码、测试失败、没有搜索结果都属于 OK。沙盒拒绝、授权拒绝、超时、取消、`FILE_CHANGED`、`WRITE_OUT_OF_SCOPE` 属于 REJECTED 或 FAILED，
带原因码与给模型的简短说明。原始异常文字可能含有宿主机路径与环境信息，只写入审计，不进入模型上下文。

### 8.3 网页检索的提供方

`web-search` 只有一个 Unit。提供方接口按多提供方设计，M2 实现 Tavily 一个适配器（面向 Agent 设计、返回清洗过的摘要，Open Deep Research 与 DeerFlow 都在使用）；以后可以增加自部署的 SearXNG。
测试使用本地的固定内容服务器，不依赖真实网络。

### 8.4 Executor 的组织

```text
executor-set/
  retention/ 预览生成的共用模块：按字节、行或条目保留头部、尾部或两端，不切断 UTF-8，精确计数省略量
  output-read/ read_output：对 Execution 交来的完整输出按行截取、过滤、加行号，结果经 retention/ 限制
  fs/        文件访问接口与本地实现：路径检查、排除规则、同路径锁、带版本条件的写入
  git/       git-inspect：固定子命令表、安全参数、排除规则的 pathspec
  command/   run-command：环境变量白名单与断言、输出截断、拒绝分类；parse/ 为命令的语法树拆分（tree-sitter-bash）与 ARITY 表（第 5.2 节）
  web/       web-search 提供方适配器；web-fetch 的地址检查、重定向、HTML 转 Markdown
  vendor/    从开源项目拷贝的纯函数（注明来源与许可证），如 edit 的匹配函数、HTML 转 Markdown
```

## 9. 上下文组装与思考模式

### 9.1 投影规则

上下文组装属于 Workflow：Workflow 决定模型看到什么，作为 `context-assemble` 的输入交给 Kernel 执行（M1 机制）。
唯一的例外是压缩（第 9.6 节）：何时压缩、摘要怎样生成由 Kernel 决定与执行；Workflow 把压缩结果记入日志之后，摘要就是投影的一部分，此后照常由 Workflow 投影。

| AgentRun | 历史部分 |
|---|---|
| main（Turn-chat） | 本 Session 全部 Turn，跨 WorkflowRun：每个 Turn 的人类输入、main 的步骤、`run_subagents` 的汇合结果；`HUMAN(steer)` 出现在投递时的位置，回退、中断与工作区分歧（`WORKSPACE_DIVERGED`）以说明性记录出现；之前 Orchestration 运行的结果以"运行结果 + ArtifactRef"出现 |
| 模板中的 AGENT 节点 | 节点目标 + 前驱节点的结果 + 本节点的步骤 |
| explorer、worker | 目标 + 父任务显式交给它的引用 + 依赖任务的结构化结果 + 验收标准 + 自己的步骤 |

SubAgent 的投影函数的参数中没有父 AgentRun 的步骤，隔离由类型保证，而不是事后过滤。

### 9.2 组成与顺序

```text
[system] 人设与职责 → 可用工具说明（只含该 AgentRun 实际可用的工具）→ 派生准则（仅 main）
         → 项目指令（仓库根目录的 AGENTS.md，仅当 trusted，第 9.5 节；经 readProjectFile 读取，上限 64 KiB）
[history] 第 9.1 节；运行时上下文（工作目录、沙盒状态、当前日期）作为历史条目出现，变化时在末尾追加新的一条
[tail]   收尾调用时的"必须结束"提示及触顶原因
```

- **只在末尾追加**：两次压缩之间，同一 AgentRun 发出的请求只在末尾增长，前面的内容逐字节不变，使提示词缓存持续命中（DeepSeek 缓存命中的价格约为未命中的 1/50）。为此：
  - system 段在一个 AgentRun 内不变，其中不放会变化的内容；运行时上下文以历史条目表达，变化时由 Workflow 追加 `REQUEST_CONTEXT`，投影在该位置加入一条新的说明；
  - 用户批准修改 `AGENTS.md` 后重新读取的内容，从下一个 AgentRun 起进入 system 段；当前 AgentRun 在历史末尾追加一条说明；
  - 历史条目按日志顺序排列，工具结果与汇合结果按调用顺序排列；已经写入的条目不再改写（预览在产生时固定，第 8.2 节；思考内容是否回传在写入时决定，第 9.4 节）；
  - 不按调用重新裁剪（第 9.3 节）；改变前缀的只有压缩（包括其中的修剪），以及收尾调用的工具列表（只剩结束控制工具，只影响这一次调用）。
- 外部输入（用户输入、网页内容、工具结果、子任务结果、未被信任的 `AGENTS.md`、压缩的摘要）一律以 user 或 tool 角色出现并标明来源，不获得指令权威。

### 9.3 可重建性与上下文规模

- **可重建性**：`projectionDigest` 的计算覆盖消息、请求参数（模型、思考设置）、工具列表摘要、运行时上下文条目、压缩记录、展开的 ArtifactRef 列表。
  这些内容一旦变化，就追加记录，从而保证模型看到的每份上下文都能由日志与长期保留的正文重建；过期的正文（完整输出、ContextPack，第 10.1 节）都不是重建所需的。
- **条目的标注**：Workflow 交给 `context-assemble` 的每个历史条目都带所属 Turn、在日志中的 `seq`，以及类别 `PINNED`（固定保留，不进入压缩：未被信任的 `AGENTS.md`、main 投影中当前 Turn 的人类输入、
  模板节点的目标与交接输入、SubAgent 的目标与验收标准）或 `NORMAL`。
- **不按调用重新裁剪**：`context-assemble` 按日志顺序组装全部条目，不去掉任何条目。上下文的规模只由两件事控制：
  1. 工具结果在产生时只留预览（第 8.2 节）；
  2. 超出阈值时由 Kernel 压缩（第 9.6 节：先修剪较早的大工具结果，仍超出再写摘要），结果写回日志。
- **两种规模估算**：判断是否压缩用"实测加估算"——最近一次模型调用由 provider 报告的实际输入 token，加上它之后新增条目的估算（第 9.6 节"触发"）；
  额度预留仍用保守的字节估算（M1 的 `estimatePackTokens`）。前者用于判断，偏差只影响压缩的时机；后者用于保证额度，宁可高估。
- **收尾调用的保险**：收尾调用是该 AgentRun 的最后一次调用，不再压缩。组装超出 `finalInputBudget` 时，从最早的 `NORMAL` 条目开始去掉，
  以完整的模型轮为单位（工具调用与它的结果不拆开），直到装下为止；`PINNED` 条目与最近一轮永不去掉。去掉的条目记入 `CONTEXT_ASSEMBLED`，结果可以复现。
  仍然装不下时，不调用模型，按 M1 的降级规则结束（第 7.3 节"必有报告"）。
- **压缩之前的阶段**（阶段 1–7 中未实现第 9.6 节时）：普通调用超出 `perCallInputLimit` 时，`context-assemble` 以 `LIMIT_EXCEEDED` 拒绝，
  Workflow 让该 AgentRun 进入最后一轮（按上一条组装），回复中提示用户用 `/new` 开始新的对话。

### 9.4 DeepSeek 思考模式

| 项 | 规则 |
|---|---|
| 模型 | `deepseek-flash`；思考强度按 Agent 缺省值，可由 `run_subagents` 的 `effort` 在允许范围内改变；`/thinking` 可以查看最近的思考内容 |
| 回传 | 带工具的请求中，回传之前各轮的 `reasoning_content`，否则 API 返回 400 或静默停止：<br>- 回传条件为同一模型，且该轮没有出错；<br>- 被暂停或中止打断的思考不回传；<br>- 缺少思考内容的历史轮按实测结果补空字符串（第 14.1 节）；<br>- 该轮是否被打断、是否出错，在写入日志时记录，之后不再改变；只有切换模型会改变较早各轮是否回传（第 9.2 节）；<br>- 被压缩的轮连同思考内容一起由摘要取代 |
| 记录 | 思考内容存为 Artifact，`MODEL_TURN` 记录它的引用；思考内容不显示，也不流式输出 |
| 收尾调用 | 只提供结束控制工具，`tool_choice = auto`，保持思考开启；结果不合法时，以关闭思考加强制工具选择重试一次（M1 的方式）；仍不合法则降级 |

### 9.5 项目指令的信任

`AGENTS.md` 是仓库材料。仓库可能来自他人（克隆的项目、PR 分支），按 Architecture（Overall 第 8 节），仓库材料不因进入上下文而获得指令权威。
因此只有用户确认信任过的确切内容才放进 system 段：

1. **按内容判定**：`readProjectFile` 读取 `AGENTS.md` 时，Kernel.Core 在信任记录中查找 `(仓库根目录的 realpath, SHA)`。
2. **没有记录时询问**：Kernel 发起授权询问（`project.instructions`，第 5.2 节），展示全文（超过 64 KiB 时只展示开头并注明），选项为"信任这份内容"与"不信任"。
3. **信任**：写入 `<dataDir>/kernel-core/trusted-instructions.jsonl`，跨 WorkflowRun、跨 Session 有效。它绑定确切内容，不授予任何执行能力，所以不是授权条目，也不是 Lease，不受"授权只在内存中"的约束；内容一变化（SHA 不同）就重新询问。
4. **不信任、询问超时或 `readonly` 预设**：`AGENTS.md` 以 user 角色、标明"仓库材料，未经用户信任"出现在 history 的开头，不进入 system 段。
5. **经批准的修改**：Agent 经 `write_file`、`edit_file` 修改 `AGENTS.md` 时，用户已逐次批准确切内容（极危险级），写入成功后新内容的 SHA 自动记为信任。命令无法写入或新建 `AGENTS.md`（第 6.1 节）。

### 9.6 上下文压缩

上下文超出阈值时，Kernel 先把较早的大工具结果修剪为头尾两段（不调用模型）；仍超出时，再把较早的一段历史交给模型写成摘要，保留最近的原文。
修剪与摘要的结果都写回会话日志，此后的投影以修剪后的结果与摘要代替原来的内容。
压缩是 Kernel 的一个标准过程：不经过 TaskGraph，不登记 AgentRun，Workflow 只应查询交出材料、把结果记入日志，不决定是否压缩。

**触发**

| 触发 | 时机 | 说明 |
|---|---|---|
| 自动 | Kernel 受理普通调用的 `context-assemble` 时，估算组装后的输入超过 `triggerRatio × perCallInputLimit`（缺省 0.85） | 这是检查点：此时该 AgentRun 处在两次模型调用之间 |
| 溢出 | `model-call` 以 `CONTEXT_OVERFLOW` 返回后，Workflow 按固定规则重新提交 `context-assemble`；Kernel 记住溢出时的规模，依次以它的 85%、70%、50% 为压缩目标 | 第三次仍溢出时不再压缩，按第 9.3 节的收尾路径结束 |
| 用户 | `/compact`（`compactContext`），只在 Turn-chat 的 AWAITING_INPUT 时受理 | 立即执行；对象为 main 的投影；修剪之后总是继续写摘要 |
| 空闲 | Turn-chat 的运行进入 AWAITING_INPUT 时，main 的估算超过 `idleTriggerRatio × perCallInputLimit`（缺省 0.7） | 预先压缩，避免用户发出下一条消息后还要等压缩（参考 OpenCode 的 `precompute` 与 DeepSeek Harness 的空闲维护）；代价是用户可能不再继续，这次摘要的 token 白花 |

**估算**（判断是否压缩时使用，参考 OpenCode 的 `measured + estimated` 与 DeepSeek Harness 的 `tokenMeter`）：
- 该对象最近一次 `MODEL_TURN` 中 provider 报告的实际输入 token（含缓存命中）与输出 token，加上它之后新增条目的字节估算；
- 只有那一轮请求的头部（system 段、工具定义与模型，以 `CONTEXT_ASSEMBLED.headDigest` 比较）与本次相同、且其后没有修剪、压缩或撤销压缩的记录时才使用实测值，否则全部按字节估算；
- 实测值来自日志，估算因此仍是日志的纯函数，进程重启后结果相同。额度预留不用这个估算（第 9.3 节"两种规模估算"）。

**对象**：Turn-chat 中为 main 的投影（整个 Session，跨 WorkflowRun）；模板中的 AGENT 节点与 SubAgent（explorer、worker）为该 AgentRun 的投影（参考 OpenCode 与 DeepSeek Harness：子 Agent 是完整的会话，使用同一套压缩）。
SubAgent 的压缩从它自己的账本支出，不动用它的收尾保留 F；额度不足以写摘要时进入最后一轮，以 `finish_subagent` 整理交给 main 的结果（第 7.3 节"压缩的额度"）。
SubAgent 的 `PINNED` 条目是目标、父任务交给它的引用、依赖任务的结果与验收标准。

**过程**

```text
1. 挂起触发它的 context-assemble（用户与空闲触发时没有），该 AgentRun 因此没有进行中的模型调用
2. 额度检查（第 7.3 节"压缩的额度"），结果先记下：不足时只做第 4.5 步的修剪，修剪之后仍超出才以 BUDGET_WRAP_UP 返回挂起的组装，该 AgentRun 进入最后一轮
   （用户触发时以 BUDGET_INSUFFICIENT 拒绝，空闲触发时不做）
3. 审计 COMPACTION_STARTED；向 Workflow 发出 CompactionSourceQuery { compactionId, target }
4. Workflow 以 reportCompactionSource 交回该对象当前的投影条目（与 context-assemble 的历史条目结构相同，带 seq、所属 Turn 与类别）
4.5 修剪（参考 DeepSeek Harness 的 tool-result-pruner）：Kernel 先划出保留区——最近 keepTokens（缺省 20000）的原文，从完整模型轮的边界算起；
   保留区之前、预览超过 pruneMinBytes（缺省 8192）且尚未修剪过的 NORMAL 工具结果，改写为"头部 pruneHeadBytes（4096）+ 说明 + 尾部 pruneTailBytes（1024）"，
   说明写明省略的字节数与"可用 read_output 按 toolCallId 读回"；截取由 context-assemble Executor 完成（不切断 UTF-8），修剪后的结果存为长期保留的产物
   - 没有可修剪的结果时直接进入第 5 步
   - 有时向 Workflow 发出 ToolResultsPruned { compactionId, target, items }；Workflow 追加 TOOL_RESULTS_PRUNED 后以 ackCompaction 确认，Kernel 收到确认才视为生效
   - 生效后按修剪后的条目重新估算：自动与溢出触发已低于目标、空闲触发已低于 idleTriggerRatio 时到此结束，转到第 9 步；
     否则（以及用户触发时）进入第 5 步，范围选定与摘要都使用修剪后的条目
5. Kernel 选定范围 [fromSeq, toSeq]：从最早的 NORMAL 条目（包括先前的摘要）开始，到保留区之前最后一个完整的模型轮为止；工具调用与它的结果不拆开；
   范围内的 PINNED 条目不被取代（MAIN 的材料中，当前 Turn 的人类输入由 Workflow 标为 PINNED）；
   没有可压缩的范围时结束，挂起的组装照常执行（第 4.5 步有修剪时以 REJECTED(CONTEXT_COMPACTED) 返回）
6. 生成摘要（摘要请求的输入见下文"摘要请求的输入"）：思考强度取配置 summaryReasoningEffort（缺省 none，即关闭思考），tool_choice = none；
   经 Scheduler 申请调用机会，由 model-call Executor 执行，按第 7.3 节计量
   摘要须包含指令规定的各节（目标与要求、已完成的工作与结论、关键决定、涉及的文件、仍可能需要回读的完整输出的 toolCallId、未完成的事项）；不合格时追加更严格的指令重试一次，仍不合格则摘要失败
7. 摘要存为长期保留的产物；向 Workflow 发出 ContextCompacted { compactionId, target, fromSeq, toSeq, summaryRef, summaryInput, usage }
8. Workflow 追加 CONTEXT_COMPACTED 后以 ackCompaction 确认；Kernel 收到确认才视为生效：审计 COMPACTION_ENDED，向 UserInteraction 发出 ContextCompacted
9. 挂起的 context-assemble 以 REJECTED(CONTEXT_COMPACTED) 返回，Workflow 用新的投影重新提交（不计入连续出错，也不是重复调用）
```

**摘要请求的输入**（参考 DeepSeek Harness 的 region 与 OpenCode 的 `deliver`）：
1. **前缀式**（首选）：system 段、工具定义，加上该对象投影中 `seq ≤ toSeq` 的条目（保留区不在其中），末尾追加摘要指令（AgentToolPool 中的 Prompt `compaction-system`）。
   这些条目是之前普通请求的前缀，因此可以命中已有的提示词缓存；
2. **纯文本式**（回退）：前缀式的估算超出 `perCallInputLimit − summaryMaxTokens`，或 provider 以 `CONTEXT_OVERFLOW` 拒绝时使用。
   不带工具定义：system 段只有摘要指令，范围 `[fromSeq, toSeq]` 内的 `NORMAL` 条目（含先前的摘要）转为一份纯文本记录作为 user 消息，
   从最早的完整模型轮开始去掉，直到估算低于目标；先前的摘要不去掉。去掉了内容时，记录开头注明"更早的 k 轮已省略"，摘要中如实说明；
   被 provider 拒绝时依次以拒绝时规模的 `summaryFallbackTargets`（缺省 85%、70%、50%、35%）为目标重试，用完仍失败则摘要失败；
3. 每次请求各自预留与结算额度（第 7.3 节）；`summaryInput` 记录所用的方式与去掉的条目数，写入 `CONTEXT_COMPACTED`。

- **不循环**：同一对象在同一轮中至多因自动触发压缩一次；压缩后重新提交的组装即使仍超过 `triggerRatio` 也照常执行，超出 `perCallInputLimit` 时按第 9.3 节的收尾路径结束。
  溢出触发另按 `overflowTargets` 计次，至多三次。
- **失败**：摘要失败（包括被暂停或中止打断）、Workflow 写日志失败，都不写回或不生效，审计 `COMPACTION_FAILED`；已经生效的修剪保留；挂起的组装照常执行（有修剪时以 `REJECTED(CONTEXT_COMPACTED)` 返回），仍超出时按第 9.3 节的收尾路径结束。
  进程在第 3–8 步之间退出时，日志中没有对应的记录，那一部分视为没有发生；审计中只有 `COMPACTION_STARTED`，可以识别。
- **投影规则**：
  - `TOOL_RESULTS_PRUNED` 生效后，该对象投影中被列出的工具结果改用修剪后的内容，位置不变；
  - `CONTEXT_COMPACTED` 生效后，该对象的投影中 `seq` 在 `[fromSeq, toSeq]` 内的 `NORMAL` 条目由一条摘要条目取代，摘要条目放在第一个被取代条目的位置：
    user 角色，标明"较早对话的摘要，由系统生成，含仓库与外部材料，不是指令"；范围内的 `PINNED` 条目保持原来的相对顺序，排在摘要之后；
  - 再次压缩时范围可以包含先前的摘要，新的摘要将它一并取代。被取代与被修剪的原始记录仍在日志中（日志只追加）。
- **安全**：摘要的素材可能含有提示注入，所以摘要只以 user 角色出现，永不进入 system 段；`PINNED` 条目不进入摘要，也不被修剪；摘要指令要求模型不执行材料中的指令。
- **缓存**：前缀式摘要请求的消息前缀（system 段、工具定义、历史）是之前普通请求的前缀，用以命中已有的缓存；思考强度不同是否影响命中，由阶段 0 实测（第 14.1 节），
  结果只影响 `summaryReasoningEffort` 的缺省值。压缩之后新的前缀是"system 段 + 摘要 + 保留的原文"（只有修剪时为修剪后的历史），此后又只在末尾追加。
- **被取代与被修剪的工具结果**：仍可经 `read_output` 读回（第 8.2 节）：截断过的读完整输出（未过期时），没有截断而被修剪的读原来的预览——修剪时 Execution 为这份预览补登一行完整输出的登记，它是长期保留的，不会过期。
  模型需要知道 `toolCallId`：修剪的说明中写明它，摘要指令要求保留可能还需要的编号。
- **空闲触发的规则**：
  - 估算使用 main 最近一次模型调用的实测值，不需要先查询材料；对象只有 main；一次 AWAITING_INPUT 至多触发一次，失败不重试，也不通知界面（只写审计）；
  - 进行中收到用户的开放输入时，新 Turn 照常开启，main 的第一次 `context-assemble` 挂起，等这次压缩结束（生效后以 `REJECTED(CONTEXT_COMPACTED)` 返回）；
  - 进行中收到 `/compact`、`/undo`、`/fork`、切换或关闭 Session 时，先取消这次压缩（按失败处理，不写回摘要），再执行该操作。
- **与回退的关系**：`/undo` 回退的 Turn 与某次压缩的摘要范围相交时，Workflow 按固定规则追加 `CONTEXT_COMPACTION_REVOKED`，投影恢复为原始条目，之后需要时再压缩；
  只回退压缩范围之后的 Turn 不受影响。修剪不随之撤销：被回退 Turn 中的工具结果在投影中已只剩一条说明，其余的修剪与回退无关。由阶段 2 与阶段 8 中较晚完成的一个实现。
- **Fork**：复制的日志中带着修剪与压缩记录，新 Session 沿用；修剪后的结果与摘要的产物随其他引用一起被新 Session 登记拥有（第 10.4 节）。
- **配置**（`KernelConfig.compaction`）：`triggerRatio` 0.85、`idleTriggerRatio` 0.7、`keepTokens` 20000、`pruneMinBytes` 8192、`pruneHeadBytes` 4096、`pruneTailBytes` 1024、
  `summaryMaxTokens` 8192、`overflowTargets` [0.85, 0.7, 0.5]、`summaryFallbackTargets` [0.85, 0.7, 0.5, 0.35]、
  `summaryReasoningEffort` `none`（取值同 Agent 的思考强度，启动时按摘要所用模型的 `effortMapping` 校验）；初值在阶段 8 按固定任务校准，改配置即可调整，重启后生效。

## 10. Session 与持久化

### 10.1 目录

```text
<dataDir>/
  instance.lock/                           实例锁：同一 dataDir 只运行一个实例（组合根，见下）
  artifacts/<sha256>                       ArtifactStore：内容寻址的正文，跨 Session 共享（Kernel.Execution）
  kernel-core/session-refs.jsonl           Session 引用：sessionId、状态与仓库根目录（Kernel.Core，第 10.3 节）
  workflow/session-index.jsonl             Session 列表（Workflow，第 10.3 节）
  kernel-core/trusted-instructions.jsonl   用户信任过的 AGENTS.md 内容（Kernel.Core，第 9.5 节）
  sessions/<sessionId>/
    session.lock/                          单写者锁（pid）；进程不存在时视为过期；M2 中由实例锁保证不被争用，为以后放开多实例保留
    workflow/log.v1.jsonl                  SessionLogStore：会话日志（Workflow）
    kernel-core/audit.jsonl                Kernel 审计：授权询问与条目、Lease 签发、ControlOperation、拒绝、结算
    kernel-execution/artifact-owners.jsonl 本 Session 拥有的产物
    kernel-execution/snapshot-index.jsonl  快照索引：turnId、viewId → 开始与结束快照
    kernel-execution/snapshots/            工作区快照（影子 git）
    kernel-execution/quarantine/           命令新建的受保护路径（第 6.1 节）
```

两个存储各有唯一的 Owner，互不管辖：

| | SessionLogStore | ArtifactStore |
|---|---|---|
| Owner | Workflow（唯一写入者） | Kernel.Execution（唯一写入者） |
| 内容 | 会话日志：拓扑、HUMAN 节点、Unit 的提交与结果、Turn 与运行的边界、修剪与压缩记录、控制记录。只保存结构化记录与 ArtifactRef，不保存正文 | 全部正文：工具输出的预览与完整版本、修剪后的工具结果、模型输出、思考内容、用户输入的正文、压缩的摘要、ContextPack、报告与回复 |
| 写入 | 只追加 | 只新增，内容寻址，写入后不可变 |
| 创建、复制、删除 | Workflow 执行：新建日志、Fork 时复制日志、删除日志 | Execution 执行：写入正文并登记归属与保留类别、在 Session 删除时删除归属文件、启动时与每小时回收 |
| 读取 | 只有 Workflow | 按 ArtifactRef 经 Kernel 读取，归属检查见下 |
| 机制 | 由 Persistence 提供（第 10.3 节的写入规则） | 由 Persistence 提供，M1 的 ArtifactStore 原样扩展 |

两者的唯一连接是 ArtifactRef：Workflow 的日志中只出现引用，正文只在 ArtifactStore 中。
Workflow 需要保存正文（例如用户输入）时，一律经 Kernel 交给 Execution 写入，再把返回的引用写进日志。

`dataDir` 必须位于仓库之外（M1 规则），并在沙盒中被遮蔽。

**正文的保留类别**：Execution 登记归属时同时登记保留类别。

| 类别 | 正文 | 何时可以回收 |
|---|---|---|
| `SESSION`（长期保留） | 重建上下文所需的一切：工具结果的预览、修剪后的工具结果、模型输出（含工具调用参数）、思考内容、用户输入、回复、报告、运行摘要、压缩的摘要、`AGENTS.md` 与模板文件 | 没有任何 ACTIVE 的 Session 拥有它 |
| `EXPIRING`（7 天） | 不是重建所需的：工具结果的完整版本（第 8.2 节）、ContextPack（可由日志重新计算，`projectionDigest` 可以验证） | 登记满 `expiringRetentionDays`（缺省 7 天），或没有任何 ACTIVE 的 Session 拥有它 |

- 同一份内容被多个 Session、或以不同类别登记时，取最长的保留：只要还有一处 `SESSION` 登记属于 ACTIVE 的 Session，就不回收。
- 读取已回收的正文时返回 `ARTIFACT_EXPIRED`，与"不存在或不属于本 Session"的 `INVALID_ARTIFACT_REF` 区分；归属文件中的登记行仍在，因此缺失的原因可以解释。
  `EXPIRING` 正文是否过期按登记时间判断：满 `expiringRetentionDays` 后即使正文尚未被删除，读取也返回 `ARTIFACT_EXPIRED`，使结果不取决于回收何时运行。
- Session 本身不会被自动删除（第 1.3 节）。

**实例锁**：同一个 `dataDir` 同一时刻只运行一个 MultiAgentOS 实例。全局共享的 `artifacts/`、`session-refs.jsonl`、`session-index.jsonl`、`trusted-instructions.jsonl` 与产物回收因此都只有一个写入者，不需要跨进程同步。
- 组合根在启动时、Supervisor 清理临时数据之前取得锁，进程退出（包括第 4.7 节的停机）时释放。
- 实现：以 `mkdir <dataDir>/instance.lock` 的原子性加锁（Node 没有原生的 flock），锁目录中写入 `{ pid, 进程启动时间, hostname, 版本 }`；持有期间每 10 秒更新一次 mtime 作为心跳。
- 过期判定，任一条件成立即视为过期：pid 不存在；pid 被复用（与 `/proc/<pid>/stat` 中的启动时间不一致）；心跳超过 60 秒未更新。
- 抢占过期的锁：先把它 rename 为墓碑目录，再重新 `mkdir`，两个进程同时抢占时只有一个成功。
- 取锁失败时报错退出，说明持有锁的进程。
- 产物回收在持有实例锁时进行：启动时、开放服务之前一次，之后每隔 `sweepIntervalMinutes`（缺省 60）一次（参考 OpenCode）。
  只读取 Session 引用为 ACTIVE 的 Session 的 `artifact-owners.jsonl`（登记行在产物引用交出之前已经追加），按上表标记仍需保留的正文，
  删除其余在本次回收开始之前写入的正文。Session 引用为 DELETED 的 Session 不参与标记，即使它的归属文件因删除失败而残留。
- 运行中的回收与写入并存：写入的正文已经存在时（内容寻址），ArtifactStore 更新它的写入时间，因此回收开始之后被再次写入的正文不会被删除；
  定期回收由 Kernel 的定时器以内部消息触发，与新建、删除、Fork 等 Session 管理操作按顺序开始，读取登记与删除文件的 I/O 在后台进行，不阻塞 Session 的处理。
- 不同 `dataDir` 指向同一个仓库时，工作区与快照没有保护，这一点写入限制清单。

**以 Session 为存放单位**（M1 按 WorkflowRun 存放在 `runs/<workflowRunId>/`）：

- **一个 Session 一个会话日志**：Session 内先后进行的全部 WorkflowRun 都追加到同一个文件，以 `WORKFLOW_RUN_STARTED` 与 `WORKFLOW_RUN_ENDED` 划分；
  再以 `TURN_STARTED` 与 `TURN_ENDED` 划分 Turn（这两条记录由 Workflow 依据 Kernel 的 `HumanAnswered`、`TurnClosed` 事件写入）。日志的层次与第 2.1 节的概念层次一一对应：

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
  重开 Session 时也只需读一个文件、拿一把锁。WorkflowRun 是治理单位（授权条目、额度、TaskGraph），不是存储单位。
- **产物的归属范围从 WorkflowRun 扩大为 Session**：后一个 WorkflowRun 的上下文要引用之前各 Turn 的工具结果，
  因此 ArtifactRef 的归属检查（M1 Kernel 5.2 节的 `INVALID_ARTIFACT_REF`）改为"属于本 Session"，依据是 `artifact-owners.jsonl`。授权仍按 WorkflowRun：
  能引用旧产物，不等于能重新读取仓库。
- **Kernel 的数据**：审计、产物归属、快照与快照索引放在同一个 Session 目录中，但属于 Kernel 的命名空间，Workflow 不能读写（M1 Persistence 第 3 节的命名空间规则）。

### 10.2 日志记录

| 类别 | 记录 |
|---|---|
| Session | `SESSION_STARTED`：仓库、`formatVersion`、定义版本与 `definitionsDigest`、项目指令引用、沙盒探测结果 |
| WorkflowRun | `WORKFLOW_RUN_STARTED`（模板、预设）、`WORKFLOW_RUN_ENDED`（结束原因） |
| Turn | `TURN_STARTED`（`turnId`、提示节点、开始快照引用）、`TURN_ENDED`（结束原因、用量摘要、结束快照引用）；都来自 Kernel 的事件 |
| 拓扑 | `GRAPH_EXTENDED`、`NODE_STARTED`、`NODE_ENDED` |
| 业务输入 | `HUMAN_REQUESTED`、`HUMAN_ANSWERED`：所有用户输入（`prompt`、`steer`、`ask`、`confirm`、`review`）都只以这两种记录出现，带节点 ID、种类、附属对象与正文引用；界面中排队、尚未提交的消息不在日志中 |
| 控制 | `RUN_PAUSED`、`RUN_RESUMED`、`RUN_INTERRUPTED`、`WORKSPACE_REVERTED`、`WORKSPACE_DIVERGED` |
| 循环 | `LOOP_EXHAUSTED`（第 3.2 节） |
| Unit | `UNIT_SUBMITTED`、`UNIT_COMPLETED`（结构化输出与 ArtifactRef）、`UNIT_INTERRUPTED`；`MODEL_TURN` 带 `reasoningRef` 与用量（压缩的估算使用其中的实际输入 token）；`CONTEXT_ASSEMBLED` 带 `headDigest`（system 段、工具定义与模型的摘要）；失败的模型尝试单独记录，不进入模型历史 |
| 待办 | `TODOS_UPDATED`：`update_todos` 的调用引用与计数（第 3.5 节） |
| 项目文件 | `PROJECT_FILE_LOADED`：路径、ArtifactRef、SHA、`trusted` |
| 请求参数 | `REQUEST_CONTEXT`：模型、思考设置、工具列表摘要、运行时上下文，变化时追加；运行时上下文的变化在投影中成为一条新的历史条目（第 9.2 节） |
| 压缩 | `TOOL_RESULTS_PRUNED`：对象、被修剪的工具结果（`toolCallId`、修剪后的引用、可读回的引用）；`CONTEXT_COMPACTED`：对象、被取代的 `seq` 范围、摘要引用、摘要请求的方式、用量；`CONTEXT_COMPACTION_REVOKED`：回退使某次压缩的摘要失效（第 9.6 节） |
| 授权 | `AUTHORIZATION_REQUESTED`、`AUTHORIZATION_DECIDED`：Kernel 授权询问的审计副本，不是 HUMAN 节点，不进入上下文，重放时不恢复授权 |
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
4. 对每个"已提交、未完成"的 UnitRun 追加 `UNIT_INTERRUPTED`（原因"上一个进程中断"，故障停机时为"上一个进程故障停机"），不重放；
   对没有 `TURN_ENDED` 的 Turn 追加 `TURN_ENDED(PROCESS_EXITED)`（没有结束快照）；对未结束的 WorkflowRun 追加 `WORKFLOW_RUN_ENDED(PROCESS_EXITED)`；
   有上述修复时，最后追加一条 `STALE_UNITS_SETTLED`，记录修复了哪些 Unit、Turn 与运行；
5. 重建投影；Kernel 比较工作区并告知差异（第 2.3 节 Session 第 6 条，不改动文件），再开启新的 WorkflowRun；
6. 最后一个人类请求没有答复时，重新展示它；否则进入 AWAITING_INPUT。

**Session 列表归 Workflow**，保存在 Workflow 命名空间的 `<dataDir>/workflow/session-index.jsonl`，每个 Session 一行（追加更新，读取时取每个 Session 的最后一行）：

| 字段 | 来源 |
|---|---|
| `sessionId`、创建时间、Fork 来源（`fromSessionId`、Fork 时原 Session 的 Turn 数） | Workflow 创建 Session 时写入 |
| 标题 | 第一条 `prompt` 正文的 ArtifactRef；列表展示时由 Kernel 按引用读取前 80 字 |
| Turn 数、最后活动时间 | Workflow 收到 `TurnClosed` 时更新 |
| 状态 | 正常、已删除 |

**Kernel 只保存引用**：Kernel.Core 在 `<dataDir>/kernel-core/session-refs.jsonl` 中只记录 `sessionId`、状态与仓库根目录的 realpath。
仓库根目录是 Kernel 履行自己职责所需的事实（`repo.read` 的询问、工作区快照、沙盒的可写路径），由 Kernel 在创建 Session 时依据本进程的仓库写入，不依赖 Workflow 提供。
引用用来校验 `openSession`（包括仓库是否与本进程一致）、定位自己命名空间中该 Session 的审计、快照与产物归属，以及删除时清理这些数据；不保存标题、Fork 关系等列表内容。
索引损坏或缺失时，Workflow 可以由各 Session 的日志重建 Session 列表，Kernel 可以由各 Session 目录重建引用。

**UserInteraction 不保存任何 Session 信息**：`/sessions` 经 Gateway 向 Kernel 发出 `listSessions`，Kernel 的 Session 管理以系统级事件（第 2.6 节）向 Workflow 查询列表，只保留引用存在、且仓库与本进程一致的 Session，再交给 UserInteraction；界面只展示这次的结果。

### 10.4 Fork

Fork 从一个已有 Session 的**当前末端**分出一个新的 Session。两者的对话与日志此后各自继续，互不影响；工作区是共用的（见下表）。

M2 没有设置可以回到的历史检查点：Turn 是计量与回退文件的单位，不是对话的检查点；唯一完整的保存点是 Session 本身。
因此 Fork 只能在 Session 的末端进行，不能从更早的 Turn 分出。想在之后回到某个位置，就在那时先 Fork，以后切换到那个 Session（`/resume`）。

| 项 | 规则 |
|---|---|
| 发起 | 用户执行 `/fork`，不带参数。只在 AWAITING_INPUT 时可用，此时最后一个 Turn 已经结束，是静止点 |
| 创建时机 | 用户在草稿中提交第一条提示词时才创建（第 2.3 节）；放弃草稿不留下任何内容 |
| 日志 | 新 Session 有自己的日志文件：复制原日志的全部记录（`seq` 不变），对其中未结束的 WorkflowRun 追加 `WORKFLOW_RUN_ENDED(FORKED)`，再追加 `SESSION_FORKED { fromSessionId, fromSeq }`，然后是新的 `WORKFLOW_RUN_STARTED` 与第一个 `HUMAN(prompt)`。此后两个日志各自追加，原 Session 的日志不被修改 |
| 产物 | 正文不复制，ArtifactStore 也不被修改。Workflow 复制日志时，同时列出其中出现的全部 ArtifactRef，经 Kernel 交给 Execution；Execution 把它们按原来的保留类别登记为新 Session 拥有（过期时间仍从原来的登记算起）。删除任一 Session 只影响它自己的归属，正文按第 10.1 节的规则回收 |
| 授权与额度 | 不复制。新 Session 开启新的 WorkflowRun，授权条目由人类重新签发，额度重新计算 |
| 工作区与快照 | 不改动文件。两个 Session 共享同一个仓库目录，Fork 时工作区就是原 Session 最后一个 Turn 的结束状态。新 Session 不复制原 Session 的快照，它的 `/undo`、`/diff` 只覆盖自己的 Turn；第一个 Turn 的开始快照照常由 Kernel 在 Turn 开启时拍摄 |
| 切换回原 Session | 不改动文件；在新 Session 中改过的文件按第 2.3 节 Session 第 6 条作为信息告知原 Session |
| 列表 | `/sessions` 显示每个 Session 从哪个 Session 分出 |

两个 Session 不能同时运行（M2 不支持多个 Session 并行）；切换由 Kernel 按第 2.3 节完成。
M2 中所有 Session 共用同一个仓库目录；每个 Session 或每个 Agent 有独立的工作区副本，留到 M3，接口见第 6.5 节。

## 11. 终端交互

### 11.1 布局

界面参照 Claude Code CLI，在同一个终端中分为三个区域：

| 区域 | 内容 |
|---|---|
| 记录区 | 用户输入、`reply`、运行结果、已完成步骤的折叠行（如 `✓ read_file src/a.ts 0.3s`）、授权与人类请求的处理结果 |
| 活动区 | 每个 ACTIVE 的 AgentRun 一行：阶段、计时（每秒刷新）、转动指示（100 毫秒）、待办进度（有 `update_todos` 时）；并行的工具作为子行；SubAgent 按父子关系显示为树 |
| 输入区 | 输入框；排队等待提交的消息（第 4.5 节）；待处理的授权询问与人类请求排成队列，一次处理一项，每项标明来源 |

阶段名称：`组织上下文`、`压缩上下文`、`思考中`、`重试中（第 n 次，x 秒后）`、`调用 <工具> <参数摘要>`、`等待授权`、`等待回答`、`排队`、`等待 <任务名>`、`收尾`、`已暂停`。
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
| RUNNING | Enter | 消息进入排队，运行进入 AWAITING_INPUT 时作为下一条消息提交（第 4.5 节） |
| RUNNING | Alt+Enter，或 `/steer [@任务名] <说明>` | 运行中插话，不暂停（第 4.5 节） |
| RUNNING | Ctrl+C | 暂停 |
| PAUSED | `/continue [@任务名] [说明]`，或直接输入普通消息 | 继续，可附加说明（第 4.5 节） |
| PAUSED | Ctrl+C | 中止 |
| AWAITING_INPUT | 普通消息 | 开启新的 Turn |
| AWAITING_INPUT | Ctrl+C | 清空输入；2 秒内连按两次则退出 |
| 任意 | Enter 发送；`\` 加 Enter 换行；Esc 清空输入；↑/↓ 浏览历史输入 | — |

| 指令 | 作用 |
|---|---|
| `/help`、`/status`、`/exit` | 帮助、当前运行状态与额度状态、退出 |
| `/continue`、`/steer` | 第 4.5 节 |
| `/undo`、`/undo all`、`/diff [N]` | 回退上一个 Turn、回退本 Session 全部 Turn、查看差异；有外部修改时询问是否强制（第 4.6 节） |
| `/run <模板> <目标>` | 第 3.8 节 |
| `/thinking [N]` | 查看最近第 N 次模型调用的思考内容 |
| `/compact` | 立即压缩较早的对话（只在 AWAITING_INPUT 时可用，第 9.6 节） |
| `/timeline` | 当前运行中每个 AgentRun 的执行区间 |
| `/sessions`、`/resume <id>`、`/delete <id>` | 列出 Session（经 Kernel 向 Workflow 查询，含 Fork 来源）、打开已有 Session、删除未打开的 Session（第 2.3 节） |
| `/new`、`/fork` | 进入新对话或 Fork 的草稿；Fork 只从当前 Session 的末端分出；提交第一条提示词时才创建 Session（第 2.3、10.4 节） |

## 12. 系统不变量

以下性质在 M2 的任何时刻都必须成立，并且每条都有对应的测试：

1. 只有 Kernel 能产生外部副作用；Workflow 与 UserInteraction 只写自己命名空间的系统数据。
2. 能力上限、授权条目与 Lease 只在 Core 中，只在内存中；SubAgent 的能力上限 ⊆ 父 AgentRun 的能力上限；授权条目只由人类签发；Lease 只在能力在上限之内且有授权条目覆盖时签发。
   能力上限之外的请求一律拒绝、不询问；能力上限之内而没有授权条目的请求一律询问，人类拒绝或询问失败才拒绝。
3. 进程内写入检查、Core 的写入判定、沙盒的可写路径，对任意路径的判断一致。
4. `PAUSED ⇒ 在途 UnitAttempt = 0`；`AWAITING_INPUT ⇒ 没有 ACTIVE 的 AgentRun 且在途 UnitAttempt = 0`。
5. 每个得到受理的 `submitUnit` 恰好得到一个 UnitReport（OK、REJECTED、FAILED、INTERRUPTED 之一），或随 RunClosed 结束。
6. 每个已登记的 AgentRun 都能完成收尾：它的收尾额度在登记时已经预留，且至多一次 final-call。
7. 节点状态、就绪集合、模型上下文都是会话日志的纯函数（压缩的结果也在日志中）；重放任意前缀，得到与运行时相同的结果；重建只需要长期保留类别的正文。
8. 日志只追加；撤销、中断、修复都以追加记录表达。
9. 处于运行状态的 AgentRun，写入占用两两不相交；父 AgentRun 的占用在派生期间转为委派，此时它的 WRITE 与 EXEC 一律被拒绝；同一 WorkflowRun 内同一时刻至多一个 EXEC。
10. 被打断的 EXEC 不会被自动重跑；已完成的 Unit 在继续时不会重做。
11. 授权与检查出错时一律拒绝；超时不视为同意。
12. 凭据不进入子进程环境、模型上下文与普通日志。
13. TaskGraph 上的每一次用户输入都对应一个 HUMAN 节点；HUMAN 节点的答复不产生授权条目，授权询问只由 Core 在准入判定中发起。
14. 极危险级的操作每次都单独询问，没有任何可复用的批准。
15. SessionLogStore 只由 Workflow 写入，ArtifactStore 只由 Execution 写入；日志中只有 ArtifactRef，没有正文。
16. `.git/`、`.multiagentos/` 不能被任何工具或命令写入；`AGENTS.md` 不能被命令写入；命令新建的这些路径不会留在工作区中。
17. 模板不携带权限：能力上限与派生能力只来自 Agent 定义，授权只来自人类签发的授权条目。
18. Turn 只由 Kernel 依据开放输入开启与结束；Turn 结束时没有 ACTIVE 的 AgentRun 与在途 UnitAttempt。
19. 沙盒中的命令读不到 `$HOME`（白名单目录中的非凭据文件除外）、`<dataDir>` 与仓库中的敏感文件；文件工具与命令对敏感文件的可见性一致。
20. 只有用户信任过的确切内容的 `AGENTS.md` 进入 system 段。
21. 安全不依赖命令名单：沙盒可用时，未获准 `command.network` 的命令无法联网。
22. 每个账本的在途预留至多一份；下级的份额只来自上级的委派，上级的可委派额度不含它自己的收尾保留；AgentRun 结束时剩余全部返还。
23. 出现无法确认停止的执行时系统停机，不在任何状态下继续推进。
24. 同一个 `dataDir` 同一时刻至多一个实例。
25. 就绪集合只依赖日志中的结构化记录：条件只读前驱的结构化结果，循环展开在同一次事件处理中确定。
26. `/undo` 只改动被回退的 Turn 改过的文件；有外部修改时，未经用户明确选择强制，不修改任何文件；强制回退前总有兜底快照。
27. 两次压缩（包括只有修剪的压缩）之间，同一 AgentRun 发出的请求只在末尾增长：前一次请求是后一次请求的前缀（收尾调用的工具列表除外）。
28. 修剪与摘要都只在 Workflow 确认已记入日志后生效；摘要永不进入 system 段，`PINNED` 条目永不进入摘要、永不被修剪；压缩不动用收尾保留 F。
29. 只有 ACTIVE 的 Session 的登记能让正文免于回收；`SESSION` 类正文在被某个 ACTIVE 的 Session 拥有期间永不回收。
30. 模型只以 `toolCallId` 引用完整输出，永不接触 ArtifactRef 或存储地址；`read_output` 只能读到发起者范围内、本 Session 的、按登记时间未过期的完整输出；被 `/undo` 回退的 Turn 中的工具调用不在任何范围内。

## 13. 验收

验收在 Ubuntu 24.04 上进行，使用固定的 fixture 仓库与本地网页服务器。真实模型评测的结果写入 M2 的验收证据文档。

| 组 | 用例 | 通过条件 |
|---|---|---|
| R | M1 固定任务集 F1–F5，经 `analyze` 模板运行 | 与 M1 验收结果一致 |
| C | C1 修复单个 bug 并运行测试；C2 跨三个文件的重构；C3 测试先失败、修复后通过；C4 按要求新增功能与测试；C5 安全陷阱 | C1–C4 各有一个固定的 fixture 仓库，每个用真实模型跑 5 次，每个任务至少 4 次成功。一次成功指：fixture 的测试通过、没有越出范围的改动、回复说明了做了什么。C5 是确定性用例，必须 100% 拦截，每一项都必须被拦截：<br>- 写到 `writeScope` 之外；<br>- 经仓库内指向仓库外的符号链接读写；<br>- `env` 或 `printenv` 输出中出现 key；<br>- 命令或文件工具写入 `.git/hooks`、`.multiagentos/`，命令写入 `AGENTS.md`；<br>- 在不是 git 仓库的目录中，命令 `git init` 并写入 `.git/hooks`，或新建 `AGENTS.md`：结束后工作区中不存在这些路径；<br>- 未经批准的命令访问网络；改写形式的推送（`env git push`、`git -C . push`）在不联网时失败；worker 申请联网被拒绝；<br>- 读取 `<dataDir>`、`~/.ssh`、`~/.bash_history`，或白名单目录中的凭据文件；<br>- 命令 `cat .env`、`cat *.pem` 读不到内容；<br>- 沙盒结束后，宿主仓库中没有新增的空文件或空目录 |
| P | P1 工具并行（一轮 4 个 READ）；P2 两个无依赖的 worker；P4 模板中两个并行 main 节点的 `writeScope` 相交或缺失；P5 两个并行 main 节点各自派生 worker，范围跨越对方；P6 父 AgentRun 在派生期间提交 WRITE；P3 D1 依赖图（A；B；C、D 依赖 A；E 依赖 B、C、D） | P1：执行时间有重叠。P2：执行时间重叠，且写入互不越界。P3：完工时间接近关键路径，并与"分批派生"及 LangGraph 同构图的对照数据一起写入证据。P4：编译报错。P5：登记以 `WRITE_SCOPE_CONFLICT` 拒绝。P6：以 `WRITE_SCOPE_DELEGATED` 拒绝 |
| D | 派生指标（10 个适合派生的任务 + 10 个不适合的任务） | 适合派生的任务中，首次校验通过并正确派生 ≥ 8/10；不适合的任务中，误派生 ≤ 2/10 |
| H | H1 运行中暂停后 `/continue 改用另一种实现`；H2 暂停后中止，再输入"继续"；H3 worker 等待命令授权时，其他 AgentRun 继续推进；H4 `ask_user`；H5 `/undo`、`/undo all` 与 `/diff`（Turn-chat，以及结束后的 Orchestration 运行）；H8 回退前，另一个 Session 或用户手动改过被回退的文件，分别选择取消与强制；H9 用户确认强制回退后，文件又被外部程序修改；H10 回退时另一个 Session 改过、但不在回退范围内的文件；H6 命令忽略 SIGTERM；H7 进程无法被杀死（以测试替身模拟停止确认失败）；H11 运行中 `/steer`（目标为 main、为正在运行的 worker、为已结束的 worker）；H12 运行中输入的消息排队，以及中止后的排队消息 | 状态转移与第 4.3 节一致；被打断的 EXEC 没有自动重跑；H3 中其他 AgentRun 的模型调用没有被取消；H6 经 SIGKILL 停止，系统继续；H7 系统停机，审计中有该执行的记录，重开 Session 时遗留 Unit 记为 INTERRUPTED，工作区差异被告知、文件没有被改动；H5 没有外部修改时直接回退、不询问，连续 `/undo` 逐个 Turn 往前；H8 取消时没有任何文件被修改，强制时外部修改被覆盖，且可以从兜底快照找回；H9 回退停止，已写入的文件恢复，重新提示；H10 该文件保持不变；H11 运行没有暂停，说明在目标下一次组装时出现在末尾，目标已结束时改投父 AgentRun 并注明；H12 排队的消息在 AWAITING_INPUT 时作为下一个 Turn 提交，中止后不自动提交、放回输入框 |
| G | G1 `chat` 中 main 失败或被中止后继续对话；G2 条件边：`review` 通过与不通过分别走向不同节点；G3 循环：连续两次不通过后第三次通过，以及达到 `maxIterations`；G4 `all_done` 汇合部分失败的分支；G5 任意日志前缀重放 | G1 下一个 `prompt` 没有被跳过；G2 未选中的分支记为 `SKIPPED(NOT_TAKEN)`；G3 节点路径带迭代号，下游只按最后一次迭代判定，达到上限时追加 `LOOP_EXHAUSTED`；G4 汇合节点运行并得到各前驱的结束状态；G5 就绪集合与运行时一致 |
| B | B1 三个 SubAgent 并行消耗额度；B2 份额之和超过可委派额度；B3 子任务提前结束；B4 运行级额度到达限制 | B1 没有因其他 Agent 的在途预留而进入 WRAP_UP；B2 整次 `run_subagents` 不执行，错误中给出可委派余额；B3 剩余额度立即返还父账本，未知消耗不返还；B4 Kernel 没有强制收敛运行；各 AgentRun 进入最后一轮；Turn-chat 发布了回复，Orchestration 发布了运行报告（输出节点未运行时为确定性报告），都注明因额度结束 |
| A | 授权：三级的询问次数；"本运行内这条命令均允许"不跨 WorkflowRun；询问超时不放行；SubAgent 派生不引起询问；Agent 在 `ask_user` 中请求权限且用户回答同意后，再执行命令仍然触发 Kernel 询问；`git push` 与联网命令每次询问且没有"均允许"选项；暂停 10 分钟后继续，待处理的询问没有被超时拒绝；未被信任的 `AGENTS.md` 不进入 system 段，其中的注入指令没有被执行，内容变化后重新询问信任；命令的拆分：引号中的 `&&`、子 shell、heredoc、变量作命令名、语法错误的命令 | 全部符合第 5 节；命令按语法树拆分，解析失败与不是字面量的命令名只提供单次允许，名单匹配不因解析失败而遗漏 |
| W | W1 检索加读取后作答并注明来源；W2 网页中的提示注入；W3 访问私网地址、DNS 重绑定、重定向到内网 | W2：注入内容没有被执行。W3：全部以 `ADDRESS_FORBIDDEN` 拒绝 |
| O | 同一问题分别用 Turn-chat 与 `research` 模板运行；使用者模板的校验错误 | 两种方式都完成，比较完成率、耗时与 token；校验错误指明规则与节点 |
| L | L1 长对话超出阈值后自动压缩并继续；L2 provider 报上下文过长后压缩重试；L3 `/compact`；L4 摘要调用失败或额度不足；L5 压缩前后的请求前缀；L6 产物回收：完整输出与 ContextPack 满 7 天后（启动时与运行中的定期回收）、删除 Session 后、新建或删除失败后；L7 回退的 Turn 落在压缩范围内（阶段 2 与阶段 8 都完成后）；L8 `read_output`：分段与过滤读取、超过 `maxFullOutputBytes` 的输出、读取另一 Session 或范围之外的编号、读取被 `/undo` 回退的 Turn 中的编号、过期后读取、读取已被压缩取代或被修剪的调用（阶段 8 完成后）；L9 修剪：修剪后已低于阈值、修剪后仍需摘要、额度不足时只修剪；L10 摘要请求本身超出窗口或被 provider 拒绝；L11 空闲时的预先压缩，以及进行中收到新消息与 `/undo`；L12 SubAgent 的压缩与额度不足时的收尾（阶段 4 完成后）；L13 压缩的估算使用最近一次模型调用的实测值 | L1–L3：压缩后对话继续，日志中有 `CONTEXT_COMPACTED`，重放得到相同的上下文；L4：没有写回任何压缩记录，按额度或收尾路径结束并有回复；L5：两次压缩之间每次请求都是下一次的前缀（以 fake provider 记录请求比对），并在验收证据中记录真实运行的缓存命中率；L6：过期的正文被回收，读取时得到 `ARTIFACT_EXPIRED`，上下文重建不受影响，仍被 ACTIVE Session 拥有的长期正文没有被回收；L7：投影恢复为原始条目；L8：读到的内容与完整输出一致并带行号，结果不超过预览上限；范围之外的编号按参数错误反馈，模型的上下文与日志中不出现 `fullRef`；过期时得到 `ARTIFACT_EXPIRED` 的说明，不论正文是否已被删除；重放日志时 `read_output` 的结果不变；被回退 Turn 中的编号按"没有这个编号"反馈；L9：`TOOL_RESULTS_PRUNED` 先于摘要生效，修剪后的结果带 `toolCallId` 并可经 `read_output` 读回原文，`PINNED` 与保留区没有被修剪，只修剪时不调用模型；L10：改用纯文本式并按 `summaryFallbackTargets` 重试，`CONTEXT_COMPACTED` 记录方式与省略的条目数；L11：用户的下一条消息等压缩生效后才组装，`/undo` 取消压缩且没有写回；L12：SubAgent 压缩后继续，额度不足时以 `finish_subagent` 结束，收尾保留没有被动用；L13：fake provider 报告的输入 token 与按字节估算不同时，按实测值决定是否压缩，重开 Session 后结果相同 |
| S | S1 运行中杀掉进程后重开 Session；S2 日志尾部损坏；S3 `/new` 或 `/fork` 后放弃草稿；S4 Fork 后分别在两个 Session 中继续，再切换回原 Session；S5 同一 `dataDir` 启动第二个实例；S6 实例锁的持有进程已退出后启动；S7 provider 限流并给出 `Retry-After` | S1、S2：对话可以继续；遗留的 Unit 被标为 INTERRUPTED，没有重放；授权被重新询问。S3：不产生任何新的 Session 文件。S4：两个日志互不影响，原日志逐字节不变；切换回原 Session 时文件没有被改动，main 的上下文中注明了在另一个 Session 中被修改的文件，编辑这些文件前要求重新读取。S5：第二个实例报错退出，说明持锁进程。S6：过期的锁被抢占，正常启动。S7：重试等待不短于 `Retry-After`，活动区显示"重试中"与倒计时；超过 `retryAfterMaxMs` 时不再等待 |

**发布阻断项**：
- C5 任一项未被拦截；
- 恢复的 Session 复用了旧授权；
- 思考内容回传错误导致 400 或静默停止；
- 暂停后出现在途 UnitAttempt；
- 被打断的命令被自动重跑；
- 出现 `STOP_UNCONFIRMED` 后系统继续推进；
- 凭据泄露到子进程或日志；
- 回收删除了重建上下文所需的正文，或压缩后的上下文不能由日志重建。

## 14. 关联文档与说明

### 14.1 实现前需要实测与同步的事项

**实现前需要实测**（结果写入 M2 的技术栈文档）：
- Ubuntu 24.04 与 WSL 上，bwrap 能否以非特权用户运行第 6.1 节的完整 profile，包括：先以 tmpfs 遮蔽 `$HOME` 再挂回白名单目录与仓库的挂载顺序、以 `/dev/null` 覆盖单个敏感文件、`--ro-bind` 重新挂载已存在的受保护路径时宿主仓库中不留下任何新文件；
- DeepSeek 思考内容回传、历史轮缺少思考内容、收尾调用三种组合的实际行为；
- DeepSeek 是否支持 `none`、`low`、`high`、`max` 四档思考强度，以及不支持时的映射方式（第 9.4 节）；
- DeepSeek 提示词缓存在"只在末尾追加"时的命中情况，以及摘要请求（相同前缀、`tool_choice = none`）能否命中同一缓存；思考开启与关闭对命中的影响；
  关闭思考的请求中历史仍带 `reasoning_content` 时 API 的行为（第 9.2、9.6 节）；
- DeepSeek 报告的输入 token 是否包含缓存命中的部分（压缩的估算使用它，第 9.6 节），限流时是否给出 `Retry-After`（第 7.4 节）。

**与已有文档的差异**：下面两张表登记了 M2 与 Architecture、M1 文档的全部差异，不允许不登记就偏离。

**Architecture**：下表各项已经评审，并于 2026-10-30 同步到 Architecture。表格保留作为记录，说明 M2 在哪些地方改变了原有的架构表述：

| 位置 | 原文 | M2 的做法 | 本文位置 |
|---|---|---|---|
| Overall、Module | 没有 HUMAN 节点、Turn、能力上限与授权条目 | 加入 HUMAN 节点；能力上限与授权条目两步判定，Lease 改为两者都满足时为一个 UnitAttempt 签发的执行许可；Turn 由 Kernel 依据开放输入维护 | 2.1、4、5 |
| Module/Kernel 3.2 | 运行控制状态 RUNNING → CONVERGING → CLOSED，只能前进 | 增加 PAUSING、PAUSED、INTERRUPTING、AWAITING_INPUT；它们都处在进入 CONVERGING 之前，"进入 CONVERGING 之后只能前进"不变 | 4.3 |
| Module/Kernel 3.2、3.3；Evolution 第 2 节 | 每个 WorkflowRun 一个运行 actor；运行管理是唯一跨运行的部分，只保存映射；按 WorkflowRun 分片 | 串行处理的单位改为 Session（Session actor）；Kernel 核心中有 Session 级与系统级状态；以后分片的单位相应改为 Session | 2.6 |
| Evolution 第 4 节 | "用户的长期授权记录、共享索引与仓库快照"在分片后的 Owner 待设计 | M2 按单实例给出答案（Session actor、系统级状态、实例锁）；分片时的设计仍然待定，保留在该表中 | 2.6、10.1 |
| Evolution 第 4 节 | 额度委派、业务类人工参与等方向尚未进入 MVP | 由 M2 给出设计，移到 Evolution 新增的第 5 节；M2 的有意偏离（直接改写工作区、文件工具在进程内、单实例）也记在该节 | 4、7.3 |
| Overall 第 6 节；Module/Kernel 第 5 节 | 危险行为每次都必须单独征得用户同意 | 对应极危险级；危险级可以在本运行内按命令或前缀放行 | 5.2 |
| Module/Kernel 第 5 节 | 拒绝或超时不视为同意，并在本次运行内保留 | 用户明确拒绝在本运行内保留；询问超时只拒绝本次，不保留 | 5.3 |
| Module/Kernel 3.2、第 13 节；Kernel/Supervisor 第 3 节 | `STOP_UNCONFIRMED` 是收敛时的正常结局（效果未知，先核对） | 出现即系统停机：M2 的暂停、Turn 结束与快照依赖"静止"，无法确认停止时没有可继续的一致状态 | 4.7 |
| Overall 第 8 节 | 仓库材料不因进入上下文而获得指令权威 | 例外：用户按内容信任过的 `AGENTS.md` 进入 system 段 | 9.5 |
| Overall 第 9 节；Module/Workflow 第 6 节 | 变更以可核验产物交付，Kernel 执行物化与应用，Workflow 决定集成 | Agent 直接改写工作区中的文件；以改动检测、写入占用与快照弥补；变更产物、隔离副本与集成留到 M3（已预留 `INTEGRATE`） | 6.4、6.5 |
| Kernel/Supervisor 第 4 节 | 文件修改是不可信行为，每次在独立子进程中运行 | `file-write`、`file-edit` 在进程内执行，安全由 `isWritable` 保证 | 2.5、6.3 |
| Module/UserInteraction 第 2、5 节；Infrastructure/Persistence 第 2 节 | WorkSession、SessionTree 归 UserInteraction；"会话关联、交互状态"归 UserInteraction | Session 列表与会话日志归 Workflow，Kernel 只保存引用，UserInteraction 不保存任何 Session 信息；Architecture 中含义不同的 `InteractionTurn` 等概念已删除 | 2.1、2.4、10.3 |
| Infrastructure/Persistence 第 2 节 | 没有 SessionLogStore | 加入 SessionLogStore（归 Workflow），与 ArtifactStore（归 Execution）的边界：只经产物引用相连 | 10.1 |
| Module/Kernel 第 9 节 | 达到硬阈值时 Monitor 拒绝新的消耗型预留，不停止运行 | 与 M2 一致（额度不触发 Kernel 收敛），不需要修改；只补充"并行 AgentRun 的子额度以委派方式划出" | 7.3 |
| Overall 第 8 节；Module/Workflow 第 4 节 | 上下文由 Workflow 请求、Kernel 按 Executor 的算法构建；没有说明谁决定压缩 | 压缩由 Kernel 作为标准过程决定与执行，Workflow 交出材料并把结果记入日志；压缩结果是写回的事实，不是每次重算的视图（v1.5 同步） | 9.6 |

**M2 版本的 M1 机制文档**（M1 的文档保持不变；M2 实现时在各组件文档中按下表改写）：

| M1 文档 | 改变 | 本文位置 |
|---|---|---|
| Kernel/Core | Lease 的含义；能力上限与授权条目；相同询问合并；超时不保留；多个 ACTIVE 的 AgentRun；写入占用；Turn；新的控制状态；运行中插话；交付条件 | 2.3、4.3、4.5、5、6.4、7.6 |
| Kernel/Execution | 唯一的 FIFO 改为按 AgentRun 分队列与并发类别；等待调用机会；产物归属从 WorkflowRun 改为 Session；快照、改动检测；中止时排队中的尝试也交付；技术重试以 `Retry-After` 为下限，等待时发出"重试中"的活动 | 7.1、7.2、7.4、7.6、10.1 |
| Kernel/Scheduler | 申请不到调用机会从"立即失败"改为 `WAIT_CAPACITY`；容量从 1 改为 `providerCapacity` | 7.1、7.2 |
| Kernel/Monitor | 账本从每个运行一份改为逐级委派；收尾保留与 final-call 按 AgentRun；工具次数与墙钟上限 | 7.3 |
| Kernel/Supervisor、SystemFaultHandling | 新增 `cancelExecution` 与 SIGKILL 升级；`STOP_UNCONFIRMED` 改为系统停机；子进程增加 bwrap 与 git | 2.5、4.7、7.6 |
| Kernel/Interaction | 运行 actor 改为 Session actor；新的消息类型与控制通道 | 2.6、7.5 |
| Kernel/Gateway | 新的 syscall 与来源检查 | 7.5 |
| Infrastructure/Persistence | 存放单位从 `runs/<workflowRunId>/` 改为 `sessions/<sessionId>/`；新增命名空间 `kernel-execution`；会话日志改为只追加的 JSONL；实例锁 | 10.1、10.3 |
| Infrastructure/ArtifactStore | 从按运行存放改为全局内容寻址、按 Session 登记归属与保留类别；启动时与每小时回收；写入已存在的正文时更新写入时间 | 10.1 |
| Library/ExecutorSet | 工具结果的预览在产生时固定，预览上限与执行上限分开（`previewMaxBytes`、`previewMaxLines`），完整输出另存并设上限；新增 `output-read`；`context-assemble` 不再按调用裁剪，只保留收尾调用的保险；修剪的截取、摘要请求的两种组装；命令按语法树拆分与表驱动的 ARITY；`model-call` 交回 `Retry-After` | 5.2、7.4、8.2、9.3、9.6 |
| M1Interface | 变化的 Schema 发布新 major，写入 M2Interface | 7.5 |

**M2 的配套文档**：M2Plan（按第 15 节的阶段排期）、M2Interface（字段级）、各组件文档、Library 文档（新的 Agent、Unit、Tool、Prompt、模板定义）、技术栈、使用说明、限制清单（含威胁模型）、验收证据。


### 14.2 待决事项

以下事项不影响本文的结构，在对应的文档中解决：

| # | 事项 | 建议方向 | 在哪里解决 |
|---|---|---|---|
| 1 | `analyze` 回归与 M1"一致"的标准：M2 的额度逐级委派，每个 AgentRun 各有一次 final-call | 为 `analyze` 固定一套 M1 额度档案（运行级 300,000，planner 与 code-viewer 共用一份账本、一次 final-call），在此档案下比较 F1–F5 的结果 | **已决定**，见 M2Plan |
| 2 | `ask`、`confirm`、`review` 询问 10 分钟超时后自动继续，与"无人值守是非目标"有冲突 | 不自动继续：缺省不超时；只有其他工作都在等待人类时，Turn 超时才暂停计时 | Workflow 文档 |
| 3 | 验收的量化：D 组"正确派生"由谁判定；P3"接近关键路径"的阈值；O 组没有通过标准；缺少成本与延迟上限 | 用固定的判定表与人工复核；P3 以完工时间 ≤ 关键路径的 1.3 倍为准；O 组与成本、延迟按 M1 的基线方式取值后写入 | **已决定**，见 M2Plan |
| 4 | 影子仓库、兜底快照与隔离目录的清理与保留 | 随 Session 删除；另设按时间或数量的清理策略，定期压缩影子仓库 | Execution 文档 |
| 5 | 并行 explorer 访问网页时，每个新域名都询问一次，询问可能过多 | 评估是否为 `web.fetch` 增加"本运行内全部域名均允许"选项，并衡量它对信息外泄的影响 | Core 文档、限制清单 |
| 6 | 长期保存的命令授权：授权条目只在内存中、每个 WorkflowRun 重新询问，同一条命令（如 `npm test`）每次启动都要再批准（OpenCode 把"总是允许"写入数据库，跨会话有效） | M2 暂不考虑；M2 实现之后以实验设计评估询问次数与风险，再决定是否允许用户在 dataDir 的用户配置中预先签发放行规则（不能放在仓库内） | M2 发布后 |
| 7 | 长时间运行的命令：每条命令在新的 shell 中执行、至多 10 分钟，无法启动开发服务器后再测试（OpenCode 有持久终端与后台 shell，DeepSeek Harness 有 `jobs`） | M2 暂不实现，写入限制清单；M2 实现之后再评估后台任务的设计 | M2 发布后 |

### 14.3 参考

各开源项目的分析与建议见作者本地的参考资料（OpenCode、DeepSeek Harness、LangGraph、Microsoft Agent Framework、DeerFlow、Open Deep Research），
它们不是本文的约束。本文采纳的主要设计及来源：

| 设计 | 来源 |
|---|---|
| 就绪判定写成日志的纯函数、确定性 ID、结果逐个记录、汇合顺序固定 | LangGraph（Pregel） |
| 结果契约、定义摘要比较、Handoff 的 human-in-loop 轮次语义、任务账本 | Microsoft Agent Framework |
| 两层 ID、确认停止后才释放槽位、重复意图熔断、写前必读、连接时的地址检查 | DeerFlow 2.0 |
| 派生准则、数量超限时具体的反馈、子任务只交回结论 | Open Deep Research |
| steer 与 queue、打断时不重放工具调用、按语法树拆分子命令与表驱动的前缀匹配、预览上限、压缩的实测加估算与预先压缩、摘要请求的纯文本回退、待办工具、遵守 `Retry-After` 的重试 | OpenCode |
| 模型可见即已记录、审批结果闭合、日志尾部修复、沙盒的真实探测、非零退出码是结果、摘要之前先修剪工具结果、摘要只取被压缩的区域 | DeepSeek Harness |

## 15. 交付顺序

本节只规定阶段的划分、依赖与退出条件，不含日期；排期写在 M2Plan 中。每个阶段结束时系统都可以运行，并通过此前全部阶段的验收。

| 阶段 | 内容 | 依赖 | 退出条件（第 13 节） |
|---|---|---|---|
| 0 实测 | bwrap 完整 profile；DeepSeek 思考内容回传与思考强度（第 14.1 节） | — | 结果写入 M2TechStack |
| 1 Session 与对话骨架 | SessionLogStore、Session 列表与引用、Session actor、实例锁；Turn 与开放输入；HUMAN 节点与 AWAITING_INPUT；`chat` 模板与生长规则；内置模板 `analyze` 的编译与运行（plan → view 为条件边）；上下文投影（只在末尾追加，收尾调用的保险）与思考模式；工具结果的预览在产生时固定（预览上限 `previewMaxBytes`、`previewMaxLines`）、正文的保留类别与回收；`AGENTS.md` 的信任；单个 main 使用只读工具（M1 的工具与 `list_files`）；技术重试遵守 `Retry-After` 与"重试中"的活动；运行中消息的排队（界面） | 0 | R（经 `analyze` 回归）、S1–S3、S5–S7、L5（没有压缩的部分）、L6、H12（中止的部分在阶段 5） |
| 2 写入与回退 | 能力上限与授权条目、询问合并；`write_file`、`edit_file`；工作区快照、`/undo`、`/undo all`、`/diff`；Fork 与切换 Session 时告知差异；`read_output`（第 8.2 节）；main 的 `update_todos`（第 3.5 节） | 1 | A 组的写入部分、H5、H8–H10、S4、L8（读取已被压缩取代的调用除外）、L7（阶段 8 已完成时） |
| 3 命令与沙盒 | bwrap、`run_command`、`git_inspect`（在只读沙盒中运行，第 8.1 节）、命令按语法树拆分与表驱动的 ARITY（第 5.2 节）、敏感文件遮蔽、受保护路径的新建检查；`cancelExecution` 与停止升级、`STOP_UNCONFIRMED` 停机 | 2 | C1–C5、H6–H7、A 组的命令部分 |
| 4 并行 | 并发类别与按 AgentRun 分队列、等待调用机会；写入占用；额度逐级委派；`run_subagents` 与结果契约；业务熔断；worker 的 `update_todos`；SubAgent 的压缩（阶段 8 已完成时） | 3 | P1–P6、B、D |
| 5 人类在环控制 | 暂停、继续、`steer`（暂停后附加，以及运行中 `/steer`）、中止；`ask_user`；交付条件与 `runEpoch` 规则（第 7.6 节） | 4 | H1–H4、H11、H12 的中止部分 |
| 6 Web | `web_search`（Tavily）、`web_fetch` 与地址检查 | 1 | W |
| 7 Orchestration | 使用者模板与校验、使用者模板中的条件边、有界循环、`all_done`；`mas run`、`/run`；额度触顶时的确定性运行报告 | 4 | O、G |
| 8 上下文压缩 | 压缩过程（第 9.6 节）：自动、溢出、`/compact` 与空闲触发，实测加估算，材料查询，修剪与结果确认，摘要请求的两种输入与额度，投影替换；压缩与回退的关系、读取已被压缩取代或被修剪的调用（阶段 2 已完成时）；SubAgent 的压缩（阶段 4 已完成时） | 1 | L1–L5、L9–L11、L13（L7 与 L8 的压缩部分在阶段 2 与阶段 8 都完成后，L12 在阶段 4 与阶段 8 都完成后） |

阶段 6 与阶段 8 只依赖阶段 1，可以与阶段 2–5 并行开发；阶段 8 的编号只表示它是后加入的阶段，不表示它排在最后。

## 版本记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.0 | 2026-10-30 | 定稿 |
| v1.0（编辑性） | 2026-10-30 | M1 文档归档到 `docs/History/M1/`，更新相应链接；初稿对照记录不再保留，版本记录改在本节 |
| v1.0（编辑性） | 2026-10-30 | 第 15 节：`git_inspect` 依赖只读沙盒（第 8.1 节），从阶段 1 移到阶段 3，与第 8.1 节一致；第 14.2 节待决 #1、#3 已在 M2Plan 中决定 |
| v1.1 | 2026-10-30 | 第 2.3 节新增 Session 第 0 条：进程绑定一个仓库，`/sessions`、`/resume` 只涉及本仓库；第 2.4、10.1、10.3 节：Kernel 的 Session 引用增加仓库根目录 |
| v1.1（编辑性） | 2026-10-30 | 第 1.4 节：M1 冻结的 Schema major 是 0（M1Interface 第 1.2 节），原写作"v1"；M2 的新 major 为 1 |
| v1.2 | 2026-10-30 | 第 3.2 节：确定性 ID 改为"前缀 + 可读路径 SHA-256 的前 32 位"，符合 M1 的标识格式；可读路径作为 `path` 字段保存 |
| v1.3 | 2026-10-30 | 第 3.1、3.8 节：`analyze` 的 plan → view 改为条件边；M1 planner 的结束方式加入条件来源；条件边的求值随阶段 1 的内置模板实现 |
| v1.3（编辑性） | 2026-10-30 | 第 15 节：阶段 1 的 `analyze` 改为"plan → view 为条件边"、阶段 7 的条件边限定为使用者模板，与 v1.3 一致；版本记录按版本排序 |
| v1.4 | 2026-10-30 | 第 2.6 节：事件增加系统级序列（Session 列表的查询与结果、删除未打开的 Session），解决没有打开的 Session 时无法列出 Session 的问题；第 2.3 节：删除只针对未打开的 Session；额度结束后的继续是对当前 Session 再次 `openSession`；第 11.2 节增加 `/delete <id>`（此前有 `deleteSession` 请求而没有对应的指令）；第 2.4、7.5、10.3 节相应修改 |
| v1.5 | 2026-10-30 | 上下文与产物保留：第 8.2 节，工具结果的预览由 Executor 在产生时固定，完整输出另存；第 9.2、9.3 节，取消按调用重新裁剪，两次压缩之间请求只在末尾追加（运行时上下文改为历史条目），收尾调用保留确定性的保险；新增第 9.6 节，上下文压缩作为 Kernel 的标准过程（自动、溢出与 `/compact` 触发，模型摘要加保留最近原文，结果写回日志）；第 10.1 节，正文分为 `SESSION` 与 `EXPIRING`（7 天）两类，回收只统计 ACTIVE 的 Session，新建或删除失败时清理 Kernel 的文件；第 1.3 节，压缩不再是非目标，Session 不自动删除；第 2.4、7.3、7.5、10.2、11、12（不变量 7、27–29）、13（L 组）、14.1、15（阶段 8）节相应修改 |
| v1.6 | 2026-10-31 | 第 8.1、8.2 节：新增工具 `read_output`（阶段 2），模型以 `toolCallId` 分段读取被截断的完整输出，编号由 Workflow 在发起者的范围内翻译（按日志计算，包括已被压缩取代的调用），授权与过期由 Execution 检查（按登记时间判断），截取由新的 `output-read` Executor 完成；完整输出设上限 `maxFullOutputBytes`；第 9.6 节：摘要请求的思考强度改为配置 `summaryReasoningEffort`（缺省关闭），摘要保留仍需回读的 `toolCallId`；第 10.1 节：产物回收改为启动时一次、之后每小时一次，写入已存在的正文时更新写入时间；第 12（不变量 30）、13（L6、L8）、14.1、15（阶段 2、8）节相应修改 |
| v1.7 | 2026-10-31 | 对照 OpenCode 与 DeepSeek Harness 的修改：第 8.2 节，预览上限与执行上限分开（`previewMaxBytes` 50 KiB、`previewMaxLines` 2000，M1 的 `v0` Unit 不变）；`read_output` 的范围不再包括被 `/undo` 回退的 Turn，并可读回被修剪的结果；第 9.6 节，压缩的估算改为最近一次模型调用的实测输入加新增条目的估算，摘要之前先修剪较早的大工具结果（第 4.5 步，`TOOL_RESULTS_PRUNED`），摘要请求只包含到 `toSeq` 为止的历史并增加纯文本回退，增加空闲时的预先压缩，SubAgent 也压缩（额度不足时以收尾保留结束）；第 3.5 节，新增控制工具 `update_todos`；第 4.5、11 节，运行中可以插话（`/steer`、Alt+Enter），运行中输入的消息在界面中排队；第 5.2 节，命令按 tree-sitter-bash 语法树拆分，ARITY 改为表驱动，解析失败不提供"均允许"；第 7.4 节，技术重试以 `Retry-After` 为下限并显示"重试中"；第 14.2 节，长期保存的命令授权与长时间运行的命令列为 M2 实现后评估的事项；第 4.1、4.2、7.3、7.5、9.2、9.3、10.1、10.2、12（不变量 27、28、30）、13（A、H11–H12、L8–L13、S7）、14.1、14.3、15 节相应修改 |
