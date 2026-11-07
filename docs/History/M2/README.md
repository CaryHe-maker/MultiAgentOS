# MultiAgentOS M2 的历史文档

> **本目录是历史记录，不是当前规范，也不是当前计划。** 这里的文档按"阶段 0–8"（旧编号）组织，
> 写于 M2 的第一轮实现期间（2026-10 至 2026-11-07）。它们已经冻结，不再修改，
> 后续工作不再以它们为计划标准。当前的计划是 [M2ReleasePlan](../../M2/M2ReleasePlan.md)，
> 已实现部分的现状是 [M2Baseline](../../M2/M2Baseline.md)，设计依据仍是 [M2Design](../../M2/M2Design.md)。

## 1. 为什么冻结

M2 的第一轮实现把系统层做到了基本完善：Session、写入与回退、命令与沙盒、并行、人类在环控制、网页、上下文压缩。
剩下的工作重心变了，从"系统有哪些能力"转为 Workflow 与 Orchestration、Agent 与 Prompt、工具与 Executor、
隔离与安全，以及发布所需的评测、健壮性与文档。旧的阶段划分（按系统能力切）不再适用，
继续沿用旧编号会与 [M2ReleasePlan](../../M2/M2ReleasePlan.md) 的 phase 0–3 互相冲突。

## 2. 目录内容

| 文档 | 内容 |
|---|---|
| [M2Plan](M2Plan.md) | 旧计划：阶段、工作流、任务编号（`S<阶段>-…`）、门与退出条件。已冻结 |
| [M2OpenDecisions](M2OpenDecisions.md) | 旧的决定记录与各阶段的计划和进度，含阶段 4 的退出情况。仍然有效的决定已迁入 [M2Decisions](../../M2/M2Decisions.md) |
| [Evaluation/](Evaluation/) | 各阶段做过的实测与评测：子 Agent、人类在环、网页提供方与抓取顺序、上下文压缩。数据是当时的事实，不是统计结论 |

## 3. 旧阶段编号与结果

| 旧阶段 | 内容 | 合入 `feat/M2` 时的情况 |
|---|---|---|
| 0 实测 | bwrap 完整 profile、DeepSeek 思考内容回传 | 完成，结果在 [M2TechStack](../../M2/M2TechStack.md) |
| 1 Session 与对话骨架 | Session 日志、Turn、`chat` 与 `analyze` 模板、上下文投影 | 完成 |
| 2 写入与回退 | 授权、`write_file`、`edit_file`、`/undo`、`/diff`、`read_output` | 完成 |
| 3 命令与沙盒 | bwrap、`run_command`、`git_inspect`、停机与内存压力 | 完成（个别运行时项见 M2Baseline） |
| 4 并行 | 按 AgentRun 分队列、写入占用、额度委派、`run_subagents` | 部分完成：P3、B4 端到端、D 没有达到 |
| 5 人类在环控制 | 暂停、继续、`/steer`、中止、`ask_user` | 完成 |
| 6 Web | `web_search`、`web_fetch`、地址检查 | 完成 |
| 7 Orchestration | 使用者模板、条件边、有界循环、`mas run` | **没有做**，并入 [M2ReleasePlan](../../M2/M2ReleasePlan.md) 的 phase 2 |
| 8 上下文压缩 | 自动、溢出、`/compact`、空闲触发，修剪与摘要 | 完成 |

旧阶段的任务编号（`S1-…`、`S8-…`）与分支名（`feature/phase<N>/main`）只指这一轮；
新的任务编号是 `RP<phase>-…`，分支是 `feature/M2/rp<N>-<主题>`。

## 4. 如何引用

- 需要说明某个机制"为什么这样设计"时，引用 [M2Design](../../M2/M2Design.md)，不要引用本目录。
- 需要某个实测的原始数据时，可以引用 [Evaluation/](Evaluation/)，并注明它是历史数据。
- 不要在当前文档与代码注释中使用"阶段 N"这类旧编号；本目录与 M2Design 末尾的版本记录是仅有的例外。
