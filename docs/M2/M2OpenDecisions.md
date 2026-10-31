# MultiAgentOS M2 待决定事项

> 本文收集自主推进期间留给负责人（Cary）判断的问题，以及已经先行作出、需要复核的决定。
> 决定之后，把结论写入相应文档，并从本文删除该条。

## 1. 需要决定

| # | 问题 | 背景 | 建议 | 影响 |
|---|---|---|---|---|
| Q1 | 没有原生 Ubuntu 24.04，S0-T-1 的原生一列怎样完成 | M2Plan 要求原生与 WSL 都测；WSL 全部测完，AppArmor 在 WSL 中未启用，限制与修复步骤未验证。脚本在作者本地的临时目录中，可以提交到仓库 | 阶段 3 的文档门之前在原生环境补测；阶段 1 不依赖它 | 阶段 3、使用说明 |
| Q4 | 阶段 1 其余部分怎样切换 | Kernel、Workflow、UserInteraction 的改写会替换现有可运行的 M1 链路（`run-actor` 改写为 Session actor）。M2Plan 的做法是先补齐 fake，再各工作流并行，最后 S1-IN-1 一次接线；这期间 `feature/phase1/main` 上 M1 链路继续可用，新代码只是未接线 | 按 M2Plan：先完成 fake Kernel 与 fake Workflow（S1-CT-1 的剩余部分），再按工作流推进，`analyze` 回归在 S1-IN-1 验证 | 阶段 1 其余全部 |

## 2. 已先行决定，请复核

| # | 决定 | 依据 |
|---|---|---|
| A1 | 发布 M2Design v1.10，只含实测直接推翻的三处写法（空文件遮蔽、`/tmp` 挂载顺序、SIGTERM 目标）与第 9.4 节的说明修正 | M2Plan 第 6.1 节要求实测不符时先发布新版本；这几处是事实修正，没有改变设计意图 |
| A2 | `replayReasoning` 定为 `REQUIRED`，尽管服务端记得的工具调用不回传也能成功 | 服务端记忆的保留时长未知，恢复旧 Session 时可能失败 |
| A3 | Interface 没有写到字段级的 `ContextHistoryEntry`、`ContextAssembleInput.v1`、`GraphNodeRecord`、`GraphEdgeRecord`，按 Workflow 第 8.3 节与 M2Design 第 3 节的语义定义，已回填到 Interface/WorkflowKernel 第 3.5 节与 Interface/Persistence 第 2.3 节；`NODE_ENDED` 增加 `result?` | 契约门需要这些类型；条件边的判定必须是日志的纯函数 |
| A4 | 冻结的 major 0 不能增加枚举值，所以原因码、`ExecutionKind`、定义种类等都另发 `.v1`，代码中以 `V1` 后缀并存 | Interface 第 2.2 节、协议快照守卫 |

## 3. 当前进度

| 分支 | 内容 | 验证 |
|---|---|---|
| `feature/phase0/main` | 阶段 0：实测结果、M2Design v1.10、本文 | 文档改动 |
| `feature/phase1/main`（基于上一行） | E-EX-4、E-WF-1；S1-CT-1 的 Schema 与 Port；S1-IF-1；S1-IF-2；`repository-list` 的列表与预览（未注册为 Executor） | Ubuntu 24.04（WSL）完整质量门 |

阶段 1 尚未开始：S1-CT-1 的 fake 与契约测试、S1-WF-1–4、S1-KC-1–4、S1-KX-1、S1-EX-1 的其余部分（`v0` 预览接入 `retention/`、`context-assemble`、`model-call`）、S1-PL-1、S1-UI-1、S1-IN-1。
新代码都未接入运行链路，所以现有的 M1 行为不变；阶段 1 的验收用例一个都还不能运行。
| D1 | 摘要请求按实测改写法（M2Design v1.11）；每个阶段完成后从 `feature/phase<N>/main` PR 到 `feat/M2`（Cary 2026-10-31 决定） | 已执行 |
