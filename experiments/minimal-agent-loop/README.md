# Minimal Agent Loop Experiment

这个目录用于独立验证最小 Agent 闭环，不属于当前 M1 的正式实现。

## 当前状态

当前只提供可编译的工程骨架。所有组件均为空实现，不会发起模型 API 请求、网络搜索、文件操作或其他副作用。

## 组件

```text
src/
├── agent-tool-pool.ts
├── context-engine.ts
├── contracts.ts
├── kernel.ts
├── runtime.ts
├── workflow.ts
└── executors/
    ├── api-call-executor.ts
    └── web-search-executor.ts
```

- `AgentToolPool`：未来通过只读 Port 提供版本化的 Agent、Prompt 和工具定义。
- `MinimalWorkflow`：未来在内部承载 Agent Loop，通过只读 Port 使用静态定义和 ContextEngine。
- `MinimalContextEngine`：未来通过只读 Port 获取已固定的 Prompt，并组装单轮上下文。
- `MinimalKernel`：对外承接最简用户输入，对内转发 Workflow 和外部 Executor 请求。
- `ApiCallExecutor`：未来封装模型 API 调用。
- `WebSearchExecutor`：未来封装 Web Search 调用。
- `createExperimentRuntime`：组合上述组件的唯一入口。

## 最小调用链

```text
调用方 / 集成测试
       |
       | UserRequest
       v
MinimalKernel.run()                 最简 UserInteraction
       |
       | ModuleRequest / ModuleResponse
       v
MinimalWorkflow                     内部运行 Agent Loop
       |
       +-- ContextReader -------> ContextEngine
       +-- Kernel.dispatch() --> ApiCallExecutor
       +-- Kernel.dispatch() --> WebSearchExecutor

MinimalWorkflow ---- AgentDefinitionReader ---> AgentToolPool
ContextEngine ------ PromptTemplateReader ----> AgentToolPool
                         只读、版本固定、不经过 Kernel
```

本实验不建立独立的 UserInteraction 模块。`MinimalKernel.run()` 直接接收用户的
`prompt`，将其转换为 Workflow 目标，并把最终答案转换为 `UserResponse`。除这层最简使用逻辑外，Kernel 不拥有 Agent 决策、上下文构建或具体执行行为。

模型调用和 Web Search 等外部执行统一经过 `KernelChannel.dispatch()`。上下文构建不经过
Kernel：Workflow 通过只读 `ContextReader` 直接请求 ContextEngine。AgentToolPool 的不可变静态定义也不经过 Kernel：Workflow 通过 `AgentDefinitionReader` 读取并固定 Agent 与工具版本；ContextEngine 通过 `PromptTemplateReader` 解引用 Workflow 已选定的 `promptRef`。这些模块都不依赖彼此的内部存储或具体实现。

Workflow 决定使用哪个 Agent 和 Prompt。ContextEngine 不允许按名称获取“最新 Prompt”，只能读取 `ContextRequest.promptRef` 指定的精确版本，避免同一次运行中出现定义漂移。

## 使用方式

当前阶段不需要 CLI。优先通过集成测试或一个 TypeScript 调用入口使用 Runtime：

```ts
const runtime = createExperimentRuntime();
const result = await runtime.kernel.run({ prompt: '需要完成的任务' });
```

骨架尚未实现路由和执行，因此该调用当前会返回 `NotImplementedError`。完成最小闭环后，如果需要人工反复运行，再增加一个只负责读取命令行参数并调用 `kernel.run()` 的薄 CLI；CLI 不承载 Workflow 或 Agent 逻辑。

## 运行示例：武汉大学 150 字报告

目标任务：

```text
上网搜索武汉大学信息，整理出150字报告
```

预期调用方式：

```ts
const runtime = createExperimentRuntime();
const result = await runtime.kernel.run({
  prompt: '上网搜索武汉大学信息，整理出150字报告',
});

if (result.ok) console.log(result.value.answer);
```

目标运行流程：

1. 调用方把 Prompt 作为 `UserRequest` 交给 `MinimalKernel.run()`。
2. Kernel 选择默认 Agent 版本，把用户输入转换为携带 `agentRef` 的 `WorkflowRequest`，再将请求路由到 Workflow。
3. Workflow 通过 `AgentDefinitionReader` 直接只读 AgentToolPool，固定本次运行使用的 Agent、`promptRef` 和 Web Search 工具版本。
4. Workflow 通过 `ContextReader` 直接向 ContextEngine 发送包含目标、`promptRef` 和空 Observation 列表的 `ContextRequest`。
5. ContextEngine 通过 `PromptTemplateReader` 直接只读 AgentToolPool，取得精确版本的 Prompt 模板并返回初始 `ContextPack`。
6. Workflow 经 Kernel 调用 ApiCallExecutor；模型根据 ContextPack 和工具签名返回 `TOOL_CALL`，例如搜索“武汉大学 学校简介 历史 学科 校园”。
7. Workflow 经 Kernel 调用 WebSearchExecutor，并把 `WebSearchResponse` 保存为 `ToolObservation`。
8. Workflow 再次通过 `ContextReader` 直接调用 ContextEngine；ContextEngine 使用相同的 `promptRef`，将搜索结果组装进新的 ContextPack。
9. Workflow 再次经 Kernel 调用 ApiCallExecutor；模型返回包含报告字符串的 `FINAL` Action。
10. Workflow 验收结果并返回 `WorkflowOutput`，Kernel 再将其中的 `answer` 转换为 `UserResponse` 交给调用方。

```text
UserRequest
    -> Kernel
    -> Workflow
       -> AgentToolPool          只读 Agent 与 Tool 定义
       -> ContextEngine -> AgentToolPool  只读 Context 与 Prompt
       -> Kernel -> ApiCallExecutor
       -> Kernel -> WebSearchExecutor
       -> ContextEngine
       -> Kernel -> ApiCallExecutor
    -> Kernel
    -> UserResponse.answer
```

当前 `150字` 只是自然语言要求，模型可能返回近似长度。若需要确定性保证，后续应把目标字符数和必须使用 `web_search` 写入结构化 Workflow 约束，由 Workflow 检查搜索 Observation 和最终字符数；不满足时进入下一轮修正，超过最大步骤数后返回失败。

## 边界

- 不依赖 `apps/*` 或 `packages/*` 中的正式模块。
- 不复用当前 M1 Shared Contracts，避免实验提前继承正式架构假设。
- Agent Loop 当前是 Workflow 的内部实现细节，不建立独立模块边界。
- 最简 UserInteraction 由 Kernel 的公开入口承担，不建立独立模块。
- 模型与 Web Search 等外部执行通过 KernelChannel；上下文和版本化静态定义通过窄只读 Port 直接查询。
- Workflow 只能通过 ContextReader 使用 ContextEngine，不能访问其具体实现或内部状态。
- Workflow 和 ContextEngine 不能直接访问 AgentToolPool 的存储，只能使用各自获准的 Reader。
- 在明确最小消息协议和验收场景前，不增加真实实现。
