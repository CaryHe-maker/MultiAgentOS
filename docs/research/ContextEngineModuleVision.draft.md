# ContextEngine Module Vision

> 文档类型：长期模块愿景与设计草案
>
> 文档状态：讨论中；仅在评审完成后迁入 `feat/originPlan`。
>
> 当前实施约束：[ContextEngineModuleDesign.draft.md](ContextEngineModuleDesign.draft.md) 是 M1 的简化设计依据。

## 0. 文档定位

本文与 `WorkflowModuleVision` 对齐，描述长期 AgentOS 中 `ContextEngine` 的领域边界、对象、组件和协议。它不扩大 M1 的完成定义。

`ContextEngine` 的工作不是“存聊天记录”，而是从版本化、受授权的来源中选取当前 AgentStep 所需事实，生成可追溯的 `ContextPack`。模型能看到什么，是一个需要版本、预算、来源和权限约束的系统问题。

```text
外部来源、workspace、Artifact、运行观察
                 ↓
        ContextEngine：检索、过滤、压缩、来源追踪
                 ↓
              ContextPack
                 ↓
          AgentRun / Model Unit
```

### 0.1 演进边界

| 阶段 | ContextEngine 交付 |
|---|---|
| M1 | 单 Agent、单 worktree、文件树、`rg`、Chunk、token budget、provenance。 |
| 可靠性阶段 | revision、缓存失效、Artifact、持久 snapshot 和可复现检索。 |
| 协作阶段 | 以 `TaskAttempt`、`AgentRun`、`ProcessScope` 和 workspace 隔离上下文；Agent 只共享 Artifact 和结构化任务信息。 |
| 检索升级阶段 | tree-sitter、SCIP、embedding、pgvector、hybrid retrieval、reranker。 |

M1 的核心接口和 provenance 语义应稳定；索引算法、存储实现和 provider 适配器可以演进。

## 1. 模块目的与所有权

### 1.1 ContextEngine 的目的

一次上下文请求的目标是：

```text
在允许的数据范围内
  针对当前任务、query 和运行观察
  从正确 revision 的来源中召回证据
  在 token budget 内排序、去重和压缩
  发布不可变、可追溯的 ContextPack
```

ContextEngine 提供的是事实与证据，不是任务决策。它不能因为检索到了某个函数、某个测试输出或某个模型摘要，就自行改变任务状态或扩大工具权限。

### 1.2 长期拥有的领域对象

| 对象 | 含义 |
|---|---|
| `SourceRef` | 原始来源的可验证引用，例如 workspace 文件、Artifact 或外部文档。 |
| `RepositorySnapshot` | 某个 `WorkspaceRef` 在特定时刻的文件视图、ignore 规则与内容摘要。 |
| `ContextRecord` | 统一的、可查询和可排序的内容单元。 |
| `IndexRevision` | 使用何种输入和算法构建的检索视图。 |
| `RetrievalResult` | 一次查询召回的候选、过滤和排序诊断。 |
| `ContextPack` | 交给当前 AgentStep 的不可变上下文输出。 |

`ContextEngine` 是上述对象的唯一写入者；它通过 Query、Command、Event 和 ArtifactRef 与其他模块协作，不直接读写其他 Module 的领域表。

### 1.3 明确不拥有的对象

| 对象或职责 | 所有者 |
|---|---|
| `WorkflowRun`、TaskGraph、TaskAttempt、AgentRun 的业务状态 | Workflow |
| 身份、Policy、Grant、Lease、ExecutionPermit、UnitAttempt | Kernel |
| Agent、Tool、Model、Prompt、Contract 的静态定义 | AgentToolPool |
| 原始大对象字节、内容寻址和保留策略 | Artifact Store |
| 用户跨 Session 偏好与经同意的长期记忆 | 后续独立能力 |

## 2. 对象关系与版本语义

```text
WorkspaceRef / ArtifactRef / ExternalSourceRef
                    │
                    ▼
      RepositorySnapshot / SourceDocument
                    │
                    ▼
         ContextRecord（代码、文档、日志、测试证据）
                    │
                    ▼
              IndexRevision
                    │
ContextRequest ────┼────► RetrievalResult ────► ContextPack
```

### 2.1 `WorkspaceRef` 与 `RepositorySnapshot`

`WorkspaceRef` 表示“允许从哪里读取”，是 Kernel 的执行和权限边界；`RepositorySnapshot` 表示“本次检索面对的代码事实”，是 ContextEngine 的事实边界。两者不能合并。

对于 Git worktree，`HEAD` 不能完整代表当前代码：Agent 可能已经产生未提交修改。因此 snapshot 至少需关联 base commit、工作树内容摘要、ignore 版本和捕获时间。代码一旦变化，旧 Pack 仍可作为审计证据，但不能作为下一轮 Agent 的当前代码事实。

### 2.2 `ContextRecord`、Chunk 与 Symbol

`SourceDocument` 是原始文件或 Artifact 在确定 snapshot 下的内容；`ContextRecord` 是可查询的统一内容单元；Chunk 是为 token budget 切出的代码/文本片段。Chunk 不是文件本身，也不是完整模型输入。

M1 只需文本 Chunk，带路径、行范围、内容 hash、语言/类型和来源。后续 `Symbol` 才表示函数、类、模块与引用关系，并由 tree-sitter / SCIP 逐步提供。

### 2.3 `IndexRevision`

`IndexRevision` 记录“以什么输入和算法生成检索视图”。同一份代码使用不同 chunker、embedding 模型或符号解析器，会产生不同 IndexRevision。

M1 只有按需构建的 lexical view，不需要持久向量索引；但应记录检索器和 chunker 版本，以便后续评测、回归和故障复现。

## 3. Memory Model

“Memory”不等于一个数据库表。以下边界必须保持清楚：

| 类型 | M1 | 长期定位 |
|---|---|---|
| 工作记忆 | 当前 AgentRun 的目标、关键 Observation、ContextPack | 继续作为模型上下文投影，而非无限 transcript。 |
| 情景记忆 | 本次 Run 的工具结果、测试、diff、步骤记录 | 以 Artifact 与事件留存，按需取回。 |
| 代码库知识 | 当前 revision 的文件、Chunk、检索视图 | 逐步加入符号、向量和外部文档索引。 |
| 用户语义记忆 | 不实现 | 经用户同意、可删除、带 provenance 的项目/用户记忆。 |
| 程序记忆 | 仅静态 Prompt / Tool 定义 | 仍由 AgentToolPool 管理，不能从历史任务无审计地学习。 |

Task 状态由 Workflow 保存，权限和执行状态由 Kernel 保存。ContextEngine 只读取经允许的状态投影，不能把模型自述提升为权威事实。

## 4. ContextPack 与模型输入

`ContextPack` 不是完整 prompt。完整模型输入由多个模块组装：

```text
AgentToolPool：AgentDefinition、固定 instruction、Tool schema
Kernel：当前 ToolSchemaProjection、执行限制
Workflow：任务目标、验收条件、AgentStep、Observation
ContextEngine：运行时投影、代码和证据、provenance
```

ContextEngine 发布的 Pack 至少应包含：

```text
contextPackId、requestId、workspaceRef、repositoryRevision
runtime projection、ContextItem[]、tokenCount、provenance、diagnosticsRef
```

每个 ContextItem 至少有 `sourceRef`、内容/受限片段、路径和行范围（如适用）、内容摘要、选择理由、tokenCount 与来源 revision。

### 4.1 token budget

模型的最大上下文长度和预留输出空间由模型定义、Workflow 策略和 Kernel 准入共同约束。ContextEngine 接收本轮 token budget，只负责严格在预算内打包。

```text
先放：任务目标、验收条件、当前 revision、最近关键错误
再放：显式文件引用、query 直接命中
最后放：排序最高的代码 / 测试 Chunk
放不下：保存 ArtifactRef 与 provenance，不复制内容
```

M1 不依赖 LLM 自动摘要。后续若引入压缩器，摘要必须记录输入 Artifact、压缩器版本和可回查来源，不能成为唯一事实。

### 4.2 渲染安全

ContextEngine 不将外部代码、网页、日志或测试输出拼入 system / developer instruction。`ContextRenderer` / Model adapter 将结构化 Pack 映射为 provider-native messages，保持原生 tool-call 与 tool-result 配对。来源标记是软防线；真正的工具权限仍由 Kernel 独立强制。

## 5. 检索与 provenance 流水线

```text
ContextRequest
→ 固定 workspace、snapshot、revision 和可读来源
→ 归一化 objective、Agent query、路径提示和最近 Observation
→ 来源发现、分块、建立或选择检索视图
→ 召回候选
→ 范围 / revision / 类型 / 大小过滤
→ 排序、去重、多样性控制
→ token budget 打包
→ ContextPack + RetrievalResult diagnostics + provenance
```

### 5.1 M1 lexical retrieval

M1 是 lexical code RAG。候选主要来自：显式路径、测试失败堆栈和断言文本、Agent query 的标识符/字符串、文件名与同目录测试关系、`rg` 命中。

排序先使用可解释的确定性信号：显式路径、精确标识符、错误关联、测试关联、词项覆盖、最近已使用内容的降权。并列时使用稳定 tie-breaker，且限制单一文件占用整个 Pack。

`rg` 调用必须使用参数数组、时间和结果上限；Agent 文本不能直接成为 shell 字符串或无限制正则。

### 5.2 未来检索器

```text
LexicalRetriever：路径、rg、测试错误                    （M1）
SymbolRetriever ：tree-sitter / SCIP 定义和引用           （后续）
DenseRetriever  ：embedding 与向量相似度                 （后续实验）
HybridMerger    ：合并多路候选                            （后续）
Reranker        ：对有限候选进行精排                     （最后加入）
```

新检索器只能作为候选生成器；所有候选仍须经过相同的数据范围、revision、大小、去重和 token budget 规则。开源 embedding 模型是否加入，应由 lexical / dense / hybrid 的 fixture 评测决定。

### 5.3 provenance

provenance 需要让系统回答：“模型为什么看到这段内容？”每项至少记录来源、来源类型、snapshot/revision、内容摘要、召回方法、选择理由、索引版本和观察时间。

provenance 证明的是来源与选择过程，不证明内容一定正确或已通过任务验收；它不能替代 Kernel 的授权或 Workflow 的验收。

## 6. 二级组件

M1 可以是模块化单体；下列划分用于隔离变化，不是微服务计划。

| 组件 | 长期职责 | M1 实现 |
|---|---|---|
| `ContextRequestGateway` | 校验请求、关联 correlation、返回结构化结果 | `ContextPort` facade |
| `SnapshotManager` | 建立、复用、失效 RepositorySnapshot | worktree 扫描与 Git/内容摘要 |
| `SourceDiscovery` / `RecordBuilder` | 发现允许来源、标准化为 Record / Chunk | 文件、测试输出、稳定文本分块 |
| `IndexCoordinator` | 选择和构建 IndexRevision | lexical view，无独立索引服务 |
| `RetrievalCoordinator` | 归一化 query、调用检索器、合并候选 | `LexicalRetriever` |
| `CandidatePolicy` | 过滤、去重、多样性、稳定排序 | 确定性规则 |
| `PackAssembler` | 按预算生成唯一的 ContextPack | `PINNED` + `RANKED` packing |
| `ProvenanceRecorder` | 保存选择理由与诊断 | run-scoped JSON / Artifact |

`ContextRenderer` 不属于 ContextEngine 领域组件：它是 Kernel / Model adapter 的 provider 适配层，不能让 ContextEngine 开始拥有模型 SDK 或 Prompt 定义。

## 7. 跨 Module 协议

### 7.1 M1

```text
Workflow / AgentRun Coordinator
  → ContextPort.buildContext(ContextRequest)
  → ContextEngine
  → ContextPack 或结构化 ModuleError
  → Workflow
```

M1 仅简化 transport。所有请求仍带运行标识、workspace、目标、query、Observation 引用、token budget 和 correlation；Workflow 不读 ContextEngine 内部缓存，ContextEngine 不写 Workflow 聚合。

### 7.2 长期 Context Unit

```text
Workflow
  → UnitIntent(CONTEXT_QUERY / INDEX_BUILD / EMBEDDING / RERANK)
  → Kernel：Policy、数据范围、revision、budget、Lease
  → ContextEngine Executor
  → ContextPackRef + diagnostics + usage
  → Kernel UnitAttempt Event
  → Workflow
```

Kernel 的 permit 绑定 Scope、AgentRun、workspace、允许来源、Artifact 范围、token budget、revision、租约和 policy version。ContextEngine 在 permit 范围内执行，不直接回调 Workflow。

### 7.3 与 AgentToolPool 和 Artifact Store

AgentToolPool 只提供版本化的 `ContextProfile`、Agent / Tool / Model / Prompt 定义；ContextEngine 不读真实凭据、动态权限或完整 system prompt。

原始大对象、完整 Pack、检索诊断、测试输出和 diff 应以 ArtifactRef 保存。ContextEngine 拥有“为什么选择这个 Artifact”的 provenance，不拥有对象字节、访问许可或保留策略。

## 8. 不变量与验收

### 8.1 长期不变量

1. 每个 ContextPack 可回溯到请求、workspace、revision 与每个 Item 的来源。
2. workspace 内容、来源权限、检索器版本或 token budget 改变后，不复用不兼容 Pack。
3. ContextEngine 不接受任意本机路径，不通过 symlink 或 ArtifactRef 绕过范围。
4. 外部文本作为数据进入模型；模型自述不成为系统事实。
5. Pack 不可变；snapshot/index 可重建并可标记 stale。
6. ContextEngine 的过滤不能替代 Kernel 的鉴权，检索命中不能替代 Workflow 的验收。

### 8.2 M1 验收

- 未知文件的失败测试能召回正确文件和关键片段；
- 测试失败后能够基于新的 Observation 重建下一轮 Pack；
- Pack 记录路径、revision、token、选择理由和 provenance；
- workspace 外来源、超大输入和 token 不足被确定性拒绝或降级；
- 固定 fixture 记录 File/Chunk 命中、token、耗时和 Agent 结果，为 embedding 实验建立 baseline。

## 9. 待决 ADR

以下问题在真正进入对应阶段前单独写 ADR，不在本文假装已经决定：

1. `workingTreeDigest` 的具体算法与 snapshot 缓存策略；
2. M1 tokenizer 与模型 provider 的选择；
3. embedding 实验的本地运行方式、模型许可与评测阈值；
4. tree-sitter 与 SCIP 的接入顺序；
5. 跨 Session 用户记忆的同意、删除、冲突和过期策略；
6. 长期 Context Unit 的 ExecutionPermit、Artifact ACL 与数据库 schema。
