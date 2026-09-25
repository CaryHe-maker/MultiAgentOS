# MultiAgentOS 从零重新规划（讨论稿）

> 文档类型：项目方向与分阶段路线建议  
> 作者：Claude（Cowork），应 meti 的请求撰写  
> 状态：背景材料，一个“如果从零开始会怎么做”的思想实验  
> 日期：2026-09-24

> **与当前提案的关系：** 本文写于看到 `feat/M1` 最新文档之前，当时假设可以完全从零规划。之后的 `M1ChangeProposal.md` 改为**在现有 M1 设计上做必要修改**，**凡与提案不一致之处，以提案为准**。主要差异：
>
> | 本文的设想 | 当前提案的做法 |
> |---|---|
> | 冻结大部分平台机制，改用普通模块 | 保留五模块划分和调用方向，只推迟兼容矩阵、替换测试等非必要项 |
> | 第一个阶段就做可写的 coding agent | M1 保留只读分析，M2 再做 Coding Agent |
> | 新的包结构（core、llm、tools 等） | 沿用 `feat/M1` 现有的包结构 |
>
> 本文仍然有参考价值的部分：第 2 节关于 Agent 本质、上下文工程、模型选择和评测先行的判断，第 6 节的评测体系设计，以及第 7 节的省钱方法。

## 0 一句话结论

**先做一个能真正改代码的单 Agent 命令行工具（一个“小号 Claude Code”），用评测集证明它在变好，最后再把“多 Agent 并行”作为差异化亮点加上去。** 现有设计里的 UnitIntent、Envelope、Module Host、Communication Fabric、Protocol Registry、MissionScope、GraphRevision、DBOS、PostgreSQL 等平台化机制，对一个三人、业余时间投入、目标是写进简历的项目来说，前期成本远大于收益，建议推迟到出现真实需求时再按最小形态引入。

## 1 先把目标说清楚

这个项目最终要写进简历、在面试里讲。面试官真正会看的是四件事：

1. **能不能跑起来。** 一段 3 分钟的演示：给它一个陌生小仓库和一个 bug 描述，它自己搜索、读代码、修改、跑测试、修好。
2. **有没有数字。** “在 30 个自建任务上通过率从 40% 提升到 70%，平均每题成本 2 美分”这种句子，比任何架构图都有说服力。
3. **每个人能不能讲清自己那块的深度。** 面试官会追问“为什么这样设计”“遇到过什么问题”“怎么验证的”。你自己没真正理解的抽象，在面试里是负资产。
4. **有没有一个亮点。** 对这个项目来说，亮点就是多 Agent 并行，外加“用便宜模型也能做得不错”的上下文工程。

“30% 的 Claude Code / Codex 能力”这个目标是**可以达到的**。原因是 coding agent 的能力上限主要来自模型，框架决定的是下限；一个干净的主循环加几个好用的工具，配合现在的便宜强模型，已经能解决相当多的真实小任务。SWE-agent 团队的 mini-swe-agent 只用 bash 一个工具、大约 100 行核心代码，就能在 SWE-bench 上拿到不错的成绩，这就是最好的证据。

## 2 七个关键判断

### 判断 1：产品定位是“编码 Agent CLI”，不是“Agent 操作系统”

先把单 Agent 做好，多 Agent 放到第 4 阶段。理由很简单：多 Agent 并行的每一个子 Agent，本身就是一个单 Agent。单 Agent 做不好，并行只会把问题放大。README 里也已经承认“没有证据表明并行必然更省 token”，所以多 Agent 应当是一个**需要用数据证明的实验**，而不是地基。

### 判断 2：Agent 的本质是一个 while 循环，架构要贴着它长

Claude Code 的核心是一个单线程主循环：调用模型 → 模型要求调用工具 → 执行工具 → 把结果追加回对话 → 再调用模型，直到模型不再调用工具。其余能力（权限、压缩、子 Agent、TODO）都是挂在这个循环上的。

```ts
while (steps < maxSteps) {
  const reply = await llm.chat(context.build(session), tools.schemas());
  session.append(reply);
  if (!reply.toolCalls.length) break;              // 模型认为完成了
  for (const call of reply.toolCalls) {
    const decision = safety.check(call);           // 路径、命令、是否需要用户确认
    const result = decision.allowed
      ? await tools.run(call)
      : denied(decision.reason);
    session.append(toolResult(call, context.truncate(result)));
  }
  if (context.nearLimit(session)) await context.compact(session);
}
```

这段伪代码就是整个系统的骨架。**每一层抽象都要回答：它让这个循环更好了吗？** 回答不出来的就先不要。

### 判断 3：保留模块边界，但用普通接口，不用平台机制

原来的五个模块名可以保留，大家的分工也不用推翻，但实现方式换成普通的 TypeScript 模块和接口：

| 原模块 | 新的职责（同一个进程内的普通包） |
|---|---|
| Workflow | `core`：主循环、步数/预算控制、终止判断、子 Agent 调度 |
| Kernel | `tools` + `safety`：工具实现、路径守卫、命令审批、沙箱 |
| ContextEngine | `context`：提示词组装、项目记忆、仓库地图、输出截断、历史压缩、token 与缓存统计 |
| AgentToolPool | `tools` 的注册表 + `prompts`：工具 schema、系统提示词模板 |
| UserInteraction | `cli`：终端界面、确认交互、会话恢复 |

建议删除或冻结的机制：UnitIntent/UnitAttempt 层级、Envelope 与 BoundaryContext、Module Host、Communication Router、Protocol Registry 与 `Unsupported` 预留、MissionScope 和 GraphRevision 字段、DBOS、PostgreSQL、Outbox/Inbox。它们解决的是多进程、多租户、崩溃恢复的问题，而你们在很长一段时间里都没有这些问题。

需要保留的好东西：TypeScript 工程和质量门（lint、typecheck、test）、工具参数的运行时 schema 校验、路径逃逸防护及其测试、不修改用户原始仓库的原则、每次运行留下完整日志。

### 判断 4：ContextEngine 从“推送检索包”改为“让模型自己搜 + 管好上下文窗口”

这是对你负责的模块最重要的判断。

原设计里，ContextEngine 在每次模型调用前主动检索，拼出一个 ContextPack 推给模型，这是 RAG 的思路。主流 coding agent 已经不这么做了：Claude Code 和 Codex 都让模型**自己**用 grep、glob、read 这类工具去找代码，也就是 agentic search。原因是预先检索很容易拿错东西，而模型边搜边看、根据结果调整查询，准确率高得多。你在学习笔记里记录的 Agentic RAG 实验，也是同一个结论。

所以 ContextEngine 的真正职责变成下面这些，恰好都是你在书第 2 章学的内容：

1. **稳定前缀**：系统提示词和工具定义固定、排序固定，保证 prompt cache 命中。这对便宜模型尤其重要，因为缓存命中的输入价格往往只有未命中的几十分之一。
2. **项目记忆文件**：读取仓库里的 `AGENTS.md`（类似 CLAUDE.md），把项目约定、测试命令放进上下文。
3. **仓库地图**：参考 Aider 的 repo map，用 tree-sitter 抽取文件和函数签名，在有限 token 内给模型一张“代码地图”。弱一些的模型尤其需要它。
4. **工具输出治理**：超长输出截断，完整内容落盘，只给模型预览和一个可再读取的路径。
5. **历史压缩**：接近上限时，把旧的工具结果替换成摘要或引用，保留最近的关键交互。
6. **状态栏**：由框架确定性生成“当前目标、TODO、已用步数、最近错误”，放在上下文末尾。
7. **计量**：每轮 token、缓存命中率、成本，写进运行报告。

这样一来，上一轮讨论的 ContextPack 字段、增量检索、谁读 Observation 这几个问题基本都不再需要回答，因为推送式 Pack 这个对象本身就不需要了。

### 判断 5：模型选便宜的，接口做成 OpenAI 兼容

产品里的 Agent 主力建议用 **DeepSeek V4.1-Flash**（`deepseek-flash`），难题或对照实验用 **DeepSeek V4-Pro**。按 DeepSeek 官方价格页（2026 年 9 月），Flash 在非高峰时段每百万 token 的价格是：缓存命中输入 0.003 美元、未命中输入 0.15 美元、输出 0.60 美元，上下文 1M。高峰时段价格翻倍：北京时间工作日 9:00–12:00 和 14:00–18:00，也就是你现在所在的新西兰时间 13:00–16:00 和 18:00–22:00（新西兰切换夏令时后各往后推一小时）。批量跑评测时避开这些时段，成本可以减半。

粗略算一下：一个 20 步的任务，累计输入约 40 万 token，其中大部分能命中缓存，输出约 1 万 token，总成本大约 2–3 美分。跑一遍 50 题的评测集，大约 1–2 美元。**所以 token 成本不是瓶颈，前提是你把稳定前缀做好。**

LLM 层只写一个 OpenAI 兼容的适配器，这样 Qwen-Coder、GLM、Kimi、MiniMax 等同档位的国产模型只要改配置就能切换，还可以在评测里横向对比，这本身也是一个好的简历数据点。这些模型更新很快，接入前以各家官网价格为准。

### 判断 6：评测先行，评测集就是方向盘

每一个改动（换提示词、加仓库地图、改压缩策略）都要用评测数字证明它有效。没有评测，就只能凭感觉，而凭感觉在 agent 开发里几乎一定会走偏。评测框架应该在第 1 阶段就和主循环一起写。

### 判断 7：语言继续用 TypeScript

`feat/M1` 已经是 TypeScript，没必要换。可以对照阅读的 TypeScript 开源 agent 有 gemini-cli、opencode、Cline。Python 的参考（mini-swe-agent、Aider、那本书的示例代码）用来学思路，完全没问题。

## 3 目标代码结构

```text
apps/cli/            终端入口、交互确认、会话恢复
packages/core/       主循环、预算、终止、子 Agent
packages/llm/        OpenAI 兼容适配器、重试、用量统计
packages/tools/      read / glob / grep / edit / write / bash / todo，工具注册表与 schema
packages/safety/     路径守卫、命令白名单与审批、（后期）Docker 沙箱
packages/context/    提示词组装、AGENTS.md、仓库地图、截断、压缩、状态栏、计量
packages/session/    JSONL 会话日志、快照与撤销
packages/eval/       任务定义、批量运行、判分、报告
eval/tasks/          评测任务（每个任务一个小仓库 + 描述 + 隐藏测试）
```

依赖方向只有一条规则：`core` 依赖其他包的接口，其他包之间不互相依赖。不需要架构测试框架，代码评审时注意即可。

## 4 分阶段路线图

每个阶段结束时都必须能演示、能跑评测。做不到就不进入下一阶段。

### P0 学习冲刺（1 周）

每个人独立手写一个 150–200 行的最小 agent：调用 DeepSeek API，给它 `read_file` 和 `run_bash` 两个工具，让它修一个简单 bug。语言随意。先读 mini-swe-agent 的源码再动手。

**退出条件：** 三个人都能在白板上画出 agent 循环，并解释 tool call 和 tool result 在消息列表里长什么样。

### P1 能跑的最小编码 Agent（3 周）

- 主循环、步数和 token 上限、终止判断。
- 6 个工具：`read`（带行号和行范围）、`glob`、`grep`（调用 rg）、`edit`（查找替换）、`write`、`bash`。
- 安全：路径不能出工作目录；写文件和执行命令默认需要用户确认；危险命令黑名单。
- 会话：JSONL 记录每一步；每次改文件前备份原内容，支持 `/undo`。
- 评测：10 个自制任务，一条命令批量跑完并输出通过率、步数、token、成本。

**演示：** 在一个陌生小仓库里，根据失败测试定位并修复 bug。  
**退出条件：** 10 个任务里至少通过 4 个，且报告自动生成。

### P2 上下文工程（3 周，由你主导）

- 稳定前缀与缓存命中统计。
- `AGENTS.md` 项目记忆。
- 工具输出截断与落盘。
- tree-sitter 仓库地图。
- 状态栏与 TODO 工具。
- 历史压缩。
- 评测扩到 20–30 题。**每个功能都做 A/B 对照**：开和关分别跑一遍，记录通过率、步数和成本的变化。

**退出条件：** 能写出“仓库地图使通过率从 X% 提升到 Y%”这样有数据支撑的结论。

### P3 可靠性与体验（2–3 周）

- `edit` 的鲁棒性：空白容错、模糊匹配、失败时给模型清楚的错误提示。便宜模型在这里失败最多。
- API 失败重试与退避。
- 命令在 Docker 容器里执行。
- 只读的 Plan 模式。
- 流式输出的终端界面。
- 从 JSONL 恢复会话。这比 DBOS 简单得多，但已经覆盖了“中断后继续”的主要需求。

### P4 多 Agent（3–4 周，简历亮点）

1. **探索子 Agent：** 主 Agent 把“去搞清楚 X 模块怎么工作”交给一个拥有独立上下文的子 Agent，子 Agent 只返回摘要，从而节省主 Agent 的上下文。这也是 Claude Code subagent 的核心价值。
2. **并行 Worker：** Planner 把任务拆成几个互不冲突的子任务，每个 Worker 在自己的 git worktree 里工作，最后合并并跑测试。
3. **对照实验：** 在同一批任务上比较单 Agent 与多 Agent 的通过率、耗时和成本，如实报告哪些任务并行有收益、哪些没有。这份结论本身就是非常好的面试素材。

这时原设计里的 TaskGraph、Join、ownership 等概念才真正派上用场，而且是以最小形态出现。

### P5 可选扩展

- 接入 MCP 客户端。
- 通用任务 Agent：用 Cary 提出的经济学作业（从网站下载数据、整理成 Excel、写报告）作为非编码评测。它需要网页抓取和表格工具，适合在编码能力稳定之后再做。
- 用 SWE-bench Lite 或 Verified 的一个小子集做外部基准。这需要 Docker 环境，工作量不小，但能得到一个业界通用的数字。

## 5 三人分工建议

| 人 | 负责 | 贯穿各阶段的主线 |
|---|---|---|
| Cary | `core` + `session` + `cli` | 主循环 → 预算与终止 → 会话恢复 → 子 Agent 与并行调度 |
| 田园 | `tools` + `safety` | 6 个工具 → edit 鲁棒性 → Docker 沙箱 → worktree 管理 |
| meti | `context` + `eval` | 评测框架 → 稳定前缀与计量 → 仓库地图 → 压缩 → A/B 实验报告 |

评测和上下文放在同一个人手里，是因为上下文工程的每个改动都必须用评测证明，两者天然绑在一起。

## 6 评测体系设计

每个任务是一个目录：

```text
eval/tasks/t001-discount-bug/
  repo/            初始代码（自带 git 历史）
  task.md          给 Agent 的任务描述（不能泄露答案文件名）
  check.sh         隐藏的判分脚本（运行 Agent 看不到的测试）
  meta.json        类别、难度、预期涉及的文件（只用于分析，不给 Agent）
```

指标：通过率、平均步数、输入与输出 token、缓存命中率、成本、耗时、失败原因分类（没找到文件、改错、edit 失败、超步数等）。

任务来源由易到难：自己写的小 bug → 从真实开源项目 issue 改编 → SWE-bench 子集。

## 7 开发过程中怎么用 AI 省钱

区分两种花费：**产品里 Agent 调用的 API**用 DeepSeek，很便宜；**你们自己 vibe coding 用的工具**（Claude、Codex 等）才是真正需要精打细算的地方。

- 架构决策、复杂 bug：最强的模型，少量、集中地用。
- 日常写代码：中档模型。
- 写测试、改格式这类小活：最便宜的模型。
- 一个任务开一个新会话；把项目约定写进仓库根目录的 `AGENTS.md`，这个文件同时也是你们自己 Agent 要读取的项目记忆，一举两得。

## 8 补充：可以参考的开源实现

港大数据科学实验室（HKUDS）开源的 OpenHarness（MIT 许可，Python）是一个轻量的 coding agent 外壳，已实现工具调用、CLAUDE.md 注入、自动压缩、权限模式、子 Agent 协作、MCP 和 Skills，并支持 DeepSeek。它不必作为依赖，但很适合作为“参考答案”：遇到某个功能不知道怎么设计时，先看它是怎么做的。

---

参考来源：

- DeepSeek 官方价格页：https://api-docs.deepseek.com/quick_start/pricing
- 开源编码模型对比（2026 年 3 月）：https://www.morphllm.com/best-open-source-coding-model-2026
- LLM 价格汇总（2026 年 9 月）：https://benchlm.ai/llm-pricing
