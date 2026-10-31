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
| D1 | 摘要请求按实测改写法（M2Design v1.11）；每个阶段完成后从 `feature/phase<N>/main` PR 到 `feat/M2`（Cary 2026-10-31 决定） | 已执行 |

## 3. 当前进度

| 分支 | 内容 | 验证 |
|---|---|---|
| `feature/phase0/main` | 阶段 0：实测结果、M2Design v1.10、本文 | 文档改动 |
| `feature/phase1/main`（基于上一行） | E-EX-4、E-WF-1；S1-CT-1 的 Schema 与 Port；S1-IF-1；S1-IF-2；`repository-list` 的列表与预览（未注册为 Executor） | Ubuntu 24.04（WSL）完整质量门 |

阶段 1 尚未开始：S1-CT-1 的 fake 与契约测试、S1-WF-1–4、S1-KC-1–4、S1-KX-1、S1-EX-1 的其余部分（`v0` 预览接入 `retention/`、`context-assemble`、`model-call`）、S1-PL-1、S1-UI-1、S1-IN-1。
新代码都未接入运行链路，所以现有的 M1 行为不变；阶段 1 的验收用例一个都还不能运行。
