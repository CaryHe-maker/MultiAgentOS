# MVP 范围

## 产品定义

MultiAgentOS 接收一个受限的全栈开发目标，将其转成可审计的任务图，安全地运行彼此独立的任务，并报告结果是否通过预先定义的检查。

第一个演示目标是 Todo 应用的登录功能：包含 API contract、后端认证任务、前端登录任务和集成测试任务。

## Phase 1 完成标准

只有同时满足以下条件，MVP 才算完成：

1. 接收用户目标，并生成包含至少两个独立实现任务的、通过 Schema 校验的 `Plan`。
2. 执行前拒绝未知依赖、依赖环和不安全的文件 ownership 重叠。
3. 在独立 Git worktree 中运行互不阻塞的后端和前端任务。
4. 在每次任务状态变化前后，都将状态持久化到 SQLite。
5. 配置中的高风险命令必须经过明确审批。
6. 集成 Worker 产生的改动，运行定义好的检查，并产出 Run report。
7. 用同一固定任务与单 Agent 基线、人工双窗口基线进行比较。

## 明确不做的事

- 不做生产部署、多租户、远程 Worker 或 Dashboard。
- 不允许自动发布、删除、修改权限或访问用户密钥。
- 不预设并行执行一定更便宜或更快。
- 不做“通用自主软件公司”。第一个工作流必须范围小且可重复。

## 开发顺序

| 步骤 | 结果 | 负责人 |
|---|---|---|
| 0. Baseline | 5-10 个固定任务和结果记录表 | C |
| 1. Core protocol | `TaskCard`、`Plan`、校验和 checkpoint 状态 | A |
| 2. Planner | 模型输出 -> 通过校验的 Plan JSON | A |
| 3. Runtime | worktree 创建、获批 subprocess Worker、结果采集 | B |
| 4. Integration | 有序合并、质量门、失败报告 | C |
| 5. End-to-end slice | Todo 登录任务完整跑通 `plan/run/integrate/report` | A+B+C |

不要因为某项技术有趣就提前开始后续步骤。只有前一项有通过的测试或可重复 Demo，才开始下一项。
