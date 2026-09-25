# Paralleling AgentOS ContextEngine 模块详细设计报告

> 文档类型：ContextEngine Module 完整目标详细设计  
> 文档状态：写作中（第 1–2 章初稿；第 3–21 章为待写大纲）  
> 适用范围：M1 至 M5 / V1.0 演进  
> 目标架构：`docs/DesignReport/TargetArchitecture.md`  
> 当前 M1 范围：`docs/M1Plan/TargetM1.md`（位于 `feat/M1`）  
> 配套模块设计：`docs/DesignReport/WorkflowModuleReport.md`  
> 技术栈约束：`docs/TechStack.md`

> 范围说明：本文保存 ContextEngine 的完整领域模型、检索流水线、跨模块协议和演进约束。当前 M1 的对象、接口和测试完成定义仅以 `TargetM1.md` 为准。本文用 `[M1]`、`[M2]`、`[M3]`、`[M4]`、`[M5]` 标注各项能力首次进入实现的里程碑；未标注 `[M1]` 的能力不得成为当前发布阻断项。

## 1 文档目的与模块结论

本文把 ContextEngine 定义为 AgentOS 中**模型能看到什么**这一问题的权威所有者。模块负责从版本化、经授权的来源中召回当前 AgentStep 所需的代码、文档和运行证据，在数据范围、来源 revision 和 token 预算约束内完成过滤、排序、去重与裁剪，并发布不可变、可追溯的 ContextPack。

一次上下文请求的目标可以概括为：

```text
在 Kernel 准入的数据范围内
  针对当前任务目标、Agent 查询和运行观察
  从正确 revision 的来源中召回证据
  在 token 预算内排序、去重和裁剪
  发布不可变、可追溯的 ContextPack
```

ContextEngine **提供事实与证据，不做任务决策**。它不是 Workflow 的内部函数、不是 AgentToolPool 中的普通 Tool、不是权限中心，也不是聊天记录存储。它不得因为检索到某个函数、某段测试输出或某条模型摘要，就改变任务状态、判断任务成功或扩大可见范围。

ContextEngine 只接受 Kernel 准入后的 Context Unit。所有来自 Workflow 或 AgentRun 的上下文需求都必须先形成 `UnitIntent`，由 Kernel 完成准入并调用 ContextEngine；ContextEngine 的结果以 `ContextPackRef` 经 Kernel 返回 Workflow。M1 中这条线路是进程内同步调用，但调用方向与所有权从 M1 起即为最终形态 `[M1]`。

索引、缓存和检索视图都是**可删除、可重建的派生数据**；源文件、Artifact 和其他 Module 的领域记录才是事实。ContextEngine 的正确性依赖 provenance：系统必须能对 ContextPack 中的每一项回答“它来自哪里、属于哪个 revision、为什么被选中”。

本文中的“必须/不得/应/可”含义与总体设计报告一致。内部实现可重构，但不得破坏本文定义的对象语义、接口契约和不变量。

## 2 职责边界

### 2.1 输入

- Kernel 准入并路由的 Context Unit：包含 `ContextRequest` 与 `BoundaryContext`（correlation、causation、运行引用、deadline）`[M1]`。
- `ContextRequest` 中的运行定位信息：`workflowRunId`、`missionScopeId`、`graphRevision`、`taskRunId`、`agentRunId` `[M1]`。
- Kernel 签发的 `WorkspaceRef`：可读取的 workspace 根、`repositoryRevision` 和隔离类型。WorkspaceRef 决定“允许从哪里读”，由 Kernel 负责 `[M1]`。
- 任务目标 `objective`、Agent 本轮查询 `query` 与 token 预算 `tokenBudget` `[M1]`。
- 之前步骤 Observation 的 `ArtifactRef`，由 ContextEngine 通过只读 Artifact Port 取回内容 `[M1]`。
- 已发布的 ContextPack 引用，用于增量检索与去重（字段待第 3 章确定）`[M1]`。
- Workflow 发布的 MissionScope 快照与 TaskGraph 切片，用于目标谱系和任务感知 `[M3]`。
- Kernel ExecutionPermit 中绑定的数据范围、Artifact 范围、policyVersion 与 Lease `[M3]`。
- AgentToolPool 提供的版本化 `ContextProfile`（例如某类 Agent 的默认检索策略与预算划分）`[M2]`。
- Kernel 发起的 Review Evidence Unit，携带审核请求数据范围与审查者 ACL `[M4]`。
- Workflow 恢复流程中经 Kernel 下发的 RestoreAction `[M4]`。

### 2.2 输出

- 不可变 `ContextPack`：包含 `contextPackId`、workspace、`repositoryRevision`、`items`、`tokenCount` 和 `provenance` `[M1]`。
- 返回给 Kernel 的 `ContextPackRef`；完整 Pack 与检索诊断作为 Artifact 保存 `[M1]`。
- 检索诊断：召回候选、过滤原因、被预算裁掉的候选、检索器版本和耗时，用于评测与复现 `[M1]`。
- 结构化 `ModuleError`：分类为 `VALIDATION`、`POLICY`、`TIMEOUT`、`RESOURCE`、`EXECUTION`、`CONTRACT` 或 `INTERNAL`，并带 `retryable` `[M1]`。
- 用量信息：Pack token 数、读取文件数、检索耗时，供 Kernel 汇总进 UnitResult `[M1]`。
- `IndexRevision` 的构建、失效与淘汰事件 `[M3]`。
- 审核证据 `EvidenceRef` 与脱敏摘要 `[M4]`。
- RestoreAction 结果：`REUSED`、`REBUILT`、`STALE` 或 `INCOMPATIBLE`，附来源证据 `[M4]`。

### 2.3 禁止行为

ContextEngine 不得：

1. 接受 Workflow、AgentRun、UserInteraction 或模型的直接调用；所有请求必须经 Kernel 准入。
2. 写入、修改或删除 workspace 中的任何文件，执行 shell 命令或运行测试。
3. 读取 `WorkspaceRef` 与 Kernel 授权范围以外的路径；绝对路径、`..` 和 symlink/junction 解析后仍须位于授权 workspace 内。
4. 写入 Workflow、Kernel、AgentToolPool 或 UserInteraction 的领域状态，或直读它们的数据库表。
5. 判断任务是否成功、Agent 行为是否正确，或把“找到了内容”当作任务完成。
6. 签发、扩大或推断权限；ContextEngine 的范围过滤是防御性复核，不能替代 Kernel 鉴权。
7. 把外部代码、文档、日志、测试输出或网页内容拼入 system / developer instruction；这些内容只能作为数据进入模型输入。
8. 把模型的自然语言自述或 LLM 生成的摘要当作唯一事实来源。
9. 原地修改已发布的 ContextPack；任何更正都必须创建新 Pack。
10. 把可重建索引、缓存或检索视图当作系统事实源，或在恢复时回滚共享索引。
11. 维护 system prompt、Tool 目录或模型定义；这些属于 AgentToolPool。
12. 在 token 预算不足时静默丢弃任务目标或最新关键证据；无法满足最低内容要求时必须返回结构化错误。

---

<!-- 以下为待写大纲。每写完一章，删除对应的“待写”标记。 -->

## 3 领域模型（待写）

- 3.1 聚合划分：哪些对象由 ContextEngine 拥有、哪些只引用
- 3.2 SourceRef：原始来源的可验证引用 `[M1]`
- 3.3 RepositorySnapshot：某 workspace 在特定时刻的文件视图、ignore 规则与 revision `[M1]`
- 3.4 SourceDocument、ContextRecord 与 Chunk `[M1]`；Symbol `[M2]`
- 3.5 IndexRevision：检索视图的输入与算法版本（M1 为固定值）`[M1]`
- 3.6 ContextRequest：字段与语义，含增量检索字段提案 `[M1]`
- 3.7 RetrievalResult：候选、过滤与排序诊断 `[M1]`
- 3.8 ContextPack 与 ContextItem：字段、不可变规则、与当前 contracts schema 的差异 `[M1]`
- 3.9 Provenance：回答“模型为什么看到这段内容” `[M1]`
- 3.10 Memory 分类：工作记忆、情景记忆、代码库知识、用户记忆、程序记忆的归属
- 3.11 EvidenceRef `[M4]`

## 4 二级组件设计（待写）

- 4.1 Context Request Gateway `[M1]`
- 4.2 Snapshot Manager `[M1]`
- 4.3 Source Discovery 与 Record Builder `[M1]`
- 4.4 Retrieval Planner `[M1]`
- 4.5 Retrievers：Path / Lexical(rg) / Symbol-name `[M1]`；Symbol(tree-sitter/SCIP) `[M2+]`；Dense `[M3+]`
- 4.6 Fusion 与 Candidate Policy `[M1]`
- 4.7 Scope 与 Revision Filter `[M1]`；ACL Filter `[M3]`
- 4.8 Pack Assembler `[M1]`
- 4.9 Provenance Recorder `[M1]`
- 4.10 Goal Lineage Materializer 与 Task Awareness `[M3]`
- 4.11 Memory and History Manager `[M2]`
- 4.12 Index Coordinator `[M3]`
- 4.13 Evidence Generator `[M4]`
- 4.14 Restore Participant `[M4]`
- 4.15 组件内部调用顺序

## 5 生命周期与版本语义（待写）

- ContextPack 无状态机：发布即不可变
- RepositorySnapshot 的有效与失效
- IndexRevision 生命周期 `[M3]`
- repositoryRevision 的定义：M1 只读 vs M2 可写 worktree

## 6 Query、Command 与事件目录（待写）

## 7 持久化设计（待写）

- M1：run-scoped 文件与 Artifact
- 长期：`context` schema 逻辑表

## 8 Context Unit 执行映射（待写）

- executionKind 与 ContextEngine 操作的对应关系
- 同步 inline 路径与异步路径

## 9 关键算法（待写）

- 9.1 查询规划
- 9.2 召回与融合
- 9.3 分块
- 9.4 token 预算打包
- 9.5 去重与多样性控制
- 9.6 失效判定

## 10 与其他模块的协议（待写）

- 10.1 Kernel
- 10.2 Workflow
- 10.3 AgentToolPool
- 10.4 UserInteraction
- 10.5 Infrastructure（Artifact Store、Persistence、Communication）

## 11 关键运行路径中的 ContextEngine 行为（待写）

- 以固定任务 F2 为例的完整时序

## 12 失效、重建与恢复（待写）

## 13 人类审核证据（待写）`[M4]`

## 14 错误处理与边界场景（待写）

## 15 安全与数据保护（待写）

## 16 可观测性与检索评测（待写）

## 17 测试设计（待写）

## 18 实现包结构与接口（待写）

## 19 实施顺序（待写）

## 20 模块验收标准（待写）

## 21 后续演进约束与待决 ADR（待写）
