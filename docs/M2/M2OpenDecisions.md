# MultiAgentOS M2 待决定事项

> 本文收集自主推进期间留给负责人（Cary）判断的问题，以及已经先行作出、需要复核的决定。
> 决定之后，把结论写入相应文档，并从本文删除该条。

## 1. 需要决定

| # | 问题 | 背景 | 建议 | 影响 |
|---|---|---|---|---|

## 2. 已决定

| # | 决定 | 依据 |
|---|---|---|
| A1 | 发布 M2Design v1.10，只含实测直接推翻的三处写法（空文件遮蔽、`/tmp` 挂载顺序、SIGTERM 目标）与第 9.4 节的说明修正 | M2Plan 第 6.1 节要求实测不符时先发布新版本；这几处是事实修正，没有改变设计意图 |
| A2 | `replayReasoning` 定为 `REQUIRED`，尽管服务端记得的工具调用不回传也能成功 | 服务端记忆的保留时长未知，恢复旧 Session 时可能失败 |
| A3 | Interface 没有写到字段级的 `ContextHistoryEntry`、`ContextAssembleInput.v1`、`GraphNodeRecord`、`GraphEdgeRecord`，按 Workflow 第 8.3 节与 M2Design 第 3 节的语义定义，已回填到 Interface/WorkflowKernel 第 3.5 节与 Interface/Persistence 第 2.3 节；`NODE_ENDED` 增加 `result?` | 契约门需要这些类型；条件边的判定必须是日志的纯函数 |
| A4 | 过渡期 major 1 以 `V1` 后缀与 major 0 并存，S1-IN-1 后去掉 | Interface 第 2.2 节 |
| A5 | 原生一列取自 GitHub Actions 的 `ubuntu-24.04` 运行器（Azure 虚拟机，内核 `7.0.0-1017-azure`），AppArmor 限制与默认一致；没有在 Ubuntu 的 `generic` 内核上再测 | 阻塞行为与修复都已验证；发布前可在实体机上复核 |
| D2 | 阶段 1 的新代码与 M1 并存，S1-IN-1 接线并通过 `analyze` 回归后删除 M1 的模块；A1–A5 全部确认（Cary 2026-10-31 决定） | 已执行 |
| D3 | main 降级时经 `message-publish` 发布 `DEGRADED_REPLY`，只带结构化原因，不受额度限制（Cary 2026-10-31 决定） | 已执行 |
| D4 | 用户正文只以引用传递，没有例外（M2Design v1.12，Cary 2026-10-31 决定） | 契约已改，Execution 在 S1-KX-1 实现 |
| D5 | 不留历史包袱：`analyze` 并入统一路径，发布版只有 major 1，M1 模块在 S1-IN-1 后删除（Cary 2026-10-31 决定） | 文档已改 |
| D6 | AgentRun 状态机对所有 Agent 相同，结束方式由定义声明的结束工具决定，运行器按表执行（Cary 2026-10-31 决定） | 已执行 |
| D7 | 授权询问不超时，一直等到用户回答，只在运行收敛时取消；拒绝作为被拒 Unit 的工具结果交还 Agent，不结束 Turn（M2Design v1.13，Cary 2026-10-31 决定） | 文档与 major 1 契约已改；M1 的 `authorizationTimeoutMs` 随 S1-IN-1 删除 M1 模块时一起删除 |
| D8 | `AGENTS.md` 与其他说明文档同级：第一次需要读仓库时才读，以历史条目追加，不进入 system 段；main 没有启动 Unit（M2Design v1.14，Cary 2026-11-02 决定） | 已执行 |
| D9 | 用户拒绝绑定提出请求的 AgentRun：不重复申请，下一轮告诉模型，不计入连续出错，模型再次调用时收尾；参照 OpenCode 与 DeepSeek Harness 后定（Cary 2026-11-02 决定） | 已执行 |
| D10 | 思考强度只在 `registerAgentRun` 中给出（Cary 2026-11-02 决定） | 已执行 |
| D1 | 摘要请求按实测改写法（M2Design v1.11）；每个阶段完成后从 `feature/phase<N>/main` PR 到 `feat/M2`（Cary 2026-10-31 决定） | 已执行 |

## 3. 当前进度

核对时间：2026-11-02，`feature/phase1/main`；Ubuntu 24.04（WSL）完整质量门在阶段 1 的每次推进后运行。
阶段 0 已经由 PR #40 合入 `feat/M2`。阶段 1 在 `feature/phase1/main` 上，远端作为备份，尚未向 `feat/M2` 开 PR。

| 任务 | 状态 | 已完成 | 未完成 |
|---|---|---|---|
| S1-CT-1 | 完成 | v1 Schema 与 Port（`ExecutionFact.v1` 在 S1-KX-1 时补上）；fake Kernel、fake Workflow 与契约测试 | — |
| S1-IF-1、S1-IF-2 | 完成 | Session 存储、实例锁与 Session 锁；全局 ArtifactStore | — |
| S1-WF-1–4 | 完成，只对 fake Kernel 验证过 | 日志客户端、TaskGraph 与 `chat` 生长规则、上下文投影、`analyze` 走统一路径 | 与真实 Kernel 接线（S1-IN-1） |
| S1-KC-1 | 部分 | Session actor、三个序列的 Outbox、Session 引用、信任记录、Session 管理（打开、切换、继续、列表、删除、关闭） | 产物回收的定时器、审计 |
| S1-KC-2 | 完成，等 Gateway 接入 | Turn、开放输入的静止检查、AWAITING_INPUT、人类请求的转发、`answerAuthorization`、`readProjectFile`（`repo.read` 与 `project.instructions` 两步询问） | — |
| S1-KC-3 | 未开始 | — | Gateway 的 major 1 syscall |
| S1-KC-4 | 完成 | 两级账本、启动检查、工具次数、AgentRun 墙钟，已接入 Session actor | — |
| Core 的 Unit 路径 | 完成 | `RunWork`：幂等、AgentRun 登记与结束、受理、额度、授权、尝试、结果检查、收敛；经真实 Session actor 的端到端测试 | 审计写入；`RunExecution` 接入 `RunWork`（组合根） |
| S1-KX-1 | 部分 | 按 Session 的产物归属与保留类别、用户输入、`message-publish`、`report-publish`、引用解析、预览与完整输出、技术重试、取消与未确认停止的兜底、`readProjectFile` | `RETRYING` 活动的发出、启动时与定期的产物回收、`removeSessionFiles`、`repository-list` 以外的 `RepositoryAccess` 接线 |
| S1-EX-1 | 部分 | `retention/`、`repository-list` 的列表与预览（未注册为 Executor） | 三个仓库工具的预览、`context-assemble` 与 `model-call` 的 major 1、`repository-list` 的注册 |
| S1-PL-1 | 未开始 | — | v1 定义与加载校验（包括 `repo.read`、`failurePolicy` 两条规则） |
| S1-UI-1 | 未开始 | — | 全部 |
| S1-IN-1 | 未开始 | — | 接线、回归、删除 M1 与 major 0、去掉 `V1` 后缀 |

新代码都未接入运行链路，所以现有的 M1 行为不变；阶段 1 的验收用例一个都还不能运行。
