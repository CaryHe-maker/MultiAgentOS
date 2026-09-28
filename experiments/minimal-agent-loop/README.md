# Minimal Agent Loop Experiment

这个目录用于独立验证最小 Agent 闭环，不属于当前 M1 的正式实现。

## 当前状态

当前只提供可编译的工程骨架。所有组件均为空实现，不会发起模型 API 请求、网络搜索、文件操作或其他副作用。

## 组件

```text
src/
├── agent-loop.ts
├── context-engine.ts
├── contracts.ts
├── kernel.ts
├── runtime.ts
├── workflow.ts
└── executors/
    ├── api-call-executor.ts
    └── web-search-executor.ts
```

- `AgentLoop`：未来承载 Agent 的最小决策循环。
- `MinimalWorkflow`：未来承载步骤推进与终止判断。
- `MinimalContextEngine`：未来组装单轮所需上下文。
- `MinimalKernel`：未来只负责组件间消息转发。
- `ApiCallExecutor`：未来封装模型 API 调用。
- `WebSearchExecutor`：未来封装 Web Search 调用。
- `createExperimentRuntime`：组合上述组件的唯一入口。

## 边界

- 不依赖 `apps/*` 或 `packages/*` 中的正式模块。
- 不复用当前 M1 Shared Contracts，避免实验提前继承正式架构假设。
- 在明确最小消息协议和验收场景前，不增加真实实现。
