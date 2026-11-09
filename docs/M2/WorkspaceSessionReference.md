# Workspace 与 Session 的绑定：开源项目的做法（phase 1 参考）

> 状态：**只是参考资料，没有任何决定**。本文不改变 M2 当前设计，供 phase 1 做"授权与工作区"（RP1 中放在最后的一项，见 [M2ReleasePlan](M2ReleasePlan.md)、[Phase1Console](Phase1Console.md)）时对照。
> 来源：`E:\OpenSourceStructure` 中 OpenCode 与 DeepSeek Harness 的源码（路径均相对各自的 `upstream/packages`）。Claude Code 的源码不在其中，**本文不写它的实现**。

## 1. M2 现状（对照基准）

| 项 | 现状 |
|---|---|
| workspace 怎么定 | 启动命令的 `--repo <path>`，缺省为当前目录；`apps/control-plane/src/index.ts` 解析成 realpath，作为进程级 `repositoryRoot` 交给组合根 |
| 模式 | `--readonly` → `readonly` 预设（不装配 `workspace`：无写文件、无撤销）；否则 `standard`（装配文件、git、快照目录、影子文件） |
| Session 与仓库 | Session 是"一个仓库上的持续工作档案"（[M2Design](M2Design.md) 第 2 节）；`SESSION_STARTED` 记录 `repositoryRoot`；Kernel 的 Session 引用为 `sessionId → { repositoryRoot, status }`；Session 列表按 `repositoryRoot` 筛选（[Interface/Persistence](Interface/Persistence.md)） |
| 运行中能否切换 | 不能：一个进程一个仓库。因此模型不需要被告知"目录变了" |
| 已知限制 | 不同 `dataDir` 指向同一仓库时，工作区与快照没有保护（M2Design 限制清单） |
| 尚未核实 | 拿仓库 A 的 `sessionId` 在仓库 B 的进程里直接 OPEN，是否被明确拒绝（列表筛选能挡住正常操作，但没看到显式拒绝的代码） |

## 2. OpenCode

### 2.1 数据模型

- **Location**（`core/location.ts`）：`{ directory, workspaceID, project: { id, directory, canonical }, vcs }`。项目由目录解析得到（`project.resolve(directory)`）。
- 数据库里有 `project`、`project_directory`、`workspace`、`worktree` 表；`session` 表记录所属项目与目录。

### 2.2 作用域：会话全局，服务按目录

| 作用域 | 内容 |
|---|---|
| Global（进程一份） | `Database`、`Bus`、`SessionStore`、`SessionExecution` 等：会话的持久状态 |
| Location（每个目录一份，首次访问时懒创建，空闲后关闭） | `Config`、`Agent`、`Tool`、`Permission`、`Snapshot`、`SessionRunner`、`Model`、`Provider`、插件 |

`SessionExecution` 执行会话时，先查出会话所属目录，再"进入"该目录的 Location 服务图（`instances.provide(session)`）。所以同一个 Session 能在目录之间移动（事件 `session.moved`），而配置、工具、权限、快照总是跟着当前目录。

### 2.3 让模型知道目录

1. **环境块**（`instructions/builtins.ts`，指令条目 `core/environment`）：`Working directory`、`Workspace root folder`、是否 git 仓库、平台。条目有 `initial` 与 `changed` 两种渲染：内容变了就以"变化"的形式重新给出。
2. **切换消息**（`session/runner/to-llm-message.ts`，消息类型 `location-switched`）：对话里补一条用户消息 `The working directory has been changed to <目录>.`。压缩用的近期文本（`session/recent-text.ts`）也保留这条。
3. **模型主动切换**：工具 `session_move`（`tool/plugin/opencode.ts`）；提示模型"创建了 worktree 并要把它当主目录时"调用。

### 2.4 值得注意的点

- 压缩摘要的提示要求列出"当前工作目录之外、续做需要打开的文件和目录"（`session/compaction.ts`），即压缩时显式处理跨目录的路径。
- 权限规则（用户选"总是允许"）存在 `permission` 表，跨会话有效；M2 现在是每个 WorkflowRun 重新询问（见 M2Design 限制清单第 6 项）。

## 3. DeepSeek Harness

### 3.1 两层概念

| 层 | 含义 |
|---|---|
| **Workspace**（`api/workspace-controller`） | 用户级对象，有 `workspaceId` 与 `path`；Session 可以"加入"某个 Workspace，也能归档、置顶、排序 |
| **Session 的 `cwd`**（会话头） | 创建时确定，**不可变**，记录原始项目目录 |

创建 Session（`api/session-controller/src/commands.ts`）：`workspaceId` 与 `cwd` **二选一**，同时给就报错；都不给用默认目录（`defaultCwd`，缺省为启动目录）。Fork 会沿用来源 Session 头里的 `cwd`。

### 3.2 有效工作目录是日志里的状态

- 会话事件 `working-directory/change { cwd }`（`session/working-directory`），只进日志；投影 `workingDirectory` 的初值为会话头的 `cwd`，之后按该事件折叠。
- `get(session)` 不做文件 I/O，直接读投影。
- `set(agent, path)`：校验目标是已存在的目录，再提交事件；**已在运行的 shell 与进程保持自己的目录和权限不变**。
- `ensure(agent)`：每次组装系统提示前校验当前目录仍存在；不存在则**退回会话头里的原始目录**并提交切换记录；原始目录也不可用才报错。

### 3.3 让模型知道目录

- 系统提示里有必需的上下文块 `working-directory:current`（`order: WORKING_DIRECTORY`），**每次组装时按当前有效目录重写**，不依赖历史消息。
- 切换时另提交一条面向模型的切换通知消息（消息来源类型 `working-directory`，带持久化归属标记）。
- 模型工具 `working_directory`（`session/tool-working-directory`）：不带参数读取当前目录，带 `cd` 切换；说明里明确"已存在的 shell 与进程保留自己的目录"。

### 3.4 值得注意的点

- 会话文件根目录在构造时一次性解析，避免 `process.cwd()` 变化把同一后端的会话文件散到不同位置（`session-persistence-jsonl`）。
- 启动环境（`util/launch-environment`）被固化，之后的 `chdir`、workspace 切换或恢复的会话看到的是同一份。

## 4. 对照

| | M2（现状） | OpenCode | DeepSeek Harness |
|---|---|---|---|
| Session 归属 | 一个仓库（进程级固定） | 项目 + 目录，可移动 | 会话头 `cwd` 不可变；可加入用户级 Workspace |
| 运行中换目录 | 不支持 | 支持（`session.moved`、`session_move` 工具） | 支持（`working_directory` 工具，事件 `working-directory/change`） |
| 有效目录存在哪 | `repositoryRoot`（配置/进程） | 会话表里的目录 + Location 服务图 | 日志事件折叠出的投影 |
| 服务随目录变化 | 不变 | 工具、权限、快照、配置按目录重建 | 权限与沙箱按调用会话的 cwd 判定（`config-catalog` 中沙箱的"每个会话的 mode 与 cwd"） |
| 模型如何感知 | 无需 | 环境块"变化"渲染 + 切换消息 | 每次组装重写目录块 + 切换通知 |
| 目录消失 | — | 未核实 | 自动退回原始目录并记录 |
| 压缩时 | — | 摘要要求列出目录外的关键路径 | 未核实 |

## 5. 如果将来允许换目录：需要回答的问题（不是决定）

1. **绑定粒度**：Session 绑定一个仓库（现状）、绑定一个仓库加可变的子目录（OpenCode 式移动，或 DeepSeek 的"不可变原始目录 + 有效目录"），还是引入独立的用户级 Workspace 对象。
2. **有效目录放在哪**：作为 Session 日志里的事件（可重放、可 fork，DeepSeek 式），还是 Kernel 持有的当前值。M2 的日志是 Workflow 的、Kernel 审计是另一份，需要先定归属。
3. **模型感知**：两个项目都用了两件事：每次请求重写的环境信息，加一条进入对话的切换通知。对照 M2 的上下文组装，要决定环境块放在哪一层、是否随压缩保留。
4. **权限与沙箱随目录**：授权、沙箱根、信任记录（`(repositoryRoot, path, sha256)`）、快照与撤销都以 `repositoryRoot` 为键，换目录后哪些沿用、哪些失效。
5. **正在运行的东西**：已启动的命令和进程不随目录变（两个项目一致）。
6. **目录不可用**：退回原始目录，还是报错。
7. **跨仓库 OPEN 的显式拒绝**：现状中尚未核实，无论是否支持换目录都应先确认。
8. **只读预设**：`readonly` 下换目录是否允许。

## 6. 未覆盖

- Claude Code 的实现（源码不在参考目录中）。
- OpenCode 的 `session_move` 在服务端对权限、快照的具体处理，以及 DeepSeek Harness 在压缩时对目录信息的处理，本文没有读到对应代码。
