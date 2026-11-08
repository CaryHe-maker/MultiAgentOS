# MultiAgentOS M2 UserInteraction

> 状态：已实现；发布前再与代码核对一次。

## 1. 定位

UserInteraction 是用户与系统交互的边界：收集用户意图与原始审核响应，展示 Kernel 交来的内容。它**不保存任何 Session 信息**
（M2Design 第 2.4 节），界面上的 Session 列表、标题、Fork 关系都来自 Kernel 的事件。
请求与事件的字段见 [Interface/InteractionKernel](../Interface/InteractionKernel.md)，界面设计以 [M2Design](../M2Design.md) 第 11 节为准，
长期规划见 [UserInteraction 架构](../../Architecture/Module/UserInteraction.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| `multiagentos analyze --repo <路径> "<目标>"`：一次输入、一次报告，展示完即关闭 | `mas`：交互式对话，进程绑定一个仓库，可以新建、打开、切换 Session；`mas run <模板> "<目标>"`：一次运行后退出 | M2Design 第 2.3 节 |
| 逐行输出（readline） | 三个区域的终端界面（Ink）：记录区、活动区、输入区 | M2Design 第 11.1 节、M2TechStack 第 4 节 |
| 只有授权询问 | 授权询问与人类请求排成同一个队列，一次处理一项，每项标明来源 | M2Design 第 4.1 节 |
| Ctrl+C 取消运行 | Ctrl+C 为暂停、再按为中止；退出用 `/exit` | M2Design 第 11.2 节 |
| 展示 AnalysisReport | 展示 `reply`、运行结果与 `analyze` 的报告；报告的展示规则沿用 M1 | — |
| 运行中不接受输入 | 运行中输入的消息在界面中排队，AWAITING_INPUT 时作为下一条消息提交； Alt+Enter 或 `/steer` 为运行中插话 | M2Design 第 4.5 节 |

报告的展示、控制字符的转义、`InteractionMessages` 文案表、自身错误的捕获边界与 M1 相同，见归档的
[M1 UserInteraction](../../History/M1/Module/UserInteraction.md) 第 5、6.1 节。

## 3. 职责

- 进入 Kernel 的唯一途径是 `InteractionGatewayPort`；实现运行级、Session 级与系统级三种事件的 Inbox，按各自的序列逐条处理。
- 终端的全部要求由 `ConsoleView` 表达（记录区的 `print`、活动区与输入区的 `update`、放回输入框的 `restoreInput`）；`apps/cli` 以 Ink 实现展示，UserInteraction 不依赖 Ink。
- 分配 `requestId` 与 `inputId`；保存的只有界面偏好、草稿、排队的消息与输入历史（↑/↓），都只在内存中，退出即丢弃。
- 不直接访问 ArtifactStore、Persistence 或 Workflow；正文经 `readArtifact` 读取。

## 4. 命令

```text
mas [--repo <路径>] [--readonly]                    交互式；仓库缺省为当前工作目录
mas run [--repo <路径>] [--readonly] <模板> "<目标>"   目前只接受内置模板 analyze（使用者模板见 M2ReleasePlan phase 2）
mas log [<对话>] [--repo <路径>] [--turn <n>] [--full] [--json] [--list]   只读地查看一个对话的时间线
```

- 仓库路径由组合根取 realpath 后写入 Kernel 的配置（M2Design 第 2.3 节 Session 第 0 条）；UserInteraction 不传仓库路径。
- `--readonly` 设置启动预设（M2Design 第 5.2 节）。
- 参数错误返回 64（M1 的规则）。选项只在它所属的命令之后生效：`mas run --repo X analyze …` 与 `mas run analyze … --repo X` 都把 `--repo` 交给 `run`（曾因程序级选项吞掉子命令的选项而丢失，有回归测试）。
- `mas log` 在启动任何模块之前处理，不取实例锁与 Session 锁，不调用模型（[Phase1Console](../Phase1Console.md) 第 3 节）。

## 5. 交互式流程

```text
启动 → listSessions → 收到 SessionList（系统级事件；此时还没有打开的 Session）
  有本仓库的 Session → 显示最近的几个，用户可选择打开（openSession）或开始新对话
  没有 → 进入新对话的草稿
草稿中提交第一条提示词 → startSession({ mode: NEW, prompt })
SessionOpened → 记录区显示标题与 Turn 数（来自事件，不保存）
运行中：
  ActivityEvent      → 更新活动区
  MessagePublished   → readArtifact 读取正文，追加到记录区
  AuthorizationRequest、HumanRequest → 进入输入区的待处理队列
  RunStateChanged    → 更新状态栏；AWAITING_INPUT 时输入框接收下一条消息
运行中按 Enter 的消息 → 进入排队（第 5.2 节）
AWAITING_INPUT 时输入普通消息，或收到 HumanRequest(prompt) 时有排队的消息 → answerHuman(prompt)
RunFinished → 记录区显示结束说明；若运行因额度结束，提示用户确认是否在同一 Session 中继续：
  确认 → 对当前 Session 再次 openSession（Kernel 开启新的运行，不重新打开 Session）→ RunStateChanged(AWAITING_INPUT)
```

### 5.1 待处理队列

- 授权询问与人类请求按到达顺序排成一个队列，一次只处理一项；两类以不同样式显示，每项标明来自哪个 Agent。
- 授权询问的展示：
  - `repo.read`：仓库路径、排除规则、"读取的内容会发送至 <provider>"；询问不超时，不显示回答期限；
  - `project.instructions`：`AGENTS.md` 的全文（经 `readArtifact` 读取；`truncated` 时注明只展示开头）、"信任这份内容"与"不信任"两个选项。
- 回答只是原始响应：授权以 `AuthorizationResolved` 为准，人类请求以 `HumanResolved` 为准；没有回答不视为同意。
- 询问的读取任务不阻塞 Inbox 的处理（M1 第 4 节的规则）。

### 5.2 排队的消息

- 运行处于 RUNNING 时，在输入框中按 Enter 的普通消息进入排队，显示在输入区（"已排队 1 条"，可展开）；Kernel 与 Workflow 不知道排队的存在。
- 收到 `HumanRequest(prompt)` 时，取排队的第一条，分配 `inputId` 后以 `answerHuman` 提交；其余的依次等待之后的开放输入请求。
- 排队的消息在提交前可以用 ↑ 取回编辑，或用 Esc 撤回最后一条。
- 运行因中止进入 AWAITING_INPUT、运行因额度结束、切换或关闭 Session 时，不自动提交，排队的消息依次放回输入框。
- 以 `/` 开头的指令不排队，按第 5.3 节立即处理或提示当前不可用。

### 5.3 指令与按键

| 输入 | 状态 | 效果 |
|---|---|---|
| 普通消息 | AWAITING_INPUT 或草稿 | 提交为开放输入 |
| 普通消息 | RUNNING | 进入排队（第 5.2 节） |
| `/new` | 任意 | 进入新对话的草稿；提交第一条提示词时才创建 Session |
| `/sessions` | 任意 | `listSessions`，展示 `SessionList` |
| `/resume <编号或 id>` | 任意 | `openSession`；编号来自最近一次展示的 `SessionList` |
| `/delete <编号或 id>` | 任意 | `deleteSession`；只能删除未打开的 Session，结果以 `SessionDeleted` 展示 |
| `/status` | 任意 | 当前运行状态与额度状态（来自最近的事件） |
| `/output <编号>` | 任意 | 经 `readArtifact` 展示第几个被截断的工具结果的完整输出（第 6 节） |
| `/help`、`/exit` | 任意 | 帮助；`shutdown` |
| Enter、`\` 加 Enter、Esc、↑/↓ | 任意 | 发送、换行、清空输入、浏览输入历史（多行输入框里上下键先在行间移动）；左右、Home/End、Ctrl+A/E/U/K/W 在光标处编辑 |
| `/think [N]` | 任意 | 列出思考内容；带编号则打印第 N 段思考的全文（第 6 节） |
| Ctrl+O | 任意 | 折叠或展开正在显示的思考 |
| Ctrl+C | AWAITING_INPUT 或草稿 | 清空输入；2 秒内连按两次则 `shutdown` |
| Ctrl+C | RUNNING | 暂停（`pauseRun`）；再按一次为中止 |

`/fork`、`/undo`、`/diff`，`/continue`、`/steer` 与 Alt+Enter（运行中插话，M2Design 第 4.5 节）、`/timeline`、`/compact`（只在 AWAITING_INPUT 时可用）已实现；`/run` 尚未做（M2ReleasePlan）。

### 5.4 暂停、继续、中止、插话与询问

设计以 M2Design 第 4.3–4.5、11 节为准。界面只发出请求，状态以 `RunStateChanged` 为准，不自己推断。

| 输入 | 状态 | 效果 |
|---|---|---|
| Ctrl+C | RUNNING | `pauseRun`；退出用 `/exit` |
| Ctrl+C | PAUSING、PAUSED | `interruptRun`（中止） |
| Ctrl+C | INTERRUPTING | 忽略（已在中止） |
| Ctrl+C | AWAITING_INPUT 或草稿 | 清空输入；2 秒内连按两次则 `shutdown` |
| `/continue [@任务名] [说明]` | PAUSED | `resumeRun`；有说明时带 `steer`（`targetAgentRunId` 由 `@任务名` 解析，缺省为 main）；没有 main 且没有指定目标时要求选择 |
| 普通消息 | PAUSED | 同 `/continue <消息>`：继续并附加说明 |
| `/steer [@任务名] <说明>`，或 Alt+Enter 发送输入框中的消息 | RUNNING | `steerRun`；不暂停、不打断；界面显示"已插入，下一轮可见"，目标正在等派发的调用时改为"在它收到结果后可见" |
| `/steer`、`/continue` | 其余状态 | 提示当前不可用（RUNNING 以外不能插话，PAUSED 以外不能继续） |
| 普通消息（Enter） | RUNNING、PAUSING | 排队（第 5.2 节，缺省行为不变） |

- **`@任务名`**：由最近的 `ActivityEvent` 得出（`label` 的任务名部分与 `agentRunId` 的对应）；匹配不到或有歧义时提示，不猜测。
- **排队的消息**：中止（进入 AWAITING_INPUT）时不自动提交，依次放回输入框（第 5.2 节已写，现在生效）。Kernel 与 Workflow 不知道排队。
- **局部询问**（`HumanRequest` 的种类为 `ask`、`confirm`、`review`）：和授权询问共用待处理队列、一次一项、样式不同（第 5.1 节）；行首标明来自哪个 Agent 与任务名。
  - 字段按类型渲染：文本、多行文本（`\` 加 Enter 换行）、单选与多选（方向键与空格）、确认（`y`/`n`）；
  - `review` 先经 `readArtifact` 展示要审阅的产物（过长只展示开头并注明），再给出同意与修改意见（文本）；
  - 提交前按 `fields` 逐个字段检查（类型、选项编号），不符合时留在原处并提示，不发送；这是唯一的检查（Workflow 不读答复正文）；答复是这些字段的 JSON，没有字段时是一段文字；
  - 询问不超时，不显示期限；运行被中止时收到 `HumanResolved(CANCELLED)`，询问消失并在记录区写明"已取消"；
  - 暂停期间可以回答，答复在继续后生效，界面注明。
- **活动区**：`ActivityPhase` 增加 `AWAITING_ANSWER`（"等待你的回答"）与 `PAUSED`（"已暂停"）；`RunStateChanged` 为 PAUSING 时显示"暂停中…"，PAUSED 时显示"已暂停，/continue 继续，Ctrl+C 中止"，INTERRUPTING 时显示"正在中止…"。暂停期间计时器冻结。
- **`mas run`**（一次性命令，第 7 节）：Ctrl+C 同样先暂停、再按中止；退出码沿用第 7 节的表（中止 130，超时 2，内存压力 75）。
- 测试：组件测试（两类请求样式不同、按键在各状态下的效果、`@任务名` 解析、字段渲染与提交前检查、排队消息在中止时放回）；`human-in-loop-exit` 的 H1、H2、H4、H11、H12、H13。

## 6. 界面

| 区域 | 内容 |
|---|---|
| 记录区 | 用户输入、`reply`、运行结果、已完成步骤的折叠行（如 `✓ read_file src/a.ts 0.3s`）、授权与人类请求的处理结果、折叠过的思考（一行）；以 Ink 的静态区域输出，写出后不再改动 |
| 末尾一段 | 展开着的思考块，和它们之间、之后的记录，按发生的先后顺序；可以改动，满足条件才进入记录区（[Phase1Console](../Phase1Console.md) 4.3） |
| 活动区 | 每个 ACTIVE 的 AgentRun 一行：阶段与计时（每秒刷新；等待使用者的阶段不计时）；正在执行的工具作为子行；每一行固定一行，放不下就截断 |
| 正在输出回答 | 模型正在写给使用者的答案：活动区里的一行 `· main 正在输出回答 3s`（灰色，带计时）；文字本身不显示，消息发布时整条进入记录区，这一行随之消失 |
| 询问、排队、状态、输入框 | 当前的授权询问或问题、排队数、状态行、输入框（带光标，真实光标放在输入位置）；状态行在输入框上方，输入框是最后一行 |

- 阶段名称由 `ActivityPhase` 映射：`组织上下文`、`思考中`、`重试中（第 n 次，x 秒后）`（按 `retry.retryAt` 每秒倒计时）、`调用 <工具> <参数摘要>`、`等待授权`、`排队`、`收尾`、`正在压缩上下文`。模型正在写给使用者的回复时，这个 Agent 的活动行是 `正在输出回答`；正在写其他工具的调用时是 `正在生成 <工具名> <文件名>`（文件名在参数写完整后补上），都带计时，同一个 Agent 只有这一行。`/compact` 被受理后，活动区立刻出现一行 `· 系统 正在压缩上下文 3s`（带计时），压缩完成（历史里记一行步骤）或失败（提示原因）时这一行消失。
- 授权询问：`workspace.write` 展示可写根目录，选项为允许与拒绝；写 `AGENTS.md` 以警示样式展示路径与确切内容，选项为单次允许与拒绝。
- 回退：`/undo`、`/undo all` 只在等待输入时可用；有外部修改时列出文件，并说明被覆盖的内容保留在快照中，`y` 强制、`n` 取消，其他任何输入都按取消处理并照常发送；`/diff [N]` 打印差异；`/fork` 进入草稿，发送第一条提示词时以 `mode: 'FORK'` 新建。
- SubAgent：`ActivityEvent.parentAgentRunId` 让控制台把 SubAgent 画成树（`├─`、`└─`，缩进两格），行首是 Agent 与任务名（如 `worker fix-api`）；调用了 `run_subagents` 的 AgentRun 显示 `等待子任务`（Kernel 受理委派时发出）。还没有开始的任务（在等依赖）Kernel 并不认识，所以没有行。`/timeline` 把本次运行见到的每个 AgentRun 的起止时间按父子关系列出（只记在控制台内存中，换到新的 WorkflowRun 时清空）。
- ActivityEvent 带 `todos` 时，该 AgentRun 的行末显示"3/7 · <进行中的一项>"。
- 工具结果被截断时（`ActivityEvent.unit` 在 `DONE` 时带 `fullRef`），折叠行注明"输出已截断"及编号；`/output <编号>` 经 `readArtifact` 读取完整输出，已过期（`ARTIFACT_EXPIRED`）时显示"完整输出已在 7 天后删除"。
- 压缩：`ContextCompacted` 和工具调用一样，在它发生的位置记一行步骤（灰色）"✓ 已压缩较早的对话（N 个 Turn，修剪 M 个工具结果）"，只修剪工具结果时是"✓ 已修剪 N 个较大的工具结果"；它是历史里的一行，不是系统提示，不常驻显示区；空闲时的预先压缩同样记一行；`CompactionFailed` 显示原因。
- 思考内容流式显示，回复不流式（只显示"正在输出回答"和计时，发布时整条进入记录）：Kernel 核心把 `kernel.control.ModelStream`（`REASONING`、`ANSWER`、`END`）经 Fabric 的 `inbox.user-interaction-stream` 发来，这条旁路不是有序事件，没有序号、不进日志、来不及送达就丢；控制台在进程内存里按块保存思考（单段 64 KB、最近 100 段，切换 Session 或退出即清空）；展开着的块放在末尾一段里，和它们之间、之后的授权、步骤、回复按发生的先后顺序排，画面只用限额的 90%：放不下就把最老的块整块折叠进记录（折了不再展开），最新的块自己就太长才省略开头用 … 代替；折叠过的块在记录里是一行（[Phase1Console](../Phase1Console.md) 第 4 节）。非 TTY 环境退化为逐行日志；遵守 `NO_COLOR`。
- 授权询问里超过 3 行或 240 个字符的命令只显示开头，输入 `v` 查看完整命令（不算回答）。用户输入是荧光绿，系统层面的一切（系统的话、授权与询问、排队提示）是浅黄（`#F9F1A5`），输入框上方的状态行是粉色并写成 `------ 运行中 ------`，仓库的对话列表是灰色，助手回复是深蓝，思考、步骤与活动行是灰色。启动时的话是"欢迎使用 MultiAgentOS，输入问题后按 Enter 开始；/help 查看指令。"
- 展示文本中的控制字符按 M1 的规则转义。

## 7. `mas run`

```text
startRun({ template, goal }) → SessionOpened → 运行
  授权询问照常进入待处理队列
RunFinished → 展示运行结果（analyze 为报告）→ shutdown → 进程退出
```

| closeReason | 退出码 |
|---|---|
| `COMPLETED`、`BUDGET`（有报告） | 0 |
| `FAILED` | 1 |
| `TIMEOUT` | 2 |
| `VIOLATION` | 3 |
| `CANCELLED`、`SHUTDOWN`、`ENDED_BY_USER` | 130 |

`BUDGET` 与 M1 的降级报告一样以 0 退出，展示时标明因额度结束及未完成的工作。

## 8. 关闭

- `/exit` 或两次 Ctrl+C：`shutdown`；Kernel 收敛当前运行、关闭当前 Session 后再关闭系统（[ModuleHost](../Infrastructure/ModuleHost.md) 第 4 节）。
- `stop()` 先处理完 Inbox 中剩余的事件，保证 `RunFinished` 与 `SessionClosed` 被展示（M1 第 6 节的规则）。
- 交互式模式正常退出的退出码为 0；进程最终的退出码由组合根决定。

## 9. 不变量与测试

| 要求 | 测试 |
|---|---|
| 不保存任何 Session 信息（M2Design 第 2.4 节） | 架构测试：UserInteraction 不持有 Persistence 的 Port；重启后 Session 列表只来自 Kernel |
| 13：用户输入只经 Kernel 交给 Workflow | 单元测试：提交的每条消息都带 `inputId`，重复提交被去重 |
| 授权与人类请求不混淆 | 组件测试：两类请求在队列中样式不同；`ask_user` 的同意不会提交授权回答 |
| 界面 | Ink 组件测试：活动区刷新、静态记录区不重绘、非 TTY 退化为逐行输出 |
