# ContextEngine Module Design

> 文档类型：模块设计草案
>
> 状态：待组内评审；定稿后迁入 `feat/originPlan`。
>
> 当前目标：M1 单 Agent Coding MVP

## 1. ContextEngine 要解决什么问题

`ContextEngine` 负责把当前任务真正需要的代码和运行证据，组织为有来源、受版本约束、受 token budget 限制的 `ContextPack`。

它不保存全部聊天记录，不决定任务是否成功，也不执行文件或命令操作。

```text
Workflow 提出上下文需求
        ↓
ContextEngine 检索并构造 ContextPack
        ↓
Agent 基于 ContextPack 提出下一步 Action
        ↓
Kernel 执行获准的模型或工具操作
```

### 职责边界

| 模块 | 负责 | ContextEngine 不负责 |
|---|---|---|
| Workflow | Task、AgentRun、循环、验收 | ContextEngine 不改变任务状态。 |
| Kernel | workspace、权限、命令、模型和工具执行 | ContextEngine 不读任意路径、不执行 shell、不签发权限。 |
| AgentToolPool | Agent、Tool、Prompt、Model 的静态定义 | ContextEngine 不维护 system prompt 或工具目录。 |
| Artifact Store | 原始大对象和内容完整性 | ContextEngine 只引用和选择 Artifact。 |
| ContextEngine | 检索、过滤、裁剪、provenance、ContextPack | 不把“找到了内容”当作任务完成。 |

## 2. M1 范围

M1 实现的是基于本地代码仓库的 lexical RAG，不是完整的长期记忆或向量知识库。

| M1 必须实现 | M1 明确不实现 |
|---|---|
| 隔离 worktree 的文件树与 Git / 工作树版本绑定 | embedding、pgvector、reranker、SCIP、tree-sitter |
| 路径匹配、`rg`、测试错误线索和代码 Chunk | 用户跨 Session 记忆、自动学习 procedure |
| token budget、去重、稳定排序、provenance | 独立索引服务、外部 Web / Drive / Notion connector |
| 本次 AgentRun 的关键 Observation 和 Artifact 引用 | LLM 自动总结并作为唯一事实来源 |

M1 的 memory 只有三类：当前 AgentRun 的工作记忆、本次 Run 的步骤/测试证据、以及受当前 revision 约束的代码库知识。Task 状态属于 Workflow，执行状态属于 Kernel，不属于 ContextEngine memory。

## 3. M1 的输入、输出与生命周期

Workflow 通过进程内 `ContextPort` 请求上下文。M1 简化的是 transport，不是模块边界：Workflow 不能读取 ContextEngine 的内部实现，ContextEngine 不能直接改写 Workflow 状态。

```ts
interface ContextRequest {
  workflowRunId: string;
  taskRunId: string;
  agentRunId: string;
  workspaceRef: string;
  objective: string;
  query?: string;
  previousObservationRefs: ArtifactRef[];
  tokenBudget: number;
}

interface ContextPack {
  contextPackId: string;
  workspaceRef: string;
  repositoryRevision: string;
  items: ContextItem[];
  tokenCount: number;
  provenance: ProvenanceEntry[];
}
```

一个 `ContextItem` 至少包含内容、来源、路径和行范围（如适用）、选择理由、token 数量及内容摘要。`ContextPack` 发布后不可原地修改。

一次请求的生命周期：

```text
ContextRequest
→ 固定当前 worktree snapshot
→ 召回并过滤候选
→ 按 token budget 选择内容
→ 发布 ContextPack 与 provenance
→ 下一轮 AgentStep 使用它
```

Agent 修改 worktree 后，旧 `ContextPack` 仍保留用于审计，但不能当作当前代码事实；下一轮必须基于新的 snapshot 重新检索。

## 4. M1 检索与打包流程

```text
objective / Agent query / 测试错误 / 上轮 Observation
                         ↓
                文件树、路径匹配、rg
                         ↓
                  代码与证据 Chunk
                         ↓
      范围过滤、revision 检查、去重、稳定排序
                         ↓
              token budget 下的 ContextPack
```

M1 采用以下规则：

1. 只读取 `workspaceRef` 范围内、可解码且非二进制的允许文件和 Artifact。
2. 先保留任务目标、验收条件、当前 revision 和最近关键错误；再加入 query 的直接命中和高相关代码 Chunk。
3. 对相同文件设置上限，避免长文件占满 ContextPack。
4. 超出预算时裁剪内容并保留 `ArtifactRef`，不无限追加历史，不依赖 LLM 自动摘要。
5. 同一 request、snapshot、检索器版本和 budget 下，应尽可能产生同样的 Pack 顺序。

`ContextPack` 不是完整 prompt。模型调用时，AgentToolPool 提供静态 Agent / Tool 定义，Workflow 提供任务事实，Kernel 提供当前权限投影，ContextEngine 只提供运行时证据包。

## 5. M1 的最小内部结构

M1 不需要将这些能力拆成服务，但代码应保留以下职责边界：

| 部分 | 职责 |
|---|---|
| `SnapshotManager` | 将授权 worktree 解析为当前文件视图和 revision。 |
| `LexicalRetriever` | 使用路径、`rg`、测试错误和 query 生成候选 Chunk。 |
| `PackAssembler` | 过滤、排序、去重、按 token budget 选择并发布 ContextPack。 |
| `ProvenanceRecorder` | 保存来源、选择理由、revision、token 使用和诊断。 |

后续的 symbol retrieval、dense retrieval、hybrid retrieval 和 reranker 都只能作为 `LexicalRetriever` 的并列替换或补充，不能改变 Workflow 调用 `ContextPort` 的方式。

## 6. 不变量与安全边界

1. 每个 ContextPack 必须能回溯到 workspace、repository revision、请求和每个 Item 的来源。
2. ContextEngine 不接受任意本机路径；路径解析和 symlink 后仍必须位于授权 workspace 内。
3. ContextEngine 不扩大权限；它对数据范围的过滤是防御性复核，不能替代 Kernel 鉴权。
4. 外部代码、测试输出和文档都是数据，不得拼入 system / developer instruction。
5. 模型的自然语言自述不能成为任务、权限、预算或执行结果的权威事实。
6. 完整工具输出、diff 和大型文档以 ArtifactRef 保存；ContextPack 只放本轮需要的受限片段。
7. token budget 不足时返回结构化错误，不能静默丢弃任务目标或最新失败证据。

## 7. M1 验收

ContextEngine 在固定 fixture 上至少证明：

- 能从未知目标文件的报错中召回正确文件和关键代码片段；
- 能在测试失败后依据新的 Observation 构造下一轮 ContextPack；
- 不泄露 workspace 外文件，原始 checkout 不被修改；
- 每个 Pack 带来源、revision、token 统计和选择理由；
- 超过 token 或来源边界时确定性失败，而不是输出不可解释的上下文；
- 记录命中关键文件 / Chunk 的比例、token 用量和检索耗时，作为后续 embedding 实验的 baseline。

## 8. 后续演进约束

长期版本可加入持久 snapshot、tree-sitter / SCIP、embedding、PostgreSQL + pgvector、hybrid retrieval、reranker、跨 Agent Artifact 交接和用户记忆。

这些能力必须保持以下接口语义不变：Workflow 描述需要什么；ContextEngine 决定如何检索；Kernel 决定允许读取什么；Agent 只消费 ContextPack 并提出 Action。
