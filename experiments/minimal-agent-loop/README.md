# Minimal Agent Loop Experiment

这个目录用于独立验证面向本地代码仓库的最小只读 Agent 闭环，不属于当前 M1 的正式实现。

实验目标是分析一个约 200 行的本地 C 语言代码仓库。用户提出代码审查问题后，Agent 根据初始仓库概览选择文件和行范围，通过受控的 `file_read` 工具获取证据，最终以文字报告说明问题、来源和建议修改方法。实验不直接修改代码，也不执行编译、测试、命令或网络访问。

## 当前状态

当前只提供可编译的工程骨架。所有组件均为空实现，不会发起模型 API 请求、读取文件或产生其他副作用。

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
    ├── file-read-executor.ts
    └── model-executor.ts
```

- `AgentToolPool`：未来通过只读 Port 提供版本化的 Agent、Prompt 和 `file_read` 工具定义。
- `MinimalWorkflow`：未来在内部承载 Agent Loop，通过只读 Port 使用静态定义和 ContextEngine。
- `MinimalContextEngine`：未来通过只读 Port 获取已固定的 Prompt，生成仓库文件概览，并组装每轮上下文。
- `MinimalKernel`：对外承接最简用户输入，对内转发 Workflow、ModelExecutor 和 FileReadExecutor 请求。
- `ModelExecutor`：未来封装模型调用，返回结构化的 `TOOL_CALL` 或 `FINAL` 动作。
- `FileReadExecutor`：未来在固定仓库根目录和 revision 下按路径、行范围执行受控只读访问。
- `createExperimentRuntime`：组合上述组件的唯一入口。

## 最小调用链

```text
调用方 / 集成测试
       |
       | UserRequest(prompt, repository)
       v
MinimalKernel.run()                 最简 UserInteraction
       |
       | ModuleRequest / ModuleResponse
       v
MinimalWorkflow                     内部运行 Agent Loop
       |
       +-- ContextReader -------> ContextEngine
       +-- Kernel.dispatch() --> ModelExecutor
       +-- Kernel.dispatch() --> FileReadExecutor

MinimalWorkflow ---- AgentDefinitionReader ---> AgentToolPool
ContextEngine ------ PromptTemplateReader ----> AgentToolPool
                         只读、版本固定、不经过 Kernel
```

本实验不建立独立的 UserInteraction 模块。`MinimalKernel.run()` 直接接收用户的 `prompt` 和固定的 `repository`，将其转换为 Workflow 目标，并把最终报告转换为 `UserResponse`。除这层最简使用逻辑外，Kernel 不拥有 Agent 决策、上下文构建或具体执行行为。

模型调用和文件读取统一经过 `KernelChannel.dispatch()`。模型只能提出 `file_read` 动作，不能指定或扩大仓库根目录；Workflow 将模型给出的相对路径和行范围与本次运行固定的 `RepositoryRef` 组合后，再交给 Kernel 和 FileReadExecutor。

上下文构建不经过 Kernel：Workflow 通过只读 `ContextReader` 直接请求 ContextEngine。AgentToolPool 的不可变静态定义也不经过 Kernel：Workflow 通过 `AgentDefinitionReader` 读取并固定 Agent 与工具版本；ContextEngine 通过 `PromptTemplateReader` 解引用 Workflow 已选定的 `promptRef`。这些模块都不依赖彼此的内部存储或具体实现。

Workflow 决定使用哪个 Agent 和 Prompt。ContextEngine 不允许按名称获取“最新 Prompt”，只能读取 `ContextRequest.promptRef` 指定的精确版本，避免同一次运行中出现定义漂移。

## 使用方式

当前阶段不需要 CLI。优先通过集成测试或一个 TypeScript 调用入口使用 Runtime：

```ts
const runtime = createExperimentRuntime();
const result = await runtime.kernel.run({
  prompt: '检查这个 C 语言仓库中可能导致崩溃、内存错误或错误结果的问题，并说明修改方法。',
  repository: {
    rootPath: './fixtures/c-review',
    revision: 'fixture-c-review-v1',
  },
});
```

骨架尚未实现路由和执行，因此该调用当前会返回 `NotImplementedError`。完成最小闭环后，如果需要人工反复运行，再增加一个只负责读取命令行参数并调用 `kernel.run()` 的薄 CLI；CLI 不承载 Workflow 或 Agent 逻辑。

## 运行示例：约 200 行 C 语言仓库代码审查

示例仓库可以拆分为少量 `.c` 和 `.h` 文件，总代码量约 200 行：

```text
fixtures/c-review/
├── include/
│   └── parser.h
└── src/
    ├── main.c
    ├── parser.c
    └── util.c
```

目标任务：

```text
检查这个 C 语言仓库中可能导致崩溃、内存错误或错误结果的问题。
对每个问题给出文件路径、行范围、原因和建议修改方法，但不要直接修改代码。
```

预期调用方式：

```ts
const runtime = createExperimentRuntime();
const result = await runtime.kernel.run({
  prompt:
    '检查这个 C 语言仓库中可能导致崩溃、内存错误或错误结果的问题。' +
    '对每个问题给出文件路径、行范围、原因和建议修改方法，但不要直接修改代码。',
  repository: {
    rootPath: './fixtures/c-review',
    revision: 'fixture-c-review-v1',
  },
});

if (result.ok) console.log(result.value.answer);
```

目标运行流程：

1. 调用方把 Prompt 和 `RepositoryRef` 作为 `UserRequest` 交给 `MinimalKernel.run()`。
2. Kernel 选择默认 Agent 版本，把输入转换为携带 `agentRef` 和固定仓库引用的 `WorkflowRequest`，再将请求路由到 Workflow。
3. Workflow 通过 `AgentDefinitionReader` 直接只读 AgentToolPool，固定本次运行使用的 Agent、`promptRef` 和 `file_read` 工具版本。
4. Workflow 通过 `ContextReader` 向 ContextEngine 发送目标、仓库引用、`promptRef` 和空 Observation 列表。
5. ContextEngine 取得精确版本的 Prompt，生成只包含目录和候选源码文件的初始仓库概览，不一次性注入全部源码。
6. Workflow 经 Kernel 调用 ModelExecutor；模型根据 ContextPack 和工具签名返回 `TOOL_CALL(file_read)`，指定相对路径和可选行范围。
7. Workflow 把模型参数与固定 `RepositoryRef` 组合，经 Kernel 调用 FileReadExecutor，并把带路径、行范围、revision 和截断状态的结果保存为 `ToolObservation`。
8. Workflow 再次调用 ContextEngine，使用相同 `promptRef` 将新的 Observation 组装进 ContextPack。
9. Workflow 重复 Model → FileRead → Context，直到模型取得足够证据或到达步骤预算。
10. 模型返回 `FINAL`；Workflow 验收报告引用的文件和行范围后返回 `WorkflowOutput`，Kernel 再将报告转换为 `UserResponse`。

```text
UserRequest
    -> Kernel
    -> Workflow
       -> AgentToolPool                 只读 Agent 与 Tool 定义
       -> ContextEngine -> AgentToolPool  只读 Context 与 Prompt
       -> Kernel -> ModelExecutor
       -> Kernel -> FileReadExecutor
       -> ContextEngine
       -> Kernel -> ModelExecutor
       -> ...
       -> FINAL
    -> Kernel
    -> UserResponse.answer
```

示例问题应能通过纯源码静态阅读判断，例如越界访问、少分配一个终止字符、未初始化变量、遗漏资源释放或错误码被忽略。不要把答案文件名写进用户问题，也不要选择必须运行编译器或测试才能确认的问题。

## `file_read` 边界

- 模型只提供相对 `path` 和可选的 `startLine`、`endLine`，不能提供仓库根目录或 revision。
- Workflow 使用运行开始时固定的 `RepositoryRef` 构造 `FileReadRequest`。
- Executor 应拒绝绝对路径、`..`、symlink/junction 逃逸和非普通文本文件。
- 返回内容应包含实际路径、revision、起止行、总行数和 `truncated`。
- 单次读取必须具有行数或字节上限；需要更多内容时由模型继续发起读取。

## 边界

- 不依赖 `apps/*` 或 `packages/*` 中的正式模块。
- 不复用当前 M1 Shared Contracts，避免实验提前继承正式架构假设。
- Agent Loop 当前是 Workflow 的内部实现细节，不建立独立模块边界。
- 最简 UserInteraction 由 Kernel 的公开入口承担，不建立独立模块。
- 模型与文件读取通过 KernelChannel；上下文和版本化静态定义通过窄只读 Port 直接查询。
- Workflow 只能通过 ContextReader 使用 ContextEngine，不能访问其具体实现或内部状态。
- Workflow 和 ContextEngine 不能直接访问 AgentToolPool 的存储，只能使用各自获准的 Reader。
- 实验不提供文件写入、命令、测试、Git、网络或其他副作用能力；相关动作必须明确失败。
- 在明确最小消息协议和验收场景前，不增加真实实现。
