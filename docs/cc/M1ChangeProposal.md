# M1 设计修改建议（讨论稿）

> 文档类型：对 `feat/M1` 现行文档的修改提案  
> 依据：`TargetM1.md`、`M1AchievePlan.md`、`M1Process.md`、`M1RequirementsSpecification.md`（`feat/M1`，提交 `392a3b5`），以及 2026-09-20 会议记录  
> 原则：以 `feat/M1` 为唯一权威，只做“必要的改”，不推翻 M1 的产品范围和五模块划分  
> 作者：Claude（Cowork），应 meti 的请求撰写  
> 状态：待三人评审；通过后由各模块负责人同步修改对应文档  
> 配套文档：`MeetingMinutes-2026-09-20-annotated.md`（会议记录）、`InterviewDrivenDesign.md`（从面试要求反推架构）。本文第 5 节的补充即来自后者。

## 0 先说不改什么

以下内容保持不变，它们是 M1 已经做对的部分：

- **产品范围**：M1 仍是本地、单用户、单 Agent 的只读 Repository Analysis Agent。它风险低、能在 11 月 1 日前完成，而且正好是检验 ContextEngine 的最佳场景。
- **五个 Module 的划分和调用方向**：所有模型与工具调用都经过 Kernel；Workflow 不直连 ContextEngine。
- **只读安全边界**：路径守卫，拒绝写入、命令和测试，运行前后仓库不变。
- **工程纪律**：TypeBox 运行时校验、质量门、没有测试证据不算完成、固定任务集。
- **技术栈**：Node.js、TypeScript、pnpm、TypeBox、AI SDK、Vitest、ripgrep。

需要修改的是五个方面：**排期与分工、任务顺序、ContextEngine 的定位、Workflow 结构与评测、M1 之后的路线**。

## 1 排期与分工：按真实投入重排

### 1.1 现状

`M1AchievePlan.md` 假设“3 人 × 每周 20 小时 × 4 周 = 240 人时”，三人平均分工。会上确认的实际情况是：

| 成员 | 模块 | 每周可投入 | 截至 11 月 1 日约可投入 |
|---|---|---|---|
| Cary | Workflow、总体架构、协助 Context | 约 49 小时 | 约 250 小时 |
| 田园 | Kernel | 约 12 小时（10–20） | 约 60 小时 |
| meti | ContextEngine | 约 20 小时 | 约 100 小时 |

### 1.2 建议

1. **收窄 Kernel 在 M1 的范围**，控制在约 60 小时内能完成：
   - 保留：Unit 准入（schema 与路径守卫）、FILE_READ 执行器、模型调用适配器、结构化 UnitResult 与错误分类。
   - 转给 Cary：KernelControlPort 的用户意图准入、RuntimeProjection。它们与 Workflow 耦合更紧，Cary 的时间也更充裕。
   - 推迟到 M2：审计之外的执行监管、资源调度、中断与异常的完整机制。
2. **时间最充裕的成员，建议优先投入“让系统真正跑起来”的工作**（第一次真实模型调用、端到端联调、评测运行），协议与基础设施的扩充放在其后。
3. **每个模块至少有一位非负责人能读懂**：每周会议上，每人用 10 分钟讲解本周代码。

## 2 任务顺序：第一周就调用真实模型

### 2.1 现状

按 `M1Process.md`，第一次真实模型调用（S2）之前，要先完成 S0 与 S1 共 26 项工程和协议任务。

### 2.2 问题

模型的实际行为（会不会调错工具、会不会编造文件路径、会不会原地打转）会反过来决定很多设计。越晚看到真实行为，已经写好的抽象越可能需要返工。

### 2.3 建议：先做一条“丑但真实”的端到端线路

第一周结束时，必须用**真实模型**完成一次最简单的分析任务，哪怕很多环节只是最小实现：

```text
CLI → UserInteraction → Kernel → Workflow → MODEL Unit（DeepSeek）
    → SEARCH（ContextEngine）/ READ（Kernel FILE_READ）→ 结果回到 Workflow → FINAL → 报告
```

对应的任务调整：

| 调整 | 任务 ID |
|---|---|
| **提前到第 1 周** | S2-01（AnalysisAction）、S2-02（真实 Provider）、S2-04（MODEL Unit）、S2-07（单轮 reducer）、S4-01（F1–F5 fixture） |
| **推迟到 M2 待办** | S0-07（兼容性矩阵）、S4-06（兼容性矩阵）、S3-07（全步骤身份链贯穿）、S4-05 中“所有 Port 的 adapter 替换测试”（只保留 Workflow、Kernel、ContextEngine 三个） |
| **简化** | S0-08 架构规则只保留“禁止跨模块导入内部目录”一条；S1-07 WorkSession 只做内存对象加 JSON 落盘；S1-08 RuntimeProjection 只输出当前状态与步骤列表；S5-01 追踪矩阵改为验收清单 |

相应修改 `TargetM1.md` §11.2 的完成定义：

- 第 7 条“五个 Module 均有 contract test”改为：Workflow、Kernel、ContextEngine 有 contract test，UserInteraction 与 AgentToolPool 有冒烟测试。
- 第 9 条“五项 Infrastructure 均有替换测试”改为：有默认 adapter 和装配位即可，替换测试推迟。

理由：这些协议兼容性与替换测试针对的是“多版本、多消费者”的场景，而 M1 的 v0 协议目前没有任何外部使用者。

### 2.4 Envelope 与 BoundaryContext 的精简

在同一进程的同步调用中，只要求携带 `correlationId`、`workflowRunId`、`deadline` 三个字段。`tenantId`、`projectId`、`idempotencyKey`、`expectedVersion`、`traceparent` 等字段保留在 schema 中但设为可选，M1 不要求校验和记录。等 M2 引入持久化时，再按需要改为必填。

## 3 ContextEngine 的定位：从“推送检索包”改为“搜索后端 + 上下文窗口管理”

这是本提案最重要的一项修改，也是落实会议共识“上下文管理是项目最主要的任务”。

### 3.1 现状

`TargetM1.md` §6.1 中，ContextEngine 只有一个操作 `buildContext`：根据 objective 和 query 检索内容，生成 ContextPack。现有代码对仓库里每个文件做关键词计数，把整个文件塞进 Pack。

与此同时，“Observation 历史与压缩”（S3-01）分配给了 Workflow，而“最终发给模型的输入如何组装”没有明确归属。

### 3.2 问题

- 主流 coding agent（Claude Code、Codex）都不在调用前预先检索好内容推给模型，而是让模型**自己搜索**（agentic search），边搜边看、边调整查询。预先检索容易拿错东西。
- 真正决定 Agent 表现的，是模型每一轮看到的完整输入：系统提示词、工具定义、历史观察、状态信息怎么排列，超长时怎么裁剪。目前这件事没有明确的负责模块。

### 3.3 建议：Context Unit 分三种操作

保持“Workflow → CONTEXT UnitIntent → Kernel → ContextEngine”的调用线路不变，只在 `ContextRequest` 中增加 `operation` 字段：

| 操作 | 何时调用 | 输入 | 输出 |
|---|---|---|---|
| `ORIENT` | 每次运行开始时调用一次 | objective、workspace | 仓库概览 Pack：目录树摘要、AGENTS.md 项目记忆、README 摘要、主要文件的关键符号 |
| `SEARCH` | 模型发出 SEARCH 动作时 | query、已给过的 item 摘要 | 排序后的命中片段：路径、行范围、上下文几行、命中原因 |
| `ASSEMBLE` | 每次调用模型之前 | 本次运行的步骤历史引用、token 预算 | 本轮模型输入：稳定前缀在前，历史观察按规则截断或压缩，末尾附状态栏 |

READ（按路径和行范围读文件）仍由 Kernel 的 FILE_READ 负责，保持现有分工。

**S3-01 的归属调整**：Workflow 拥有步骤历史这一**事实**（记录每一步做了什么）；ContextEngine 负责把历史变成**模型输入**（如何呈现、如何压缩）。这样职责清晰，也避免 Workflow 和 ContextEngine 各写一套压缩逻辑。

### 3.4 ContextPack schema 补充

当前 `packages/contracts/src/schemas.ts` 中的 ContextItem 只有 `path`、`startLine`、`endLine`、`content`、`reason`。建议补充：

| 字段 | 位置 | 用途 |
|---|---|---|
| `kind` | ContextItem | 区分 `TREE`、`MEMORY`、`SEARCH_HIT`、`OBSERVATION`、`STATUS` |
| `tokenCount` | ContextItem | 精确预算与评测统计 |
| `contentSha256` | ContextItem | 去重、验证来源 |
| `requestId`、`operation` | ContextPack | 追溯是哪一次请求产生的 |
| `truncated`、`droppedCount` | ContextPack | 标明是否因预算丢弃了候选，供诊断使用 |

### 3.5 M1 的实现要点

- **检索**：rg 文本检索、文件名匹配、用正则近似“符号名”检索（例如 `function\s+name`、`class\s+name`），按函数或段落分块，不再整文件返回。tree-sitter 推迟到 M2。
- **稳定前缀**：系统提示词和工具定义的内容与顺序固定，变化的内容一律放在末尾。DeepSeek 对缓存命中的输入价格极低，这条规则直接影响成本。
- **项目记忆**：读取仓库根目录的 `AGENTS.md`（没有就跳过）。这是会上提出的“Session 间通信”的最小可行形态。
- **计量**：每次模型调用记录输入 token、缓存命中 token、输出 token，写入最终报告。

## 4 评测：第一周就建好，由 ContextEngine 负责

### 4.1 现状

固定任务集 F1–F5 位于第 4 周（S4-01、S4-02），而且只要求“到达终态并记录成功率”。

### 4.2 建议

1. **第 1 周**就建好 F1–F5，每个任务包含：
   - 初始仓库；
   - 任务描述，不能泄露答案文件名；
   - `expected.json`：期望引用的文件与行范围、必须出现的关键结论。
2. **自动评分**：
   - 来源召回率：报告引用了多少期望来源；
   - 来源准确率：报告的引用中有多少确实相关；
   - 关键结论命中数；
   - 步数、token、缓存命中率、成本、耗时。
3. **每次合并前跑一遍**，结果写入 `eval/results/`。批量评测避开 DeepSeek 的高峰时段（新西兰时间工作日 13:00–16:00、18:00–22:00，夏令时后各推后一小时），成本减半。
4. 第 3 周把任务数扩充到 10 个，其中至少 1 个是**故意设计的歧义任务**，检查 Agent 会不会乱猜（见第 5.2 节）。
5. **bad case 回归集**：每个失败过的任务都永久保留在回归集中，修好之后继续每次运行。否则问题一旦消失，就再也无法证明它是被哪个改动修好的。
6. **多次运行取平均**：模型输出有随机性，同一任务至少运行 3 次，报告平均值与波动，避免把运气当成提升。
7. **开关对照**：每个上下文策略（仓库概览、历史压缩、状态栏等）都可以单独关闭，“开”和“关”各跑一遍，用差值说明它的效果。

评测放在 ContextEngine 这边，是因为检索和上下文策略的每一次改动，都需要用这些数字来证明效果。

## 5 Workflow 结构、Agent 动作与可追溯性

以下三点来自对 Agent 岗位面试要求的分析（详见 `InterviewDrivenDesign.md`），同时也能直接提升 M1 的质量。

### 5.1 Workflow 采用“固定阶段 + 阶段内自主”

Workflow 用代码固定几个阶段，每个阶段内部由 Agent 自主决定具体动作，阶段之间设确定性的检查关卡：

```text
理解任务 → 定位代码 → 形成结论 → 核对来源 → 生成报告
   └──────── 每个阶段内：Agent 自己决定搜什么、读哪里 ────────┘
关卡（代码判定）：步数与 token 预算、结论是否都有来源、引用是否与原文一致
```

这样既保留了 Workflow 对流程的控制，又让模型在局部灵活发挥；出了问题也能定位到具体阶段。M1 可以先只实现“探索”和“核对并报告”两个阶段，之后再细分。

### 5.2 AnalysisAction 增加“澄清”与“无法确定”

在现有的 QUERY / SEARCH / READ / FINAL 之外，增加两个动作：

- `ASK_USER`：任务描述有歧义时向用户提问。M1 的运行中途不需要用户操作，因此可以先记录为“待澄清问题”写入报告，并结束运行。
- `CANNOT_DETERMINE`：证据不足时明确说明无法确定，列出已查过的地方，而不是编造结论。

M1 报告中已有的“未确认项”方向正确，这两个动作让它成为 Agent 的显式选择，也便于评测统计。

### 5.3 从第一周起完整记录 trace

每次运行的每一步都写入 `.multiagent/runs/<run-id>/steps.jsonl`：本轮模型输入的引用、模型原始输出、解析出的动作、工具调用参数与结果、token 与耗时。要求任意一次运行都能完整回放。这是分析失败原因、比较不同策略的基础；`TargetM1.md` §9 已规划了这个目录，这里只是强调它必须在第一周就可用，并且内容完整。

## 6 模型选择

- 主力模型：DeepSeek V4.1-Flash（`deepseek-flash`），经 AI SDK 的 OpenAI 兼容接口接入。
- 对照模型：DeepSeek V4-Pro，只在评测时用，比较模型能力对成功率的影响。
- 模型适配器只写 OpenAI 兼容这一种，更换模型只改配置。
- 以一次 20 步的分析任务估算，成本约 2–3 美分；5 个任务各跑 3 次也不到 0.5 美元。
- 价格依据 DeepSeek 官方价格页（2026 年 9 月），接入前以官网为准。

## 7 M1 之后的路线调整

### 7.1 M2 只做 Coding Agent

`AchievePlan.md` 中的 M2 同时包含 Coding Agent、PostgreSQL、DBOS、Outbox/Inbox、故障恢复与 Fastify API，工作量是 M1 的数倍。建议：

- **M2 = 原 M2-A**：安全的单 Coding Agent。包括写文件、执行命令和测试（均需用户确认）、git worktree 隔离、命令在 Docker 容器内执行、从会话日志恢复。
- **原 M2-B/C/D**（PostgreSQL、DBOS、Outbox/Inbox、故障注入、Fastify）移入“候选机制清单”，出现真实需求或失败案例时再按最小形态引入。

### 7.2 并行不依赖持久化

多 Agent 并行（原 M3）真正的前置条件只有两个：一个好用的单 Agent，以及 worktree 隔离。它不需要 PostgreSQL 和 DBOS，可以在 M2 之后直接开始。

### 7.3 隔离方案

执行命令放进容器（只挂载工作区、默认禁网），鉴权决策留在 Kernel 进程内。详见会议记录议题 15、16。

## 8 需要同步修改的文档

| 文档 | 修改内容 | 建议负责人 |
|---|---|---|
| `M1AchievePlan.md` | 按实际投入重排分工与人时；任务顺序按第 2 节调整 | Cary |
| `M1Process.md` | 调整任务顺序，标记推迟与简化项 | Cary |
| `TargetM1.md` §6.1、§11.2 | ContextRequest 增加 `operation`；完成定义第 7、9 条按第 2.3 节修改 | meti 、Cary |
| `packages/contracts` | ContextItem 与 ContextPack 字段补充；BoundaryContext 可选字段 | meti 提案，三人评审 |
| `M1RequirementsSpecification.md` | FR-CTX 增加 ORIENT、SEARCH、ASSEMBLE 三类需求；新增评测需求（回归集、多次运行、开关对照） | meti |
| `TargetM1.md` §5、§7 | Workflow 的阶段划分；AnalysisAction 增加 `ASK_USER`、`CANNOT_DETERMINE` | Cary |
| `AchievePlan.md` | M2 收窄为 Coding Agent；原 M2-B/C/D 移入候选清单 | Cary |
| 新增 `docs/Glossary.md` | 统一关键术语：权限、隔离、Session、checkpoint、任务树等 | 全体 |
| 新增 `docs/decisions/` | 每个重要技术选型一份短记录：选了什么、考虑过哪些替代方案、为什么、什么情况下会切换 | 各模块负责人 |

## 9 需要三人决定的问题

1. 是否同意第一周就接入真实模型，并按第 2.3 节调整任务顺序？
2. 是否同意 ContextEngine 按第 3 节重新定位，包括 S3-01 的归属调整？
3. 是否同意第 2.3 节的推迟与简化清单？
4. 是否同意 M2 收窄为 Coding Agent，并把 PostgreSQL 与 DBOS 移入候选清单？
5. 是否同意第 5 节的 Workflow 阶段结构、两个新动作和 trace 要求？
6. 是否同意第 4.2 节的评测要求，由 meti 负责评测体系？
