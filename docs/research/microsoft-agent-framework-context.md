# Microsoft Agent Framework：上下文管理研究笔记（第一轮）

研究对象：`microsoft/agent-framework`，本地副本位于工作区的 `references/microsoft-agent-framework`。

- 分支：`main`
- 本次阅读提交：`723256961e8e46980b869ee2c75ef05f16644921`
- 目标：提炼可迁移到 MultiAgentOS `ContextEngine` 的设计原则；不直接复制 Microsoft Agent Framework（MAF）的对象模型或 Python 实现。

## 先给结论

MAF 的 `ContextProvider` 不是独立的上下文服务。它是**某个 AgentRun 内部的可组合插件管线**：在模型调用前注入消息、指令、工具或中间件；在调用后保存历史、提取记忆或压缩会话。

这与 MultiAgentOS 的 `ContextEngine` 处于不同抽象层：

```text
MultiAgentOS ContextEngine（跨 Task / Scope / Artifact 的上下文控制面）
  └─ 为某次 AgentRun 生成经过授权、可审计、受 token 预算限制的 ContextPack
       └─ 可选：Agent 运行时内部采用 MAF 风格 ContextProvider 管线
```

因此，MAF 是很好的实现参考，但不能直接等同于本项目的 ContextEngine。

## MAF 当前的核心模型

### 1. Agent 拥有 Provider，Session 拥有可变状态

- 一个 Agent 配置一组有序的 `ContextProvider`。
- Provider 是可复用的定义实例；它本身不应保存每个会话的可变状态。
- 每个 `AgentSession` 持有 `state: dict`；每个 Provider 以 `source_id` 作为自己的状态命名空间。
- Provider 必须给出稳定的 `source_id`，以便区分上下文来源、工具来源和持久化状态。

这个归因设计很值得复用：本项目的每个上下文片段都不应只是字符串，而应能追溯其来源、版本、权限依据与产生时间。

### 2. 每次调用建立 SessionContext

MAF 在一次模型调用前构造一个临时 `SessionContext`，它至少包含：

- 输入消息；
- 按 Provider 来源分组的上下文消息；
- 指令；
- 可用工具；
- Provider 注入的 chat/function middleware；
- 调用后的响应。

Provider 的统一钩子为：

```python
async def before_run(*, agent, session, context, state) -> None:
    # 添加 messages / instructions / tools / middleware

async def after_run(*, agent, session, context, state) -> None:
    # 保存历史、抽取记忆、压缩或记录结果
```

Provider 按注册顺序执行 `before_run`，以相反顺序执行 `after_run`。这让“先取历史，再取 RAG，最后压缩/持久化”的顺序成为显式配置，而不是隐含行为。

### 3. 历史是一个 Provider，而不是唯一上下文

`HistoryProvider` 继承 `ContextProvider`，以统一方式处理：

- 调用前加载历史；
- 调用后保存输入、模型输出；
- 可选保存其他 Provider 注入的上下文；
- 可设为只写的审计/评测存储，而不加载到模型上下文。

这点特别重要：**“保存了什么”与“下次给模型看什么”不是同一件事。**

## MAF 的四个可迁移设计

### A. 上下文来源归因（source attribution）

MAF 将 `source_id` 写入消息的 attribution，并按来源保留 `context_messages`。它使其他 Provider 可以：

- 只读取指定来源；
- 排除不该再注入的来源；
- 只持久化允许持久化的来源；
- 判断一段上下文是否来自其他 Session。

本项目应将此扩展为 `ContextItem.provenance`，至少记录：

```text
source_type        history | artifact | code | retrieval | user | workflow | tool
source_id          稳定来源标识
artifact_ref       不可变原始证据（如有）
scope_id           可见性与权限范围
revision           Workflow / workspace / index 版本
created_at
integrity_hash
```

### B. 前后两个阶段

MAF 将上下文工作分为调用前的 `before_run` 与调用后的 `after_run`。

迁移到本项目时可对应为：

| 阶段 | ContextEngine 工作 |
|---|---|
| `prepare` | 校验 Scope/权限、检索、重排、摘要、预算裁剪，生成 `ContextPack` |
| `record` | 记录实际使用的 pack、模型/工具结果、摘要候选、索引更新请求和评测元数据 |

`prepare` 的产物应不可变、可复现；`record` 不应悄悄修改已经用于本次执行的 ContextPack。

### C. 历史与 RAG 的选择性持久化

MAF 的 `HistoryProvider` 可控制是否加载历史、是否保存输入、输出以及其他 Provider 的内容。这避免把每次 RAG 结果、工具长输出和聊天记录无差别混入永久历史。

本项目的最小策略应是：

- 原始网页、代码片段、工具输出写入 Artifact Store；
- Workflow/Session 保存摘要、结构化结论及 `ArtifactRef`；
- ContextEngine 依据当前任务重新选择并投影必要内容；
- 禁止默认把每次检索全文持久化为下一轮 prompt。

### D. 压缩不是简单截断

MAF 的 `CompactionProvider` 支持调用前和调用后两类压缩：

- 调用前：把已加载历史压到模型输入预算内；
- 调用后：压缩持久化历史，减少下一轮加载量。

它特别处理 assistant 工具调用与其 tool result 的原子关系，避免截断后留下孤立的工具结果或无对应结果的调用。这是 ContextEngine 必须遵守的消息正确性约束。

MAF 提供的策略方向包括 sliding window、按 token 预算裁剪、旧工具结果压缩和 LLM summarization。摘要会成为长期上下文的一部分，因此存在间接提示注入和事实漂移风险；不得作为 V1 默认路径。

## 与 MultiAgentOS 的接口草案

以下不是最终 schema，而是本周与 Workflow / Kernel 对齐时应讨论的最小契约。

### ContextEngine 接收的请求

```ts
type ContextRequest = {
  requestId: string
  workflowRunId: string
  taskAttemptId: string
  agentRunId: string
  processScopeId: string
  agentDefinitionRef: string
  objective: string
  phase: "plan" | "execute" | "review" | "repair"
  workspaceRevision?: string
  inputArtifactRefs: string[]
  tokenBudget: number
  requiredSources: Array<"task" | "history" | "code" | "artifact" | "retrieval">
}
```

### ContextEngine 对外的结果

```ts
type ContextPack = {
  contextPackId: string
  requestId: string
  revision: number
  items: ContextItem[]
  renderedPromptParts: PromptPart[]
  estimatedTokens: number
  budget: number
  provenance: ProvenanceRecord[]
  artifactRef: string
  expiresAt?: string
}
```

`ContextPack` 应是某次 AgentRun 实际使用上下文的不可变快照。模型 prompt 可以由它渲染，但不能成为唯一记录。

### 依赖其他模块的接口

| 提供者 | ContextEngine 需要的内容 | 不应由其提供的内容 |
|---|---|---|
| Workflow | 当前目标、Task/Attempt、Scope、阶段、已接受的上游 ArtifactRef、token 预算 | 直接拼接好的最终 prompt |
| Kernel | 已批准的读取能力、workspace/artifact 访问句柄、资源/时限限制 | 业务上哪些证据“应该”被选中 |
| AgentToolPool | Agent 定义版本、Context Profile、允许工具、prompt 模板变量 | 运行期可变会话状态 |
| Persistence / Artifact | 可检索元数据、不可变原文与索引版本 | 未经授权的全局数据扫描 |

### ContextEngine 应向其他模块承诺

- 返回的每个 Pack 在 Scope、预算和数据权限上已经通过校验；
- 所有上下文片段都可追溯到来源和版本；
- 同一请求在同一数据/index revision 下可重建，或明确标注不可重建原因；
- 只返回内容与证据引用，不直接执行模型、shell 或工具；
- 以 `ContextBuilt` / `ContextBuildFailed` 事件报告事实，不自行推进 Workflow 状态。

## 第一周阅读顺序

按下面顺序阅读，不建议一开始进入 Azure、Redis、Mem0 等具体集成：

1. `docs/decisions/0016-python-context-middleware.md`：为什么 MAF 将历史、RAG、指令和工具统一为 Context Provider；
2. `python/packages/core/agent_framework/_sessions.py`：`SessionContext`、`ContextProvider`、`HistoryProvider` 的实际接口；
3. `python/samples/02-agents/context_providers/simple_context_provider.py`：最小 Provider；
4. `python/samples/02-agents/context_providers/cross_session_observer.py`：跨 Session 来源归因；
5. `docs/decisions/0019-python-context-compaction-strategy.md` 与 `_compaction.py`：token 预算、工具调用组与压缩；
6. `python/samples/02-agents/compaction/`：策略的最小示例；
7. `python/samples/02-agents/context_providers/azure_ai_search/`：最后再看 RAG 检索实现。

## 暂时不照搬的部分

- 将完整聊天历史直接作为跨 Agent 共享机制；
- 让 Agent 自己决定是否读取任意 Session 或 Artifact；
- 把 MAF 的 Provider state dict 直接视为 durable workflow checkpoint；
- 把 LLM 摘要视为可信、可替代的原始证据；
- V1 就接入多个外部 memory/vector database 提供商。

## 下一步

完成上述第 1–4 项阅读后，产出一页 `ContextEngine` 接口设计：对象表、状态归属、首个 `ContextRequest → ContextPack` 时序，以及一个可测试的 V1 检索场景。此时再与 Workflow / Kernel 负责人共同锁定契约。
