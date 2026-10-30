# MultiAgentOS M2 UserInteraction

> 状态：草稿（阶段 1）。

## 1. 定位

UserInteraction 是用户与系统交互的边界：收集用户意图与原始审核响应，展示 Kernel 交来的内容。它**不保存任何 Session 信息**
（M2Design 第 2.4 节），界面上的 Session 列表、标题、Fork 关系都来自 Kernel 的事件。
请求与事件的字段见 [Interface/InteractionKernel](../Interface/InteractionKernel.md)，界面设计以 [M2Design](../M2Design.md) 第 11 节为准，
长期规划见 [UserInteraction 架构](../../Architecture/Module/UserInteraction.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 | 阶段 |
|---|---|---|---|
| `multiagentos analyze --repo <路径> "<目标>"`：一次输入、一次报告，展示完即关闭 | `mas`：交互式对话，进程绑定一个仓库，可以新建、打开、切换 Session；`mas run <模板> "<目标>"`：一次运行后退出 | M2Design 第 2.3 节 | 1 |
| 逐行输出（readline） | 三个区域的终端界面（Ink）：记录区、活动区、输入区 | M2Design 第 11.1 节、M2TechStack 第 4 节 | 1 |
| 只有授权询问 | 授权询问与人类请求排成同一个队列，一次处理一项，每项标明来源 | M2Design 第 4.1 节 | 1 |
| Ctrl+C 取消运行 | 阶段 1：运行中两次 Ctrl+C 退出；阶段 5 起 Ctrl+C 为暂停、再按为中止 | M2Design 第 11.2 节 | 1、5 |
| 展示 AnalysisReport | 展示 `reply`、运行结果与 `analyze` 的报告；报告的展示规则沿用 M1 | — | 1 |

报告的展示、控制字符的转义、`InteractionMessages` 文案表、自身错误的捕获边界与 M1 相同，见归档的
[M1 UserInteraction](../../History/M1/Module/UserInteraction.md) 第 5、6.1 节。

## 3. 职责

- 进入 Kernel 的唯一途径是 `InteractionGatewayPort`；实现运行级、Session 级与系统级三种事件的 Inbox，按各自的序列逐条处理。
- 终端的全部要求由 `TerminalPort` 表达；`apps/cli` 以 Ink 实现展示，UserInteraction 不依赖 Ink。
- 分配 `requestId` 与 `inputId`；保存的只有界面偏好、草稿与输入历史（↑/↓）。
- 不直接访问 ArtifactStore、Persistence 或 Workflow；正文经 `readArtifact` 读取。

## 4. 命令

```text
mas [--repo <路径>] [--readonly]                    交互式；仓库缺省为当前工作目录
mas run [--repo <路径>] [--readonly] <模板> "<目标>"   阶段 1 只接受内置模板 analyze
```

- 仓库路径由组合根取 realpath 后写入 Kernel 的配置（M2Design 第 2.3 节 Session 第 0 条）；UserInteraction 不传仓库路径。
- `--readonly` 设置启动预设（M2Design 第 5.2 节）。
- 参数错误返回 64（M1 的规则）。

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
AWAITING_INPUT 时输入普通消息 → answerHuman(prompt)
RunFinished → 记录区显示结束说明；若运行因额度结束，提示用户确认是否在同一 Session 中继续：
  确认 → 对当前 Session 再次 openSession（Kernel 开启新的运行，不重新打开 Session）→ RunStateChanged(AWAITING_INPUT)
```

### 5.1 待处理队列

- 授权询问与人类请求按到达顺序排成一个队列，一次只处理一项；两类以不同样式显示，每项标明来自哪个 Agent（阶段 4 起还有任务名）。
- 授权询问的展示：
  - `repo.read`：仓库路径、排除规则、"读取的内容会发送至 <provider>"、回答期限（M1 原样）；
  - `project.instructions`：`AGENTS.md` 的全文（经 `readArtifact` 读取；`truncated` 时注明只展示开头）、"信任这份内容"与"不信任"两个选项。
- 回答只是原始响应：授权以 `AuthorizationResolved` 为准，人类请求以 `HumanResolved` 为准；拒绝或超时不视为同意。
- 询问的读取任务不阻塞 Inbox 的处理（M1 第 4 节的规则）。

### 5.2 指令与按键（阶段 1）

| 输入 | 状态 | 效果 |
|---|---|---|
| 普通消息 | AWAITING_INPUT 或草稿 | 提交为开放输入 |
| `/new` | 任意 | 进入新对话的草稿；提交第一条提示词时才创建 Session |
| `/sessions` | 任意 | `listSessions`，展示 `SessionList` |
| `/resume <id>` | 任意 | `openSession` |
| `/delete <id>` | 任意 | `deleteSession`；只能删除未打开的 Session，结果以 `SessionDeleted` 展示 |
| `/status` | 任意 | 当前运行状态与额度状态（来自最近的事件） |
| `/help`、`/exit` | 任意 | 帮助；`shutdown` |
| Enter、`\` 加 Enter、Esc、↑/↓ | 任意 | 发送、换行、清空输入、浏览输入历史 |
| Ctrl+C | AWAITING_INPUT 或草稿 | 清空输入；2 秒内连按两次则 `shutdown` |
| Ctrl+C | RUNNING | 阶段 1：提示"再按一次退出"，2 秒内再按则 `shutdown`（当前运行以 `SHUTDOWN` 收敛）；阶段 5 改为暂停 |

`/fork`、`/undo`、`/diff`（阶段 2），`/continue`（阶段 5），`/run`、`/timeline`、`/thinking`（阶段 4、7）在对应阶段加入。

## 6. 界面

| 区域 | 内容（阶段 1） |
|---|---|
| 记录区 | 用户输入、`reply`、运行结果、已完成步骤的折叠行（如 `✓ read_file src/a.ts 0.3s`）、授权与人类请求的处理结果；以 Ink 的静态区域输出，不重绘 |
| 活动区 | 每个 ACTIVE 的 AgentRun 一行：阶段、计时（每秒刷新）、转动指示（100 毫秒）；正在执行的工具作为子行 |
| 输入区 | 输入框与待处理队列 |

- 阶段名称由 `ActivityPhase` 映射：`组织上下文`、`思考中`、`调用 <工具> <参数摘要>`、`等待授权`、`排队`、`收尾`。
- 思考内容与回复都不流式显示。非 TTY 环境退化为逐行日志；遵守 `NO_COLOR`。
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
| 授权与人类请求不混淆 | 组件测试：两类请求在队列中样式不同；`ask_user` 的同意不会提交授权回答（阶段 5） |
| 界面 | Ink 组件测试：活动区刷新、静态记录区不重绘、非 TTY 退化为逐行输出 |

## 10. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–9 节 |
| 2 | 授权询问的各级选项、`/fork`、`/undo`（含外部修改时的强制确认）、`/diff`、打开 Session 时的工作区差异提示 |
| 3 | 命令询问的四个选项、警示样式、"未隔离"提示、停机提示 |
| 4 | SubAgent 树、`/timeline` |
| 5 | Ctrl+C 暂停与中止、`/continue`、`ask_user` 的问题与结构化字段 |
| 7 | `mas run` 的使用者模板、`/run` |
